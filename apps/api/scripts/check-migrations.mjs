#!/usr/bin/env node
// Fails on migrations that drop, rename or rebuild a table, drop a column, or set a
// foreign-key or legacy_alter_table pragma. On D1, dropping a parent table fires
// cascades and deletes child rows, and toggling foreign keys does not prevent it.
// The check applies the migrations to an in-memory SQLite database and compares the
// schema before and after each file, so quoting and comments cannot hide a change.
// A file that needs one anyway starts with `-- migration-check: approved <reason>`.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, constants } from "node:sqlite";

const unsafePragmas = new Map([
  ["foreign_keys", "foreign-key-pragma"],
  ["defer_foreign_keys", "foreign-key-pragma"],
  ["legacy_alter_table", "legacy-alter-table-pragma"],
]);
const approvalPrefix = "-- migration-check: approved";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: check-migrations.mjs <migrations-dir>");
  process.exit(2);
}

const db = new DatabaseSync(":memory:");
const pragmaRules = new Set();
// SQLite hands the authorizer the parsed, unquoted pragma name.
db.setAuthorizer((action, name) => {
  const rule = action === constants.SQLITE_PRAGMA && unsafePragmas.get(name?.toLowerCase());
  if (rule) pragmaRules.add(rule);
  return constants.SQLITE_OK;
});

function schema() {
  const tables = db
    .prepare(
      "SELECT name, rootpage FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  return new Map(
    tables.map(({ name, rootpage }) => [
      name,
      {
        rootpage,
        columns: db
          .prepare("SELECT name FROM pragma_table_info(?)")
          .all(name)
          .map((column) => column.name),
      },
    ]),
  );
}

function violations(before, after) {
  const rules = new Set(pragmaRules);
  for (const [name, table] of before) {
    const next = after.get(name);
    if (!next || next.rootpage !== table.rootpage) rules.add("table-rebuild");
    else if (table.columns.some((column) => !next.columns.includes(column)))
      rules.add("column-drop");
  }
  return rules;
}

let failures = 0;
for (const file of readdirSync(dir)
  .filter((name) => name.endsWith(".sql"))
  .toSorted()) {
  const sql = readFileSync(join(dir, file), "utf8");
  const firstLine = sql.split("\n", 1)[0].trim();
  const approved = firstLine.startsWith(approvalPrefix);
  const before = schema();
  pragmaRules.clear();
  let rules;
  try {
    db.exec(sql);
    rules = violations(before, schema());
  } catch (error) {
    console.error(`${file}: sql-error\n  ${error.message}`);
    failures++;
    continue;
  }
  if (approved) {
    rules = firstLine.slice(approvalPrefix.length).trim()
      ? new Set()
      : new Set(["approval-without-reason"]);
  }
  for (const rule of rules) console.error(`${file}: ${rule}`);
  failures += rules.size;
}
process.exit(failures > 0 ? 1 : 0);
