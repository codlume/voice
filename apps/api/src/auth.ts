import { electron } from "@better-auth/electron";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./auth-schema.ts";

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
  return betterAuth({
    ...authOptions,
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    // D1 rejects interactive transactions.
    database: drizzleAdapter(drizzle(env.DB, { schema }), {
      provider: "sqlite",
      schema,
      transaction: false,
    }),
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
