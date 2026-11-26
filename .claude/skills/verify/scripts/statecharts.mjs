// Checks every statechart model against its doc. Each rule in <flow>.cfg needs one line in
// <flow>.md, "- `Rule` holds" or "- `Rule` breaks", and TLC must agree with it.
// Usage: node statecharts.mjs [--dir <statecharts dir>]
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const JAR_URL = "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar";
const JAR_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
const KEYWORD =
  /^(SPECIFICATION|INIT|NEXT|CONSTANTS?|INVARIANTS?|PROPERTY|PROPERTIES|CONSTRAINTS?|ACTION_CONSTRAINTS?|SYMMETRY|VIEW|ALIAS|CHECK_DEADLOCK|POSTCONDITION)$/;

const RULE_KIND = {
  INVARIANT: "INVARIANT",
  INVARIANTS: "INVARIANT",
  PROPERTY: "PROPERTY",
  PROPERTIES: "PROPERTY",
};

const { values } = parseArgs({
  options: { dir: { type: "string", default: join(import.meta.dirname, "../statecharts") } },
});
const dir = values.dir;
const java = process.env.JAVA || "java";

function fail(message) {
  console.error(`statecharts: ${message}`);
  process.exit(1);
}

function parseCfg(text) {
  const header = [];
  const rules = [];
  let kind;
  for (const line of text.replace(/\\\*.*$/gm, "").split("\n")) {
    const words = line.trim().split(/\s+/).filter(Boolean);
    if (KEYWORD.test(words[0] ?? "")) kind = RULE_KIND[words[0]];
    if (!kind) header.push(line);
    else for (const name of words.filter((w) => !KEYWORD.test(w))) rules.push({ kind, name });
  }
  return { header: header.join("\n"), rules };
}

function parseDoc(text) {
  return text.split("\n").flatMap((line) => {
    const match = /^- `(\w+)` (holds|breaks)\b/.exec(line);
    return match ? [{ name: match[1], says: match[2] }] : [];
  });
}

function docSays(doc, name) {
  if (!name) return "no deadlock";
  const lines = doc.filter((line) => line.name === name);
  if (lines.length > 1) return "2+ lines";
  return lines[0]?.says ?? "no line";
}

async function tla2tools() {
  if (process.env.TLA2TOOLS) return process.env.TLA2TOOLS;
  const cache = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "voice");
  const jar = join(cache, "tla2tools-1.7.4.jar");
  if (existsSync(jar)) return jar;
  const response = await fetch(JAR_URL);
  if (!response.ok) fail(`downloading ${JAR_URL} failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== JAR_SHA256)
    fail(`${JAR_URL} has SHA-256 ${sha}, expected ${JAR_SHA256}. Refusing it.`);
  mkdirSync(cache, { recursive: true });
  // Written under a temporary name first, so a killed download never leaves a jar to trust.
  const partial = `${jar}.${process.pid}.part`;
  writeFileSync(partial, bytes);
  renameSync(partial, jar);
  return jar;
}

function tlc(jar, work, { flow, name, cfg }) {
  const run = join(work, `${flow}-${name ?? "deadlock"}`);
  mkdirSync(run);
  writeFileSync(join(run, "run.cfg"), `${cfg}\n`);
  const args = ["-XX:+UseParallelGC", "-cp", jar, "tlc2.TLC", "-workers", "1", "-fp", "0"];
  args.push("-lncheck", "final", "-cleanup", "-metadir", join(run, "meta"));
  if (name) args.push("-deadlock");
  args.push("-config", join(run, "run.cfg"), `${flow}.tla`);
  return new Promise((resolve) => {
    const child = spawn(java, args, { cwd: dir });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => resolve({ code: -1, output: String(error) }));
    child.on("close", (code) => resolve({ code, output }));
  });
}

function verdict({ kind, name }, { code, output }) {
  if (code === 0) return name ? "holds" : "no deadlock";
  if (!name) return /Error: Deadlock reached/.test(output) ? "deadlock" : "error";
  if (kind === "INVARIANT" && output.includes(`Error: Invariant ${name} is violated`))
    return "breaks";
  if (kind === "PROPERTY" && output.includes("Error: Temporal properties were violated"))
    return "breaks";
  return "error";
}

async function inParallel(tasks, limit) {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

const started = performance.now();
const flows = readdirSync(dir)
  .filter((file) => file.endsWith(".cfg"))
  .map((file) => file.slice(0, -4))
  .filter((flow) => existsSync(join(dir, `${flow}.tla`)) && existsSync(join(dir, `${flow}.md`)))
  .toSorted();
if (flows.length === 0) fail(`no <flow>.cfg with a matching .tla and .md in ${dir}`);

const probe = spawnSync(java, ["-version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
  fail(
    `TLC needs Java 11+, and "${java}" does not run. Install a JDK (mise use java@temurin-21, or brew install --cask temurin), or set JAVA to a java binary.`,
  );
}
const jar = await tla2tools();

// TLC stops at the first broken rule in a state, so a run that checks several rules hides the
// others' breaks. Each rule gets its own run, with the deadlock check off. One more run per flow
// checks only for deadlock, because a rule run that stops on a violation may never reach one.
const runs = flows.flatMap((flow) => {
  const { header, rules } = parseCfg(readFileSync(join(dir, `${flow}.cfg`), "utf8"));
  return [
    { flow, cfg: header },
    ...rules.map(({ kind, name }) => ({ flow, kind, name, cfg: `${header}\n${kind} ${name}` })),
  ];
});
const work = mkdtempSync(join(tmpdir(), "statecharts-"));
let checked;
try {
  const tasks = runs.map((run) => async () => ({ run, result: await tlc(jar, work, run) }));
  checked = await inParallel(tasks, availableParallelism());
} finally {
  rmSync(work, { recursive: true, force: true });
}

const rows = [["flow", "rule", "doc says", "TLC says", ""]];
const failures = [];
for (const flow of flows) {
  const doc = parseDoc(readFileSync(join(dir, `${flow}.md`), "utf8"));
  for (const { run, result } of checked.filter((entry) => entry.run.flow === flow)) {
    const tlcSays = verdict(run, result);
    const says = docSays(doc, run.name);
    const ok = says === tlcSays;
    rows.push([flow, run.name ?? "(deadlock check)", says, tlcSays, ok ? "ok" : "MISMATCH"]);
    if (!ok) failures.push({ label: `${flow} ${run.name ?? "deadlock check"}`, ...result });
  }
  for (const { name, says } of doc) {
    if (!runs.some((other) => other.flow === flow && other.name === name)) {
      rows.push([flow, name, says, "not in cfg", "MISMATCH"]);
    }
  }
}

const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
for (const row of rows)
  console.log(
    row
      .map((cell, i) => cell.padEnd(widths[i]))
      .join("  ")
      .trimEnd(),
  );
for (const { label, output } of failures)
  console.log(`\n--- TLC output for ${label} ---\n${output.trimEnd()}`);

const seconds = ((performance.now() - started) / 1000).toFixed(1);
const mismatches = rows.filter((row) => row[4] === "MISMATCH").length;
console.log(
  `\n${runs.length} TLC runs over ${flows.length} flows in ${seconds} s: ${mismatches ? `${mismatches} MISMATCH` : "all match"}`,
);
process.exit(mismatches ? 1 : 0);
