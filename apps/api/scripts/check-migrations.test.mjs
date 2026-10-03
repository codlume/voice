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
  { fixture: "table-rebuild", status: 1, rules: ["table-rebuild"] },
  { fixture: "drop-table", status: 1, rules: ["table-rebuild"] },
  { fixture: "rename-table", status: 1, rules: ["table-rebuild"] },
  { fixture: "foreign-key-pragma", status: 1, rules: ["foreign-key-pragma"] },
  { fixture: "defer-foreign-keys", status: 1, rules: ["foreign-key-pragma"] },
  { fixture: "approved-rebuild", status: 0, rules: [] },
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
