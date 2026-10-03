#!/usr/bin/env node
// Fails on migrations that rebuild a table or toggle foreign keys. On D1,
// dropping a parent table fires cascades and deletes child rows, and toggling
// foreign keys does not prevent it. A file that needs one anyway carries
// `-- migration-check: approved <reason>`.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const rules = [
  {
    name: "table-rebuild",
    pattern: /\b__new_\w+|\bdrop\s+table\b|\balter\s+table\b[^;]*\brename\s+to\b/i,
  },
  { name: "foreign-key-pragma", pattern: /\bpragma\s+(defer_)?foreign_keys\b/i },
];
const approval = /^--\s*migration-check:\s*approved\b(.*)$/im;

const dir = process.argv[2];
if (!dir) {
  console.error("usage: check-migrations.mjs <migrations-dir>");
  process.exit(2);
}

let violations = 0;
for (const file of readdirSync(dir)
  .filter((name) => name.endsWith(".sql"))
  .toSorted()) {
  const sql = readFileSync(join(dir, file), "utf8");
  const marker = sql.match(approval);
  if (marker) {
    if (marker[1].trim()) continue;
    console.error(`${file}: approval-without-reason`);
    violations++;
    continue;
  }
  for (const rule of rules) {
    if (rule.pattern.test(sql)) {
      console.error(`${file}: ${rule.name}`);
      violations++;
    }
  }
}
process.exit(violations > 0 ? 1 : 0);
