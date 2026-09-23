import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  admit,
  authorize,
  buildManifest,
  canonical,
  cost,
  hashOf,
  median,
  nearestRank,
  quality,
  summarize,
  wav,
  wavPcm,
  worstCase,
} from "./lib.mjs";

const root = join(import.meta.dirname, "../..");
const plan = JSON.parse(await readFile(join(root, "tests/acceptance/plan.json"), "utf8"));
const catalog = JSON.parse(await readFile(join(root, "tests/acceptance/fixtures.json"), "utf8"));
const build = {
  commit: "abc",
  dirty: false,
  appAsarSha256: "a",
  helperSha256: "h",
  deepgramUrl: "u",
};
const live = buildManifest({ plan, catalog, build, mode: "live" });
const fixture = (id) => catalog.fixtures.find((item) => item.id === id);

test("nearest-rank p95 and median follow the accepted definitions", () => {
  const values = Array.from({ length: 20 }, (_, index) => (index + 1) * 10);
  assert.equal(nearestRank(values, 95), 190);
  assert.equal(nearestRank([5], 95), 5);
  assert.equal(nearestRank([], 95), undefined);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test("the catalog freezes nonempty, hashed fixtures for every declared class and coverage gap", () => {
  const ids = new Set(catalog.fixtures.map((item) => item.id));
  assert.equal(ids.size, catalog.fixtures.length);
  for (const item of catalog.fixtures) assert.match(item.sha256, /^[0-9a-f]{64}$/);
  for (const kind of ["short", "intermediate", "five-minute"])
    assert.ok(catalog.fixtures.some((item) => item.class === kind && item.expected === "text"));
  const heldOut = catalog.fixtures.filter((item) => item.heldOut).map((item) => item.coverage);
  for (const gap of [
    "pauses",
    "negation",
    "acronyms",
    "dates",
    "URLs",
    "paragraph",
    "noise without speech",
    "five-minute",
  ])
    assert.ok(
      heldOut.some((coverage) => coverage.includes(gap)),
      gap,
    );
  // The failed identifier case is kept with its original source, not a changed expectation.
  assert.match(fixture("identifier").spoken, /fix slash audio dash timeout/);
});

test("quality separates the known exception, deferred formatting, hallucination, and review", () => {
  const identifier = fixture("identifier");
  assert.equal(
    quality(identifier, identifier.spoken.replace("fix slash", "fixed slash")),
    "known-exception",
  );
  assert.equal(quality(identifier, identifier.spoken.toLowerCase()), "deferred-formatting");
  assert.equal(
    quality(fixture("request"), "Please send the report to the team before lunch"),
    "match",
  );
  assert.equal(
    quality(fixture("request"), "Please send the report to the team after lunch."),
    "review",
  );
  assert.equal(quality(fixture("request"), ""), "missing-audio");
  assert.equal(quality(fixture("negative_silence"), ""), "empty");
  assert.equal(quality(fixture("negative_silence"), "Thank you."), "hallucination");
});

test("the live manifest binds build, fixtures, provider pin, order, caps, and conditions", () => {
  assert.equal(live.provider.modelUuid, "40bd3654-e622-47c4-a111-63a61b23bfe8");
  assert.deepEqual(live.caps, plan.caps);
  const short = live.stages.find((stage) => stage.name === "normal-short");
  assert.equal(short.order.length, short.maxAttempts);
  assert.ok(short.successes >= 20);
  const again = buildManifest({ plan, catalog, build, mode: "live" });
  assert.equal(hashOf(again), hashOf(live));
  assert.notEqual(
    hashOf(buildManifest({ plan, catalog, build: { ...build, commit: "def" }, mode: "live" })),
    hashOf(live),
  );
  assert.equal(canonical({ b: 1, a: [2] }), canonical({ a: [2], b: 1 }));
});

test("live dispatch needs an approved authorization for this exact manifest and stage", () => {
  const good = {
    manifestSha256: hashOf(live),
    stages: ["normal-short"],
    approved: true,
    decision: "https://github.com/codlume/voice/issues/38#issuecomment-1",
    caps: plan.caps,
  };
  assert.deepEqual(authorize(live, good, "normal-short"), []);
  assert.ok(authorize(live, undefined, "normal-short").length);
  assert.ok(authorize(live, { ...good, approved: false }, "normal-short").length);
  assert.ok(authorize(live, { ...good, manifestSha256: "0" }, "normal-short").length);
  assert.ok(authorize(live, good, "normal-five-minute").length);
  assert.ok(authorize(live, { ...good, decision: "yes" }, "normal-short").length);
  assert.ok(
    authorize(
      live,
      { ...good, caps: { ...plan.caps, maxAudioSeconds: plan.caps.maxAudioSeconds + 1 } },
      "normal-short",
    ).length,
  );
  const dry = buildManifest({ plan, catalog, build, mode: "dry-run" });
  assert.ok(authorize(dry, { ...good, manifestSha256: hashOf(dry) }, "normal-short").length);
});

test("admission reserves the worst case of each attempt and stops at the caps", () => {
  const caps = { maxRequests: 4, maxAudioSeconds: 100, maxReplays: 1 };
  assert.equal(admit([], caps, 40).ok, true);
  assert.equal(admit([], caps, 60).reason, "audio cap");
  const ledger = [{ requests: 2, submittedSeconds: 80, replays: 1 }];
  assert.equal(admit(ledger, caps, 20).ok, true);
  assert.equal(admit(ledger, caps, 21).reason, "audio cap");
  assert.equal(
    admit([...ledger, { requests: 2, submittedSeconds: 0, replays: 0 }], caps, 1).reason,
    "request cap",
  );
});

test("reports count only confirmed single-request insertions and keep every failure", () => {
  const manifest = buildManifest({
    plan: {
      ...plan,
      stages: plan.stages
        .filter((stage) => stage.name === "normal-short")
        .map((stage) => ({ ...stage, successes: 2 })),
    },
    catalog,
    build,
    mode: "dry-run",
  });
  const ledger = [
    {
      stage: "normal-short",
      slot: 0,
      fixture: "request",
      outcome: "inserted",
      replays: 0,
      requests: 1,
      targetVerified: true,
      stopToInsertionMs: 400,
      quality: "match",
    },
    {
      stage: "normal-short",
      slot: 1,
      fixture: "identifier",
      outcome: "inserted",
      replays: 1,
      requests: 2,
      targetVerified: true,
      stopToInsertionMs: 90,
      quality: "known-exception",
    },
    {
      stage: "normal-short",
      slot: 2,
      fixture: "date",
      outcome: "recovery-incomplete",
      replays: 0,
      requests: 1,
      quality: "review",
    },
    {
      stage: "normal-short",
      slot: 3,
      fixture: "list",
      outcome: "inserted",
      replays: 0,
      requests: 1,
      targetVerified: true,
      stopToInsertionMs: 800,
      quality: "match",
    },
  ];
  const report = summarize(manifest, ledger).classes["normal-short"];
  assert.equal(report.successes, 2);
  assert.equal(report.p95Ms, 800);
  assert.equal(report.medianMs, 600);
  assert.equal(report.meets, true);
  assert.deepEqual(
    report.failures.map((failure) => failure.slot),
    [1, 2],
  );
  const whole = summarize(manifest, ledger);
  assert.deepEqual(
    whole.knownException.map((item) => item.fixture),
    ["identifier"],
  );
  assert.deepEqual(
    whole.reviewNeeded.map((item) => item.fixture),
    ["date"],
  );
});

test("the costed proposal reserves every permitted request at the regular rate", () => {
  const requests = worstCase(live);
  assert.ok(requests.length <= plan.caps.maxRequests);
  assert.ok(requests.reduce((a, b) => a + b, 0) <= plan.caps.maxAudioSeconds);
  const result = cost(plan, [60, 60]);
  assert.equal(result.regularBeforeTax, 0.0154);
  assert.equal(result.reservation, 0.0308);
  assert.equal(result.available, 1.126913);
});

test("WAV round trip keeps samples and refuses other formats", () => {
  const pcm = Buffer.from([1, 0, 2, 0]);
  assert.deepEqual(wavPcm(wav(pcm)), pcm);
  const stereo = wav(pcm);
  stereo.writeUInt16LE(2, 22);
  assert.throws(() => wavPcm(stereo), /wav-format/);
});
