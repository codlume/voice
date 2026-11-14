import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { history, meetings, seeded, transcript } from "./renderer-bench/data.mjs";
import {
  bridgeMethods,
  compare,
  compareTable,
  entryAssets,
  median,
  slope,
  table,
} from "./renderer-bench/stats.mjs";

const NOW = Date.UTC(2026, 0, 15);
const preload = (page) =>
  readFileSync(new URL(`../apps/desktop/src/preload/${page}.ts`, import.meta.url), "utf8");

function dataset(seed) {
  const rand = seeded(seed);
  return [history(rand, 200, NOW), meetings(rand, 20, NOW), transcript(rand, 50)];
}
const side = (...values) => ({ build: "prod", values });

test("the same seed gives the same data, and another seed gives other data", () => {
  assert.deepEqual(dataset(1), dataset(1));
  assert.notDeepEqual(dataset(1), dataset(2));
});

test("history is newest first, with unique ids, all before now", () => {
  const entries = history(seeded(1), 500, NOW);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, 500);
  assert.ok(entries.every((entry, i) => entry.at < (entries[i - 1]?.at ?? NOW)));
  assert.ok(entries.some((entry) => entry.status === "notInserted"));
  assert.ok(entries.some((entry) => entry.raw !== entry.text));
});

test("the bridge has the methods of the app's own preloads", () => {
  const hub = bridgeMethods(preload("hub"));
  for (const name of ["getSnapshot", "onSnapshot", "getHistory", "onHistory", "onOpenMeeting"]) {
    assert.ok(hub.includes(name), name);
  }
  assert.ok(!hub.includes("getPillSnapshot"));
  assert.ok(!hub.includes("diagnosticsStartedAtLaunch"));
  // Every method is one IPC call, one subscription, or one of the two listeners the preload queues.
  const source = preload("hub");
  const wired = source.match(/ipcRenderer\.invoke\(|subscribe</g) ?? [];
  assert.equal(hub.length, wired.length + 2);
  assert.deepEqual(bridgeMethods(preload("pill")), [
    "getPillSnapshot",
    "onPillSnapshot",
    "onLevel",
    "setPillClickable",
    "openNotepad",
  ]);
  assert.deepEqual(bridgeMethods("const other = {};"), []);
});

test("median and slope", () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(slope([10, 10, 10]), 0);
  assert.equal(slope([1, 3, 5, 7]), 2);
  // A sawtooth that rises 4 over 5 steps: the fit is 11 / 17.5, not the 0.8 of its two ends.
  assert.ok(Math.abs(slope([10, 12, 11, 13, 12, 14]) - 11 / 17.5) < 1e-9);
});

test("a difference inside the run-to-run range is no measurable difference", () => {
  const rows = compare(
    {
      "a | faster": side(100, 110, 105),
      "a | noisy": side(100, 140, 105),
      "a | slower": side(10, 11, 12),
      "a | equal": side(7, 7, 7),
      "a | zero": side(0, 0),
      "a | gone": side(1),
    },
    {
      "a | faster": side(80, 99, 85),
      "a | noisy": side(80, 100, 85),
      "a | slower": side(13, 14, 15),
      "a | equal": side(7, 7, 7),
      "a | zero": side(2, 3),
      "a | new": side(1),
    },
  );
  const verdicts = Object.fromEntries(rows.map(({ name, verdict }) => [name, verdict]));
  assert.deepEqual(verdicts, {
    "a | faster": "lower",
    "a | noisy": "no measurable difference",
    "a | slower": "higher",
    "a | equal": "same",
    "a | zero": "higher",
    "a | gone": "missing",
    "a | new": "missing",
  });
  const faster = rows.find(({ name }) => name === "a | faster");
  assert.ok(Math.abs((faster?.change ?? 0) - (85 - 105) / 105) < 1e-9);
  const printed = compareTable(rows);
  assert.match(printed, /\| a \| faster \| 105 \(100–110\) \| 85 \(80–99\) \| -19\.0% \| lower \|/);
  assert.match(printed, /\| a \| zero \| 0 \| 2\.50 \(2–3\) \| n\/a \| higher \|/);
  assert.match(printed, /\| a \| gone \| 1 \| missing \| n\/a \| missing \|/);
});

test("a result table gives each metric its median, range and build", () => {
  const printed = table({
    "hub | first render ms": { build: "prod", values: [130.4, 120.2, 151] },
  });
  assert.match(printed, /\| hub \| first render ms \| 130 \(120–151\) \| prod \|/);
});

test("entry assets are what the page loads before it runs", () => {
  const html = `<link rel="icon" href="./assets/icon.png">
    <script type="module" crossorigin src="./assets/hub-1.js"></script>
    <link rel="modulepreload" crossorigin href="./assets/shared-2.js">
    <link rel="stylesheet" crossorigin href="./assets/style-3.css">
    <link rel="prefetch" href="./assets/lazy-4.js">`;
  assert.deepEqual(entryAssets(html), {
    js: ["assets/hub-1.js", "assets/shared-2.js"],
    css: ["assets/style-3.css"],
  });
});
