import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/auth-schema.ts",
  out: "./migrations",
});
