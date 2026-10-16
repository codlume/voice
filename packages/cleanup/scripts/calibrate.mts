// The guard runs only in the replay, so rerunning with an existing recording re-checks a changed
// guard without touching the model, and a rerun of the model re-checks a changed model or prompt.
//
//   node packages/cleanup/scripts/calibrate.mts <model.gguf> <recording.jsonl>

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertPlausibleCleanup, wordSurvival } from "../src/plausibility.ts";
import { CONTEXTS, STYLINGS, type S1Control } from "../src/prompt.ts";
import { createS1Mini, type Generation } from "../src/s1mini.ts";

const [modelPath, recordingPath] = process.argv.slice(2);
if (!modelPath || !recordingPath) throw new Error("usage: calibrate.mts <model.gguf> <out.jsonl>");

const here = dirname(fileURLToPath(import.meta.url));

const people = ["maria", "tom", "priya", "lukas", "sofia", "kenji"];
const tasks = [
  "review the pricing page",
  "fix the login bug",
  "draft the release notes",
  "update the onboarding video",
  "check the analytics dashboard",
  "clean up the old feature flags",
  "call the design agency",
];
const days = ["monday", "tuesday", "wednesday", "thursday", "friday"];
const line = (i: number, task: string, day: string) =>
  `${people[i % 6]} will ${task} by ${day} and send a short update to ${people[(i + 1) % 6]} before ${(i % 5) + 1} pm`;
const lines = (count: number) =>
  Array.from({ length: count }, (_, i) => line(i, tasks[i % 7]!, days[i % 5]!)).join(". ");
const generated = {
  varied: `${lines(50)}. and finally call ada on monday.`,
  repetitive: `${Array.from({ length: 50 }, (_, i) => line(i, tasks[0]!, days[0]!)).join(". ")}.`,
  email: `hi team um quick update on the plan for the next two weeks. ${lines(22)}. let me know if any of this does not work for you thanks so much best mateusz`,
};

type Fixture = { name: string } & ({ text: string } | { generate: keyof typeof generated });
type Row = S1Control & { name: string; ms: number; generations: Generation[] };

const fixtures: Fixture[] = JSON.parse(
  readFileSync(join(here, "../fixtures/dictations.json"), "utf8"),
);
const inputOf = (f: Fixture) => ("text" in f ? f.text : generated[f.generate]);

const record = async (): Promise<Row[]> => {
  if (existsSync(recordingPath)) {
    return readFileSync(recordingPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  }
  const s1 = createS1Mini({ modelPath });
  await s1.load();
  const rows: Row[] = [];
  for (const fixture of fixtures) {
    for (const context of CONTEXTS) {
      for (const styling of STYLINGS) {
        const t = performance.now();
        const generations = await s1.generate(inputOf(fixture), { styling, context });
        const ms = Math.round(performance.now() - t);
        console.error(`${fixture.name} ${styling} ${context} ${ms} ms`);
        rows.push({ name: fixture.name, styling, context, ms, generations });
      }
    }
  }
  await s1.dispose();
  writeFileSync(recordingPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return rows;
};

let chunks = 0;
let rejected = 0;
const rows = await record();
for (const { name, styling, context, ms, generations } of rows) {
  for (const [i, { chunk, output, truncated }] of generations.entries()) {
    let verdict = "accept";
    try {
      assertPlausibleCleanup(chunk, output, truncated);
    } catch (e) {
      verdict = `REJECT ${(e as Error).message}`;
      rejected++;
    }
    chunks++;
    const { recall, head, tail } = wordSurvival(chunk, output);
    const scores = [recall, head, tail].map((n) => n.toFixed(2)).join("/");
    const part = generations.length > 1 ? ` ${i + 1}/${generations.length}` : "";
    console.log(
      `${scores}\t${name}${part}\t${styling}\t${context}\t${ms} ms\t${verdict}\n\t${JSON.stringify(output)}`,
    );
  }
}
console.log(`${rows.length} rows, ${chunks} chunks, ${rejected} rejected`);
