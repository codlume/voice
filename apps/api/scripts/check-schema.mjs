#!/usr/bin/env node
// Regenerates the Better Auth schema and the Drizzle migrations, then fails if
// the committed files would change. Run from apps/api.
import { execFileSync } from "node:child_process";

const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });

run("pnpm", [
  "exec",
  "auth",
  "generate",
  "--config",
  "auth.cli.ts",
  "--output",
  "src/auth-schema.ts",
  "--yes",
]);
// The committed schema is formatted by the pre-commit hook, so format the regenerated one the same way.
run("vp", ["fmt", "src/auth-schema.ts"]);
run("pnpm", ["exec", "drizzle-kit", "generate"]);

const drift = execFileSync(
  "git",
  ["status", "--porcelain", "--untracked-files=all", "--", "src/auth-schema.ts", "migrations"],
  { encoding: "utf8" },
);
if (drift) {
  console.error(`Generated files differ from the committed ones:\n${drift}`);
  process.exit(1);
}
