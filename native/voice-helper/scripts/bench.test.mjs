import assert from "node:assert/strict";
import { test } from "node:test";

import {
  METRICS,
  compare,
  compareTranscripts,
  cpuSeconds,
  failures,
  finalizationPath,
  formatTable,
  measurement,
  missingAnchors,
  parseArgs,
  parseIntegrityLog,
  parseTimeOutput,
  summarize,
  topMemoryMb,
  wavDurationMs,
} from "./bench-report.mjs";

test("arguments: one side, both sides, and the defaults", () => {
  assert.deepEqual(parseArgs(["--candidate", "new"]), {
    baseline: null,
    candidate: "new",
    runs: null,
    metrics: METRICS,
    out: null,
    fnpost: null,
    verbose: false,
  });
  const both = parseArgs([
    "--baseline",
    "old",
    "--candidate",
    "new",
    "--runs",
    "7",
    "--only",
    "paste,load-warm",
    "--out",
    "report.json",
    "--fnpost",
    "poster",
    "--verbose",
  ]);
  assert.deepEqual(both, {
    baseline: "old",
    candidate: "new",
    runs: 7,
    // Selected metrics run in the script's own order, whatever order --only names them in.
    metrics: ["load-warm", "paste"],
    out: "report.json",
    fnpost: "poster",
    verbose: true,
  });
});

test("arguments: a run that could not measure what was asked is refused", () => {
  assert.throws(() => parseArgs(["--baseline", "old"]), /--candidate/);
  assert.throws(() => parseArgs(["--candidate", "new", "--runs", "0"]), /positive integer/);
  assert.throws(() => parseArgs(["--candidate", "new", "--runs", "2.5"]), /positive integer/);
  assert.throws(() => parseArgs(["--candidate", "new", "--only", "paste,warm"]), /warm/);
  assert.throws(() => parseArgs(["--candidate", "new", "--only", ","]), /at least one/);
  assert.throws(() => parseArgs(["--candidate", "new", "--sessions", "3"]));
  assert.throws(() => parseArgs(["--candidate", "new", "extra"]));
});

test("statistics: median, min, max and range cover the runs that produced a sample", () => {
  assert.deepEqual(summarize([30, 10, 20]), {
    samples: [30, 10, 20],
    n: 3,
    median: 20,
    min: 10,
    max: 30,
    range: 20,
  });
  assert.equal(summarize([1, 2, 3, 10]).median, 2.5);
  const withFailure = summarize([5, null, 7]);
  assert.deepEqual(
    { n: withFailure.n, median: withFailure.median, range: withFailure.range },
    { n: 2, median: 6, range: 2 },
  );
  assert.deepEqual(withFailure.samples, [5, null, 7]);
  assert.deepEqual(summarize([null, null]), {
    samples: [null, null],
    n: 0,
    median: null,
    min: null,
    max: null,
    range: null,
  });
  assert.equal(summarize([0.1, 0.3]).range, 0.2);
});

test("comparison: overlapping ranges are no measurable difference", () => {
  const result = compare(summarize([100, 104, 98, 110, 101]), summarize([99, 103, 97, 96, 108]));
  assert.equal(result.verdict, "no measurable difference");
  assert.equal(result.medianDelta, -2);
  assert.equal(result.medianDeltaPercent, -1.98);
  assert.equal(result.noiseFloor, 12);
  assert.deepEqual(result.pairedDeltas, [-1, -1, -1, -14, 7]);
  assert.equal(result.candidateLowerInPairs, "4 of 5");
});

test("comparison: disjoint ranges are a difference only with enough samples", () => {
  const lower = compare(summarize([100, 104, 98, 110, 101]), summarize([80, 82, 79, 90, 85]));
  assert.equal(lower.verdict, "candidate lower");
  assert.equal(lower.falsePositiveRate, 0.008);
  const higher = compare(summarize([80, 82, 79, 90, 85]), summarize([100, 104, 98, 110, 101]));
  assert.equal(higher.verdict, "candidate higher");
  const few = compare(summarize([100, 104, 98]), summarize([80, 82, 79]));
  assert.equal(few.falsePositiveRate, 0.1);
  assert.equal(few.verdict, "candidate lower in every sample, but too few samples to call");
});

test("comparison: a run that failed on either side has no paired delta", () => {
  const result = compare(summarize([10, null, 12]), summarize([11, 9, null]));
  assert.deepEqual(result.pairedDeltas, [1, null, null]);
  assert.equal(result.candidateLowerInPairs, "0 of 1");
  assert.deepEqual(compare(summarize([null]), summarize([1])), {
    verdict: "no samples on one side",
  });
});

