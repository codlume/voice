// Runs the synthetic dictation fixtures through the real S1-mini model once, records every
// (input, style, output) pair as JSONL, and replays the plausibility guard over the recording.
// Rerun with an existing recording to re-check the guard without touching the model.
//
//   node packages/cleanup/scripts/calibrate.mts <model.gguf> <recording.jsonl>

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CleanupStyle } from "../src/prompt.ts";
import { assertPlausibleCleanup, createS1Mini } from "../src/s1mini.ts";

type Fixture = { name: string; text?: string; generate?: "varied" | "repetitive" };
type Recording = { name: string; styling: CleanupStyle["styling"]; input: string; output: string };

const STYLES: CleanupStyle["styling"][] = ["casual", "semi-casual", "semi-formal", "formal"];
const [modelPath, recordingPath] = process.argv.slice(2);
if (!modelPath || !recordingPath) throw new Error("usage: calibrate.mts <model.gguf> <out.jsonl>");

const here = dirname(fileURLToPath(import.meta.url));
const fixtures: Fixture[] = JSON.parse(
  readFileSync(join(here, "../fixtures/dictations.json"), "utf8"),
);

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
const inputOf = (f: Fixture) => f.text ?? generated[f.generate!];

async function record(): Promise<Recording[]> {
  if (existsSync(recordingPath)) {
    return readFileSync(recordingPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  }
  const s1 = createS1Mini({ modelPath });
  await s1.load();
  const rows: Recording[] = [];
  for (const fixture of fixtures) {
    for (const styling of STYLES) {
      const input = inputOf(fixture);
      const t = performance.now();
      const output = await s1.clean(input, { styling }).catch((e: Error) => `THROW ${e.message}`);
      console.error(`${fixture.name} ${styling} ${Math.round(performance.now() - t)} ms`);
      rows.push({ name: fixture.name, styling, input, output });
    }
  }
  await s1.dispose();
  writeFileSync(recordingPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return rows;
}

const rows = await record();
for (const { name, styling, input, output } of rows) {
  if (output.startsWith("THROW ")) continue;
  let verdict = "accept";
  try {
    assertPlausibleCleanup(input, output, false);
  } catch (e) {
    verdict = `REJECT ${(e as Error).message}`;
  }
  console.log(`${name}\t${styling}\t${verdict}\n\t${JSON.stringify(output)}`);
}
