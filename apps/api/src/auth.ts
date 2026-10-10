import { electron } from "@better-auth/electron";
import { betterAuth, type BetterAuthOptions, type BetterAuthPlugin } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import { and, eq, lt, notExists } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./auth-schema.ts";

// check:schema regenerates auth-schema.ts from these options, so an index on a Better Auth table
// is declared here, and a plugin's schema is the only place that takes one for a core table.
const accountLookupIndex = {
  id: "account-lookup-index",
  schema: { account: { fields: {}, indexes: [{ fields: ["providerId", "accountId"] }] } },
} satisfies BetterAuthPlugin;

// D1 has no interactive transactions, so a first sign-in writes the user row and then the account
// row, and a deletion removes the account rows and then the user row. D1 failing in between leaves
// a user row with no account, and with linking off every later Google sign-in for that email ends
// in account_not_linked. Each Google callback first deletes such rows, so the next sign-in starts
// over with a fresh user. The grace period spares a first sign-in still between its writes:
// createdAt is stamped before the user insert, D1 gives up on a statement after 30 s, and the work
// between the two inserts takes milliseconds. A sweep that did catch one would only make that
// attempt's account insert fail its foreign key, and the retry starts over. The sweep scans the
// user table once per callback; at a much larger user count, move it to a Cron Trigger.
const userWithoutAccountGraceMs = 60_000;

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
  // The default reads NODE_ENV, which a Worker does not set, so it would stay off.
  rateLimit: { enabled: true, storage: "database" },
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

export function createAuth(env: Env) {
  const db = drizzle(env.DB, { schema });
  const sweepUsersWithoutAccount = () =>
    db
      .delete(schema.user)
      .where(
        and(
          lt(schema.user.createdAt, new Date(Date.now() - userWithoutAccountGraceMs)),
          notExists(
            db.select().from(schema.account).where(eq(schema.account.userId, schema.user.id)),
          ),
        ),
      );
  return betterAuth({
    ...authOptions,
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    // D1 rejects interactive transactions.
    database: drizzleAdapter(db, { provider: "sqlite", schema, transaction: false }),
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/callback/:id") return;
        // A failed sweep leaves the lockout for the next callback to clear; the sign-in goes on.
        await sweepUsersWithoutAccount().catch(() =>
          console.error(JSON.stringify({ source: "user-sweep", level: "error" })),
        );
      }),
    },
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