test("report: a measurement carries unit, source, every sample, and a comparison for two sides", () => {
  const spec = { unit: "ms", source: "driver clock: a -> b" };
  const both = measurement(spec, { baseline: [1, 2, 3], candidate: [2, 3, 4] });
  assert.deepEqual(Object.keys(both), ["unit", "source", "sides", "comparison"]);
  assert.deepEqual(both.sides.candidate, {
    samples: [2, 3, 4],
    n: 3,
    median: 3,
    min: 2,
    max: 4,
    range: 2,
  });
  const single = measurement({ ...spec, comparable: false }, { candidate: [2, 3, 4] });
  assert.deepEqual(Object.keys(single), ["unit", "source", "comparable", "sides"]);
});

function report(metrics) {
  return { metrics };
}

test("report: failed sessions, failed metrics and changed text fail the run; a skip does not", () => {
  const sides = { baseline: summarize([1, 2]), candidate: summarize([1, null]) };
  const measured = {
    status: "measured",
    measurements: { startMs: { unit: "ms", source: "s", sides } },
    errors: { baseline: [], candidate: [{ run: 1, message: "timed out" }] },
  };
  assert.deepEqual(failures(report({ hotkey: measured })), ["hotkey: 1 failed on candidate"]);
  assert.deepEqual(
    failures(report({ paste: { status: "skipped", reason: "another Voice is running" } })),
    [],
  );
  assert.deepEqual(failures(report({ paste: { status: "failed", reason: "no fnpost binary" } })), [
    "paste: no fnpost binary",
  ]);
  const changed = { status: "measured", errors: {}, accuracy: { matchesBaseline: false } };
  assert.deepEqual(failures(report({ finalization: changed })), [
    "finalization: a candidate transcript differs from the baseline's",
  ]);
});

test("report: the table shows each side, each error, each skip and each changed transcript", () => {
  const table = formatTable(
    report({
      "load-warm": {
        status: "measured",
        measurements: {
          prepareMs: measurement(
            { unit: "ms", source: "s" },
            { baseline: [250, 240, 260, 255, 245], candidate: [200, 190, 210, null, 195] },
          ),
        },
        errors: { baseline: [], candidate: [{ run: 3, message: "asr.status is failed" }] },
      },
      finalization: {
        status: "measured",
        measurements: {},
        errors: { baseline: [], candidate: [] },
        fixtures: { short: { accuracy: compareTranscripts(["Hi Anna."], ["Hi, Anna."]) } },
      },
      "mic-start": { status: "skipped", reason: "microphone permission is denied" },
    }),
  ).split("\n");
  assert.match(table[0], /^metric +measurement +unit +side +n +median +min +max +verdict$/);
  assert.match(table[1], /^load-warm +prepareMs +ms +baseline +5 +250 +240 +260$/);
  assert.match(
    table[2],
    /^load-warm +prepareMs +ms +candidate +4 +197.5 +190 +210 +candidate lower$/,
  );
  assert.equal(
    table[3],
    'load-warm  error on candidate: {"run":3,"message":"asr.status is failed"}',
  );
  assert.equal(
    table[4],
    'finalization  short text differs: {"run":0,"baseline":"Hi Anna.","candidate":"Hi, Anna."}',
  );
  assert.equal(table[5], "mic-start  skipped: microphone permission is denied");
});

test("accuracy: the candidate must repeat the baseline's text run for run", () => {
  assert.deepEqual(compareTranscripts(["a b", "a b"], ["a b", "a b"]), {
    matchesBaseline: true,
    differences: [],
  });
  assert.deepEqual(compareTranscripts(["Hi Anna.", "Hi Anna."], ["Hi Anna.", "Hi Anna"]), {
    matchesBaseline: false,
    differences: [{ run: 1, baseline: "Hi Anna.", candidate: "Hi Anna" }],
  });
  // The same texts in another order are a difference: the comparison is per run.
  assert.equal(compareTranscripts(["a", "b"], ["b", "a"]).differences.length, 2);
});

test("accuracy: a session that produced no transcript on either side is a difference", () => {
  assert.deepEqual(compareTranscripts(["a", null], ["a", null]).differences, [
    { run: 1, baseline: null, candidate: null },
  ]);
  assert.deepEqual(compareTranscripts(["a", "b"], ["a"]).differences, [
    { run: 1, baseline: "b", candidate: null },
  ]);
  assert.deepEqual(compareTranscripts(["a"], ["a", "b"]).differences, [
    { run: 1, baseline: null, candidate: "b" },
  ]);
});

