import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { electron } from "@better-auth/electron";

// Only for `auth generate`: same plugins and tables, no runtime bindings.
export const auth = betterAuth({
  database: drizzleAdapter({}, { provider: "sqlite" }),
  emailAndPassword: { enabled: false },
  rateLimit: { enabled: true, storage: "database" },
  plugins: [electron()],
});
