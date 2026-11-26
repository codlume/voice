import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const workflows = fileURLToPath(new URL("../.github/workflows/", import.meta.url));
const statusFunction = /\b(always|cancelled|failure)\(\)/;

// A job whose if: has no status function runs only when every job above it succeeded, not
// just the ones it needs. When a needed job keeps running past a skip with a status
// function, the job below it is skipped anyway, as Release's build was on every schedule.
function jobsSkippedPastTheirNeeds(workflow) {
  const jobs = workflow.jobs ?? {};
  const shielded = (name) => statusFunction.test(String(jobs[name]?.if ?? ""));
  return Object.entries(jobs).flatMap(([name, job]) => {
    const needs = [job.needs ?? []].flat();
    return needs.some(shielded) && !shielded(name) ? [name] : [];
  });
}

test("flags a job below a job that runs past a skip", () => {
  const workflow = {
    jobs: {
      stable: { if: "false" },
      nightly: {},
      plan: { needs: ["stable", "nightly"], if: "${{ !cancelled() }}" },
      build: { needs: "plan" },
    },
  };
  assert.deepEqual(jobsSkippedPastTheirNeeds(workflow), ["build"]);
});

for (const file of readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name))) {
  test(`${file} jobs run when the jobs they need run`, () => {
    const workflow = parse(readFileSync(new URL(file, `file://${workflows}`), "utf8"));
    assert.deepEqual(jobsSkippedPastTheirNeeds(workflow), []);
  });
}
