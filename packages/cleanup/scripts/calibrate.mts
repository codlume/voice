// Runs the synthetic dictation fixtures through the real S1-mini model once, records what the
// model returned for every chunk as JSONL, and replays the plausibility guard over the recording.
// The guard runs only in the replay, so rerunning with an existing recording re-checks a changed
// guard without touching the model, and a rerun of the model re-checks a changed model or prompt.
//
//   node packages/cleanup/scripts/calibrate.mts <model.gguf> <recording.jsonl>

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertPlausibleCleanup, wordSurvival } from "../src/plausibility.ts";
import type { CleanupStyle } from "../src/prompt.ts";
import { createS1Mini, type Generation } from "../src/s1mini.ts";

const STYLES: CleanupStyle["styling"][] = ["casual", "semi-casual", "semi-formal", "formal"];
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
const generated = {
  varied: `${Array.from({ length: 50 }, (_, i) => line(i, tasks[i % 7]!, days[i % 5]!)).join(". ")}. and finally call ada on monday.`,
  repetitive: `${Array.from({ length: 50 }, (_, i) => line(i, tasks[0]!, days[0]!)).join(". ")}.`,
};

type Fixture = { name: string } & ({ text: string } | { generate: keyof typeof generated });
type Row = Generation & { name: string; styling: CleanupStyle["styling"] };

const fixtures: Fixture[] = JSON.parse(
  readFileSync(join(here, "../fixtures/dictations.json"), "utf8"),
);
const inputOf = (f: Fixture) => ("text" in f ? f.text : generated[f.generate]);

async function record(): Promise<Row[]> {
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
    for (const styling of STYLES) {
      const t = performance.now();
      const generations = await s1.generate(inputOf(fixture), { styling });
      console.error(`${fixture.name} ${styling} ${Math.round(performance.now() - t)} ms`);
      for (const generation of generations)
        rows.push({ name: fixture.name, styling, ...generation });
    }
  }
  await s1.dispose();
  writeFileSync(recordingPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return rows;
}

let rejected = 0;
const rows = await record();
for (const { name, styling, chunk, output, truncated } of rows) {
  let verdict = "accept";
  try {
    assertPlausibleCleanup(chunk, output, truncated);
  } catch (e) {
    verdict = `REJECT ${(e as Error).message}`;
    rejected++;
  }
  const { recall, head, tail } = wordSurvival(chunk, output);
  const scores = [recall, head, tail].map((n) => n.toFixed(2)).join("/");
  console.log(`${scores}\t${name}\t${styling}\t${verdict}\n\t${JSON.stringify(output)}`);
}
console.log(`${rows.length} rows, ${rejected} rejected`);
