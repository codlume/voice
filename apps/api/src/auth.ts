import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { electron } from "@better-auth/electron";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/auth-schema";

export type Env = {
  DB: D1Database;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
};

export const createAuth = (env: Env) =>
  betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(drizzle(env.DB, { schema }), {
      provider: "sqlite",
      schema,
      transaction: false,
    }),
    emailAndPassword: { enabled: false },
    account: { accountLinking: { enabled: false }, encryptOAuthTokens: true },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        prompt: "select_account",
        disableIdTokenSignIn: true,
      },
    },
    trustedOrigins: [env.BETTER_AUTH_URL, "com.codlume.voice:/"],
    session: { expiresIn: 60 * 60 * 24 * 60, freshAge: 60 * 10 },
    rateLimit: { enabled: true, storage: "database" },
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    plugins: [electron()],
  });
