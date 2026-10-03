import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("check-migrations.mjs", import.meta.url));

function check(fixture) {
  const dir = fileURLToPath(new URL(`fixtures/${fixture}`, import.meta.url));
  const result = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
  return { status: result.status, output: result.stderr };
}

const cases = [
  { fixture: "additive", status: 0, rules: [] },
  { fixture: "keywords-in-comments-and-strings", status: 0, rules: [] },
  { fixture: "approved-rebuild", status: 0, rules: [] },
  { fixture: "table-rebuild", status: 1, rules: ["table-rebuild"] },
  { fixture: "commented-rebuild", status: 1, rules: ["table-rebuild"] },
  { fixture: "drop-table", status: 1, rules: ["table-rebuild"] },
  { fixture: "drop-table-if-exists", status: 1, rules: ["table-rebuild"] },
  { fixture: "rename-table", status: 1, rules: ["table-rebuild"] },
  { fixture: "drop-column", status: 1, rules: ["column-drop"] },
  { fixture: "foreign-key-pragma", status: 1, rules: ["foreign-key-pragma"] },
  { fixture: "defer-foreign-keys", status: 1, rules: ["foreign-key-pragma"] },
  { fixture: "schema-foreign-key-pragma", status: 1, rules: ["foreign-key-pragma"] },
  { fixture: "quoted-defer-foreign-keys", status: 1, rules: ["foreign-key-pragma"] },
  { fixture: "bracket-foreign-keys", status: 1, rules: ["foreign-key-pragma"] },
  { fixture: "bracket-schema-foreign-keys", status: 1, rules: ["foreign-key-pragma"] },
  { fixture: "single-quoted-foreign-keys", status: 1, rules: ["foreign-key-pragma"] },
  { fixture: "spaced-schema-foreign-keys", status: 1, rules: ["sql-error"] },
  { fixture: "legacy-alter-table", status: 1, rules: ["legacy-alter-table-pragma"] },
  { fixture: "approval-inside-string", status: 1, rules: ["table-rebuild"] },
  { fixture: "approval-without-reason", status: 1, rules: ["approval-without-reason"] },
];

for (const { fixture, status, rules } of cases) {
  test(`${fixture} exits ${status}${rules.length ? ` naming ${rules.join(", ")}` : ""}`, () => {
    const result = check(fixture);
    assert.equal(result.status, status, result.output);
    const named = [...result.output.matchAll(/^\S+\.sql: (\S+)$/gm)].map((match) => match[1]);
    assert.deepEqual(named, rules);
  });
}
