import { electron } from "@better-auth/electron";
import { betterAuth, type BetterAuthOptions, type BetterAuthPlugin } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
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

// Every setting that needs no Worker binding. The schema generator (auth.cli.ts) reads the same
// object, so a plugin or table added here reaches both the runtime and the migration.
export const authOptions = {
  basePath: "/api/auth",
  emailAndPassword: { enabled: false },
  account: { accountLinking: { enabled: false }, encryptOAuthTokens: true },
  // A tray app runs for weeks, so the 7-day default is too short. freshAge gates account deletion.
  session: { expiresIn: 60 * 60 * 24 * 60, freshAge: 60 * 10 },
  // The default reads NODE_ENV, which a Worker does not set, so it would stay off. Better Auth's
  // 3-per-10 s rule for /sign-in* guards password guessing, which is off here. /sign-in/social only
  // writes one OAuth state, the same work as /electron/init-oauth-proxy, which calls it for every
  // desktop sign-in under the default limit, so a fourth sign-in within 10 s turned into a 500.
  rateLimit: {
    enabled: true,
    storage: "database",
    customRules: { "/sign-in/social": { window: 10, max: 100 } },
  },
  advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
  user: { deleteUser: { enabled: true } },
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
  return betterAuth({
    ...authOptions,
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    // D1 rejects interactive transactions.
    database: drizzleAdapter(db, { provider: "sqlite", schema, transaction: false }),
    advanced: { ...authOptions.advanced, backgroundTasks: { handler: waitUntil } },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        prompt: "select_account",
        disableIdTokenSignIn: true,
      },
    },
    // Localhost is trusted only because the local BETTER_AUTH_URL is localhost.
    trustedOrigins: [new URL(env.BETTER_AUTH_URL).origin, "com.codlume.voice:/"],
  });
}
