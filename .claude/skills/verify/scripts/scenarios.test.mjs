import assert from "node:assert/strict";
import { test } from "node:test";

import { scenarioNamed, scenarioPrerequisites, scenarioSettings } from "./scenarios.mjs";

const raw = "Hi Anna, can we move our meeting to Thursday at 3.30? Let me know if that works.";
const text = "Hi Anna, can we move our meeting to Thursday at 3:30? Let me know if that works.";
const session = (overrides = {}) => ({
  fixture: "short.wav",
  end: "audio",
  mode: "toggle",
  hotkey: "rightOption",
  cleanup: { enabled: true },
  outcome: { kind: "inserted", method: "accessibility" },
  inserted: text,
  latest: { id: "new-session", status: "inserted", raw, text },
  ...overrides,
});

test("the named scenarios set only scratch shortcuts and rewrite preconditions", () => {
  assert.throws(() => scenarioNamed("unknown"), /choose a scenario/);
  assert.throws(() => scenarioNamed("toString"), /choose a scenario/);
  for (const name of [
    "short-dictation",
    "cleanup-failure",
    "dictionary-word",
    "snippet-expansion",
  ]) {
    const settings = scenarioSettings(name);
    assert.equal(settings.hotkey, "fn");
    assert.equal(settings.toggleHotkey, "rightOption");
    assert.equal(settings.cleanup.enabled, true);
    assert.equal(settings.copyToClipboard, false);
  }
  assert.deepEqual(scenarioSettings("dictionary-word").snippets, []);
  assert.deepEqual(scenarioSettings("snippet-expansion").dictionary, []);
});

test("short dictation accepts model punctuation and time variants", () => {
  const check = scenarioNamed("short-dictation").assert;
  check(session(), ["old-session"]);
  const spelled = text.replace("3:30", "three thirty");
  check(session({ inserted: spelled, latest: { ...session().latest, text: spelled } }), []);
});

for (const [name, change, pattern] of [
  ["doubled target", { inserted: text + text }, /target differs/],
  ["truncated target", { inserted: text.slice(0, -12) }, /target differs/],
  ["empty target", { inserted: "" }, /target is empty/],
  ["no history entry", { latest: null }, /no history entry/],
  [
    "unsettled history",
    { latest: { ...session().latest, status: "pending" } },
    /settle as inserted/,
  ],
  [
    "wrong outcome",
    { outcome: { kind: "notInserted", reason: "failed" } },
    /did not report insertion/,
  ],
  ["lost raw", { latest: { ...session().latest, raw: "" } }, /lost Anna/],
  ["unrelated raw", { latest: { ...session().latest, raw: "Anna Thursday" } }, /lost meeting/],
  [
    "lost time",
    { latest: { ...session().latest, raw: raw.replace("3.30", "tomorrow") } },
    /lost the meeting time/,
  ],
  ["ended early", { captureEndedEarly: { afterMs: 100, session: "processing" } }, /capture ended/],
  ["cleanup disabled", { cleanup: { enabled: false } }, /cleanup must be enabled/],
]) {
  test(`short dictation rejects ${name}`, () => {
    assert.throws(() => scenarioNamed("short-dictation").assert(session(change), []), pattern);
  });
}

test("any pre-existing history id is stale, including the recovery session's first entry", () => {
  const current = session();
  assert.throws(
    () => scenarioNamed("short-dictation").assert(current, ["new-session", "older"]),
    /predates/,
  );
  assert.throws(
    () =>
      scenarioNamed("cleanup-failure").assertRecovery(current, ["new-session"], {
        failures: 1,
        successes: 1,
      }),
    /predates/,
  );
});

test("cleanup failure preserves exact raw and consumes the rejection before normal recovery", () => {
  const scenario = scenarioNamed("cleanup-failure");
  const fallback = session({ inserted: raw, latest: { ...session().latest, text: raw } });
  scenario.assert(fallback, [], { failures: 1, successes: 0 });
  for (const probe of [
    { failures: 0, successes: 0 },
    { failures: 1, successes: 1 },
    { failures: 2, successes: 0 },
  ]) {
    assert.throws(() => scenario.assert(fallback, [], probe), /rejection was not consumed once/);
  }
  assert.throws(
    () => scenario.assert(session(), [], { failures: 1, successes: 0 }),
    /lost the raw/,
  );
  scenario.assertRecovery(session(), ["failed-cleanup-session"], { failures: 1, successes: 1 });
  assert.throws(
    () => scenario.assertRecovery(session(), [], { failures: 1, successes: 0 }),
    /did not succeed/,
  );
});

test("dictionary spelling must land in the target while raw retains Thursday", () => {
  const check = scenarioNamed("dictionary-word").assert;
  const rewritten = text.replace("Thursday", "THURSDAY");
  const result = session({ inserted: rewritten, latest: { ...session().latest, text: rewritten } });
  check(result, []);
  assert.throws(() => check(session(), []), /saved dictionary spelling/);
  assert.throws(() => check({ ...result, inserted: text }, []), /target differs/);
  assert.throws(
    () => check({ ...result, latest: { ...result.latest, raw: rewritten } }, []),
    /raw lost the original/,
  );
});

test("snippet expansion must match saved text and replace only the final trigger", () => {
  const check = scenarioNamed("snippet-expansion").assert;
  const rewritten = text.replace("Thursday", "Friday at noon");
  const result = session({ inserted: rewritten, latest: { ...session().latest, text: rewritten } });
  check(result, []);
  assert.throws(() => check(session(), []), /saved snippet expansion/);
  const paraphrased = rewritten.replace("Friday at noon", "Friday at 12");
  assert.throws(
    () =>
      check(
        session({ inserted: paraphrased, latest: { ...result.latest, text: paraphrased } }),
        [],
      ),
    /saved snippet expansion/,
  );
  const appended = text.replace("Thursday", "Thursday Friday at noon");
  assert.throws(
    () => check(session({ inserted: appended, latest: { ...result.latest, text: appended } }), []),
    /trigger was not replaced/,
  );
  assert.throws(
    () => check({ ...result, latest: { ...result.latest, raw: rewritten } }, []),
    /lost Thursday/,
  );
});

test("unmet prerequisites stay separate from scenario assertions", () => {
  const report = {
    dependencies: { workspace: "missing: run pnpm install", electron: "installed" },
    app: "built",
    helper: "stale",
    fnpost: "built",
    fixtures: "present",
    testModels: { asr: "cached", cleanup: "will download" },
    optionalTestModels: { transform: "missing" },
    instance: "none",
    otherVoiceProcesses: ["another helper"],
  };
  const blocked = scenarioPrerequisites(report);
  assert.deepEqual(blocked.models, [["cleanup", "will download"]]);
  assert.deepEqual(blocked.builds, [
    ["workspace", "missing: run pnpm install"],
    ["helper", "stale"],
  ]);
  assert.deepEqual(blocked.permissions, []);
  assert.deepEqual(blocked.desktop, ["another helper"]);
  assert.deepEqual(blocked.instance, []);
});
