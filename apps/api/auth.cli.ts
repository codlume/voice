import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { authOptions } from "./src/auth.ts";

// Read only by `auth generate`, which needs no Worker bindings.
export const auth = betterAuth({
  ...authOptions,
  database: drizzleAdapter({}, { provider: "sqlite" }),
});
