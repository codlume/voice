import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: ["./src/schema.ts", "./src/auth-schema.ts"],
  out: "./migrations",
});
