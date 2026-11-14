import assert from "node:assert/strict";
import { test } from "node:test";

import { compare, sessionTiming, stats } from "./main-bench.mjs";

test("stats reports the median, the nearest-rank p95 and the range in run order", () => {
  assert.deepEqual(stats([5, 1, 4, 2]), {
    n: 4,
    median: 3,
    p95: 5,
    min: 1,
    max: 5,
    values: [5, 1, 4, 2],
  });
  const twenty = Array.from({ length: 20 }, (_, index) => index + 1);
  assert.equal(stats(twenty).p95, 19);
  assert.equal(stats([7]).median, 7);
});

test("compare calls a gap separated only when the ranges do not overlap", () => {
  const base = { "ipc.getHistory.ms": stats([10, 11, 12]), "idle.mainRssMb": stats([0, 0]) };
  const [faster] = compare(base, {
    "ipc.getHistory.ms": stats([7, 8, 9]),
    "new.metric": stats([1]),
  });
  assert.deepEqual(faster, {
    metric: "ipc.getHistory.ms",
    base: 11,
    candidate: 8,
    deltaPercent: -27.273,
    separated: true,
  });
  const [noisy, zero] = compare(base, {
    "ipc.getHistory.ms": stats([8, 9, 10]),
    "idle.mainRssMb": stats([1, 2]),
  });
  assert.equal(noisy?.separated, false);
  assert.equal(zero?.deltaPercent, null);
});

test("sessionTiming reads the outcome and every millisecond field of a session line", () => {
  const line =
    "[voice] session 1a2b3c4d outcome=inserted startMs=41 asrMs=310 cleanupMs=640 insertMs=22 insertRoute=noElement asrState=warm";
  assert.deepEqual(sessionTiming(line), {
    outcome: "inserted",
    startMs: 41,
    asrMs: 310,
    cleanupMs: 640,
    insertMs: 22,
  });
});