test("accuracy: anchor words are matched without regard to case", () => {
  const text = "Hi Anna, can we move our meeting to thursday?";
  assert.deepEqual(missingAnchors(text, ["Anna", "Thursday"]), []);
  assert.deepEqual(missingAnchors(text, ["Anna", "Friday", "42,000"]), ["Friday", "42,000"]);
});

test("the finalization path is read from the helper's log lines", () => {
  assert.equal(finalizationPath([]), "full decode");
  assert.equal(finalizationPath(["test.audioFile ended"]), "full decode");
  assert.equal(finalizationPath(["streaming ASR finalized 467232 samples"]), "streamed");
  assert.equal(
    finalizationPath(["ASR reused the decode from the last pause"]),
    "reused pause decode",
  );
  assert.equal(
    finalizationPath(["streaming ASR incomplete; retrying complete capture"]),
    "full decode after an incomplete stream",
  );
  assert.equal(
    finalizationPath(["ASR decode from the last pause failed; retrying complete capture"]),
    "full decode after a failed pause decode",
  );
});

test("the integrity check's own timing is read from its log line", () => {
  assert.deepEqual(
    parseIntegrityLog(
      "speech model checked: first pass hashed 18 files, 1670689 bytes, done in 38 ms",
    ),
    { hashedFiles: 18, hashedBytes: 1670689, ms: 38 },
  );
  assert.equal(parseIntegrityLog("hotkey tap installed"), null);
});

const timeOutput = (decimal) =>
  [
    "a line the helper wrote to stderr",
    `       92${decimal}41 real         3${decimal}52 user         1${decimal}08 sys`,
    "           812646400  maximum resident set size",
    "                   0  average shared memory size",
    "                 447  page reclaims",
    "           950288384  peak memory footprint",
  ].join("\n");

test("/usr/bin/time -l output gives peak memory and CPU seconds in either decimal style", () => {
  const expected = {
    realS: 92.41,
    userS: 3.52,
    sysS: 1.08,
    maxRssBytes: 812646400,
    peakFootprintBytes: 950288384,
  };
  assert.deepEqual(parseTimeOutput(timeOutput(".")), expected);
  assert.deepEqual(parseTimeOutput(timeOutput(",")), expected);
  assert.throws(() => parseTimeOutput("the helper crashed before time could report"), /real/);
});

test("ps cumulative CPU time is read as seconds", () => {
  assert.equal(cpuSeconds("0:01.23"), 1.23);
  assert.equal(cpuSeconds("12:34.50"), 754.5);
  assert.equal(cpuSeconds("1:02:03.00"), 3723);
  assert.equal(cpuSeconds("2-01:00:00.00"), 176_400);
  assert.equal(cpuSeconds("0:01,23"), 1.23);
});

test("a size from top is read in MiB", () => {
  assert.equal(topMemoryMb("58M"), 58);
  assert.equal(topMemoryMb("2304K"), 2.25);
  assert.equal(topMemoryMb("1.5G"), 1536);
  assert.equal(topMemoryMb("1048576B"), 1);
  assert.equal(topMemoryMb("412M+\n"), 412);
  assert.throws(() => topMemoryMb("MEM"), /cannot read/);
});

function wav({ dataBytes, extraChunk = false }) {
  const chunks = [Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")];
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ");
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt32LE(32_000, 16);
  chunks.push(fmt);
  if (extraChunk) {
    // An odd-sized chunk is followed by one pad byte.
    const list = Buffer.alloc(8 + 3 + 1);
    list.write("LIST");
    list.writeUInt32LE(3, 4);
    chunks.push(list);
  }
  const data = Buffer.alloc(8 + dataBytes);
  data.write("data");
  data.writeUInt32LE(dataBytes, 4);
  chunks.push(data);
  return Buffer.concat(chunks);
}

test("a fixture's duration comes from its WAVE header", () => {
  assert.equal(wavDurationMs(wav({ dataBytes: 64_000 })), 2000);
  assert.equal(wavDurationMs(wav({ dataBytes: 189_190, extraChunk: true })), 5912.188);
  assert.throws(() => wavDurationMs(Buffer.from("not audio at all")), /RIFF/);
  assert.throws(() => wavDurationMs(wav({ dataBytes: 0 }).subarray(0, 36)), /no data chunk/);
});
