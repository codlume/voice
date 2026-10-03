#!/usr/bin/env node
// Fails on migrations that can lose rows or weaken foreign keys: dropping, renaming or
// rebuilding a table, dropping or renaming a column, dropping an index, view or
// trigger, and foreign-key or legacy_alter_table pragmas. On D1, dropping a parent
// table fires cascades and deletes child rows, and toggling foreign keys does not
// prevent it. The check applies the migrations to an in-memory SQLite database and
// judges each file by what SQLite reports and by the schema before and after, so
// quoting and comments cannot hide a change. A file that needs one anyway starts with
// `-- migration-check: approved <reason>`.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, constants } from "node:sqlite";

const unsafePragmas = new Map([
  ["foreign_keys", "foreign-key-pragma"],
  ["defer_foreign_keys", "foreign-key-pragma"],
  ["legacy_alter_table", "legacy-alter-table-pragma"],
]);
const drops = new Map([
  [constants.SQLITE_DROP_TABLE, ["table", "table-rebuild"]],
  [constants.SQLITE_DROP_TEMP_TABLE, ["table", "table-rebuild"]],
  [constants.SQLITE_DROP_INDEX, ["index", "object-drop"]],
  [constants.SQLITE_DROP_TEMP_INDEX, ["index", "object-drop"]],
  [constants.SQLITE_DROP_VIEW, ["view", "object-drop"]],
  [constants.SQLITE_DROP_TEMP_VIEW, ["view", "object-drop"]],
  [constants.SQLITE_DROP_TRIGGER, ["trigger", "object-drop"]],
  [constants.SQLITE_DROP_TEMP_TRIGGER, ["trigger", "object-drop"]],
]);
const approvalMarker = /^-- migration-check: approved(?:\s+(.*))?$/;

const dir = process.argv[2];
if (!dir) {
  console.error("usage: check-migrations.mjs <migrations-dir>");
  process.exit(2);
}

// D1 accepts double-quoted string literals, so the check does too.
const db = new DatabaseSync(":memory:", { enableDoubleQuotedStringLiterals: true });

function schema() {
  const objects = db
    .prepare(
      `SELECT type, name, rootpage FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'
       UNION ALL SELECT type, name, rootpage FROM sqlite_temp_schema WHERE name NOT GLOB 'sqlite_*'`,
    )
    .all();
  const tables = new Map();
  for (const { name, rootpage } of objects.filter((object) => object.type === "table")) {
    const columns = db
      .prepare("SELECT name, cid, type FROM pragma_table_xinfo(?)")
      .all(name)
      .map((column) => `${column.cid}:${column.name}:${column.type}`);
    tables.set(name, { rootpage, columns });
  }
  return { objects: new Set(objects.map(({ type, name }) => `${type}:${name}`)), tables };
}

let before = schema();
let reported = new Set();
let collecting = false;
// SQLite reports each pragma and drop to the authorizer already parsed and unquoted.
db.setAuthorizer((action, arg1, arg2, arg3) => {
  if (!collecting) return constants.SQLITE_OK;
  const pragma = action === constants.SQLITE_PRAGMA && unsafePragmas.get(arg1?.toLowerCase());
  if (pragma) reported.add(pragma);
  const drop = drops.get(action);
  if (drop && before.objects.has(`${drop[0]}:${arg1}`)) reported.add(drop[1]);
  // For ALTER TABLE, SQLite passes the column name only for DROP COLUMN.
  if (action === constants.SQLITE_ALTER_TABLE && arg3 && before.tables.has(arg2)) {
    reported.add("column-drop");
  }
  return constants.SQLITE_OK;
});

function schemaChanges(after) {
  const rules = new Set();
  for (const [name, table] of before.tables) {
    const next = after.tables.get(name);
    if (!next || next.rootpage !== table.rootpage) rules.add("table-rebuild");
    else if (table.columns.some((column) => !next.columns.includes(column))) {
      rules.add("column-drop");
    }
  }
  return rules;
}

let failures = 0;
for (const file of readdirSync(dir)
  .filter((name) => name.endsWith(".sql"))
  .toSorted()) {
  const sql = readFileSync(join(dir, file), "utf8");
  const approval = approvalMarker.exec(sql.split("\n", 1)[0].trimEnd());
  before = schema();
  reported = new Set();
  let rules;
  try {
    collecting = true;
    db.exec(sql);
    collecting = false;
    rules = new Set([...reported, ...schemaChanges(schema())]);
  } catch (error) {
    collecting = false;
    console.error(`${file}: sql-error\n  ${error.message}`);
    failures++;
    continue;
  }
  if (approval) rules = approval[1]?.trim() ? new Set() : new Set(["approval-without-reason"]);
  for (const rule of rules) console.error(`${file}: ${rule}`);
  failures += rules.size;
}
process.exit(failures > 0 ? 1 : 0);
