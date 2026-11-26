import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const script = join(import.meta.dirname, "statecharts.mjs");
const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// A counter that flips between 0 and 1 forever. Small and Flips hold, Zero and Stuck break.
const counter = `---- MODULE counter ----
EXTENDS Naturals
VARIABLE x
Init == x = 0
Next == x' = 1 - x
Spec == Init /\\ [][Next]_x /\\ WF_x(Next)
Small == x \\in {0, 1}
Zero == x = 0
Flips == []<>(x = 1)
Stuck == <>[](x = 0)
====
`;
const counterCfg = `SPECIFICATION Spec
INVARIANTS
  Small
  Zero
PROPERTIES
  Flips
  Stuck
`;
const counterDoc = {
  Small: "holds",
  Zero: "breaks",
  Flips: "holds",
  Stuck: "breaks",
};

function check({ tla = counter, cfg = counterCfg, doc = counterDoc }) {
  const dir = mkdtempSync(join(tmpdir(), "statecharts-test-"));
  dirs.push(dir);
  writeFileSync(join(dir, "counter.tla"), tla);
  writeFileSync(join(dir, "counter.cfg"), cfg);
  const lines = Object.entries(doc).map(([rule, says]) => `- \`${rule}\` ${says}. Some words.`);
  writeFileSync(join(dir, "counter.md"), `# Counter\n\n${lines.join("\n")}\n`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, "--dir", dir]);
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => resolve({ code, output }));
  });
}

const row = (rule) => (output) => output.split("\n").find((line) => line.includes(` ${rule} `));

describe("statecharts", { concurrency: true }, () => {
  it("passes when every rule matches its doc line, breaks included", async () => {
    const { code, output } = await check({});
    assert.equal(code, 0, output);
  });

  it("fails with the trace when the doc says holds but TLC breaks the rule", async () => {
    const { code, output } = await check({ doc: { ...counterDoc, Zero: "holds" } });
    assert.equal(code, 1, output);
    assert.match(row("Zero")(output), /MISMATCH/);
    assert.match(output, /Invariant Zero is violated/);
    assert.match(output, /State 2:/);
  });

  it("fails when the doc says breaks but the rule holds", async () => {
    const { code, output } = await check({ doc: { ...counterDoc, Flips: "breaks" } });
    assert.equal(code, 1, output);
    assert.match(row("Flips")(output), /MISMATCH/);
  });

  it("fails on a cfg rule with no doc line", async () => {
    const doc = { ...counterDoc };
    delete doc.Stuck;
    const { code, output } = await check({ doc });
    assert.equal(code, 1, output);
    assert.match(row("Stuck")(output), /MISMATCH/);
  });

  it("fails on a model that deadlocks", async () => {
    const tla = counter.replace("Next == x' = 1 - x", "Next == x = 0 /\\ x' = 1");
    const cfg = "SPECIFICATION Spec\nINVARIANT Small\n";
    const { code, output } = await check({ tla, cfg, doc: { Small: "holds" } });
    assert.equal(code, 1, output);
    assert.match(output, /Deadlock reached/);
  });
});
