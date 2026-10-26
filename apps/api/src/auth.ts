import { electron } from "@better-auth/electron";
import { betterAuth, type BetterAuthOptions, type BetterAuthPlugin } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { parseSetCookieHeader, toCookieOptions } from "better-auth/cookies";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./auth-schema.ts";

// check:schema regenerates auth-schema.ts from these options, so an index on a Better Auth table
// is declared here, and a plugin's schema is the only place that takes one for a core table.
const accountLookupIndex = {
  id: "account-lookup-index",
  schema: { account: { fields: {}, indexes: [{ fields: ["providerId", "accountId"] }] } },
} satisfies BetterAuthPlugin;

// encryptOAuthTokens leaves Google's ID token in plain text, and Voice never reads it. Better Auth
// merges a hook's data over its own, so the token is overwritten with null, not omitted.
const dropIdToken = async () => ({ data: { idToken: null } });

const NAME_MAX_LENGTH = 100;

type PersonName = { firstName: string; lastName: string };

function splitName(name: string): PersonName {
  const trimmed = name.trim();
  const space = trimmed.indexOf(" ");
  return space === -1
    ? { firstName: trimmed, lastName: "" }
    : { firstName: trimmed.slice(0, space), lastName: trimmed.slice(space + 1).trim() };
}

// Better Auth requires its own `name` column, so it holds the full name derived from the two
// fields Voice edits. Only the server writes it.
const fullName = ({ firstName, lastName }: PersonName) =>
  [firstName, lastName].filter(Boolean).join(" ");

function nameUpdate(body: unknown) {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new APIError("BAD_REQUEST", { message: "The body must be an object" });
  if (Object.keys(body).some((key) => key !== "firstName" && key !== "lastName"))
    throw new APIError("BAD_REQUEST", { message: "Only firstName and lastName can be updated" });
  if (
    !("firstName" in body && typeof body.firstName === "string") ||
    !("lastName" in body && typeof body.lastName === "string")
  )
    throw new APIError("BAD_REQUEST", { message: "firstName and lastName must be strings" });
  const name = { firstName: body.firstName.trim(), lastName: body.lastName.trim() };
  if (!name.firstName) throw new APIError("BAD_REQUEST", { message: "firstName is required" });
  if (name.firstName.length > NAME_MAX_LENGTH || name.lastName.length > NAME_MAX_LENGTH)
    throw new APIError("BAD_REQUEST", {
      message: `A name can be at most ${NAME_MAX_LENGTH} characters`,
    });
  return { ...name, name: fullName(name) };
}

// Every setting that needs no Worker binding. The schema generator (auth.cli.ts) reads the same
// object, so a plugin or table added here reaches both the runtime and the migration.
export const authOptions = {
  basePath: "/api/auth",
  emailAndPassword: { enabled: false },
  account: { accountLinking: { enabled: false }, encryptOAuthTokens: true },
  // A tray app runs for weeks, so the 7-day default is too short. freshAge gates account deletion.
  session: { expiresIn: 60 * 60 * 24 * 60, freshAge: 60 * 10 },
  // The default reads NODE_ENV, which a Worker does not set, so it would stay off.
  rateLimit: { enabled: true, storage: "database" },
  advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
  user: {
    deleteUser: { enabled: true },
    additionalFields: {
      firstName: { type: "string", required: true, defaultValue: "" },
      lastName: { type: "string", required: true, defaultValue: "" },
    },
  },
  // Better Auth's own messages quote request data (the OAuth state, callback errors). Only the
  // level leaves the Worker, next to the request-id line the error handler writes.
  logger: {
    log: (level: string) => console.log(JSON.stringify({ source: "better-auth", level })),
  },
  plugins: [electron(), accountLookupIndex],
  // No client uses it, and Google's getUserInfo returns null without the ID token, so it could
  // only fail. A meeting integration that needs a profile lookup should re-enable it with a
  // getUserInfo that reads the access token.
  disabledPaths: ["/account-info"],
  databaseHooks: {
    account: { create: { before: dropIdToken }, update: { before: dropIdToken } },
  },
} satisfies BetterAuthOptions;

export function createAuth(env: Env, waitUntil: (task: Promise<unknown>) => void) {
  const db = drizzle(env.DB, { schema });
  const auth = betterAuth({
    ...authOptions,
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    // D1 rejects interactive transactions.
    database: drizzleAdapter(db, { provider: "sqlite", schema, transaction: false }),
    // A callback Google refused or a stale state otherwise lands on Better Auth's own error page,
    // which is for developers and which the API's CSP leaves unstyled.
    onAPIError: { errorURL: new URL("/", env.BETTER_AUTH_URL).href },
    advanced: { ...authOptions.advanced, backgroundTasks: { handler: waitUntil } },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Better Auth's update-user writes any user field in the body, `image` and `name` included.
        // Only the two name fields pass, and the merged context hands the handler the derived name.
        if (ctx.path === "/update-user") return { context: { body: nameUpdate(ctx.body) } };
        // @better-auth/electron starts a sign-in by fetching the Worker's own /sign-in/social. In
        // production that request re-enters through Cloudflare stamped with one Worker-side
        // address, so every user's sign-in start shared a single rate-limit bucket. Starting it in
        // process leaves the per-IP limit on this route as the only gate.
        if (ctx.path === "/electron/init-oauth-proxy") {
          const { provider, state, code_challenge } = ctx.query ?? {};
          if (![provider, state, code_challenge].every((v) => typeof v === "string" && v))
            throw new APIError("BAD_REQUEST", {
              message: "provider, state and code_challenge are required",
            });
          const { headers, response } = await auth.api.signInSocial({
            body: { provider },
            query: { client_id: "electron", state, code_challenge },
            returnHeaders: true,
          });
          if (!response.url) throw new APIError("INTERNAL_SERVER_ERROR");
          for (const line of headers.getSetCookie())
            for (const [name, attributes] of parseSetCookieHeader(line))
              ctx.setCookie(
                name,
                attributes.value,
                toCookieOptions(attributes) as Parameters<typeof ctx.setCookie>[2],
              );
          throw ctx.redirect(response.url);
        }
      }),
    },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        prompt: "select_account",
        disableIdTokenSignIn: true,
        // Runs at sign-up only: overrideUserInfoOnSignIn stays off, so a name the user edited
        // survives the next sign-in.
        mapProfileToUser: (profile) => {
          const name = profile.given_name?.trim()
            ? { firstName: profile.given_name.trim(), lastName: profile.family_name?.trim() ?? "" }
            : splitName(profile.name ?? "");
          return { ...name, name: fullName(name) };
        },
      },
    },
    // Localhost is trusted only because the local BETTER_AUTH_URL is localhost.
    trustedOrigins: [new URL(env.BETTER_AUTH_URL).origin, "com.codlume.voice:/"],
  });
  return auth;
}
