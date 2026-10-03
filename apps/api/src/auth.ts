import { electron } from "@better-auth/electron";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import { and, eq, lt, notExists, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./auth-schema.ts";

// D1 has no interactive transactions, so a first sign-in writes the user row and then the account
// row, and a deletion removes the account rows and then the user row. D1 failing in between leaves
// a user row with no account, and with linking off every later Google sign-in for that email ends
// in account_not_linked. Each Google callback first deletes such rows, so the next sign-in starts
// over with a fresh user. The grace period keeps a first sign-in in flight, between its two
// writes, safe: a request lives for seconds, and a D1 statement gives up after 30 s.
const userWithoutAccountGraceMs = 60_000;

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
  plugins: [electron()],
} satisfies BetterAuthOptions;

export function createAuth(env: Env) {
  const db = drizzle(env.DB, { schema });
  const sweepUsersWithoutAccount = () =>
    db.delete(schema.user).where(
      and(
        lt(schema.user.createdAt, new Date(Date.now() - userWithoutAccountGraceMs)),
        notExists(
          db
            .select({ one: sql`1` })
            .from(schema.account)
            .where(eq(schema.account.userId, schema.user.id)),
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
