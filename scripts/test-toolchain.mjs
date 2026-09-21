import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const directory = await mkdtemp(resolve("packages/ui/.toolchain-"));
function check(args, expected, diagnostics = []) {
  const result = spawnSync("pnpm", ["exec", ...args], { encoding: "utf8" });
  const output = result.stdout + result.stderr;
  assert.equal(result.status === 0, expected, `${args.join(" ")}\n${output}`);
  for (const diagnostic of diagnostics)
    assert.ok(output.includes(diagnostic), `Missing ${diagnostic}\n${output}`);
}
try {
  const style = `${directory}/styles.tsx`;
  await writeFile(
    style,
    `import * as stylex from '@stylexjs/stylex';\nconst styles = stylex.create({ root: { color: 'red' } });\nexport const element = <div {...stylex.props(styles.root)} />;\n`,
  );
  check(["vp", "lint", style], true);
  await writeFile(
    style,
    `import * as stylex from '@stylexjs/stylex';\nconst styles = stylex.create({ root: { notAProperty: 'red', padding: '2px 4px' }, unused: { color: 'blue' } });\nexport const element = <div {...stylex.props(styles.root)} />;\n`,
  );
  check(["vp", "lint", style], false, [
    "stylex(valid-styles)",
    "stylex(valid-shorthands)",
    "stylex(no-unused)",
  ]);
  await writeFile(
    `${directory}/tsconfig.json`,
    JSON.stringify({ extends: "../../../tsconfig.base.json", include: ["types.ts"] }),
  );
  await writeFile(`${directory}/types.ts`, "export const count: number = 4;\n");
  check(["tsc", "--noEmit", "-p", directory], true);
  await writeFile(
    `${directory}/types.ts`,
    'export const count: number = "wrong";\nexport const first: string = ["word"][2];\nexport function identity(value) { return value; }\n',
  );
  check(["tsc", "--noEmit", "-p", directory], false, ["TS2322", "TS7006", "undefined"]);
  const formatting = `${directory}/format.ts`;
  await writeFile(formatting, 'export const data={first:"one",second:[1,2,3]}');
  check(["vp", "fmt", "--check", formatting], false);
  check(["vp", "fmt", formatting], true);
  check(["vp", "fmt", "--check", formatting], true);
  console.log(
    "Toolchain passed: valid inputs, three StyleX rules, strict types and Oxfmt diagnostics.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
