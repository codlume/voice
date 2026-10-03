import { electron } from "@better-auth/electron";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

// Read only by `auth generate` so it emits the electron and rate_limit tables.
// Every security-relevant setting lives in src/auth.ts.
export const auth = betterAuth({
  database: drizzleAdapter({}, { provider: "sqlite" }),
  rateLimit: { enabled: true, storage: "database" },
  plugins: [electron()],
});
