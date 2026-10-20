import assert from "node:assert/strict";

function shortContent(text, { rewritten = false } = {}) {
  assert.equal(typeof text, "string", "fixture transcript is missing");
  assert.match(text, /\bAnna\b/i, "short fixture lost Anna");
  assert.match(text, /\bmeeting\b/i, "short fixture lost meeting");
  assert.match(text, /\b(?:3[.:]30|three thirty)\b/i, "short fixture lost the meeting time");
  if (!rewritten) assert.match(text, /\bThursday\b/i, "short fixture lost Thursday");
}

function insertedSession(result, previousIds, { rewritten = false } = {}) {
  assert.equal(result.fixture, "short.wav");
  assert.equal(result.end, "audio");
  assert.equal(result.mode, "toggle");
  assert.equal(result.hotkey, "rightOption");
  assert.equal(result.cleanup?.enabled, true, "cleanup must be enabled");
  assert.ok(!result.captureEndedEarly, "capture ended before the fixture finished");
  assert.equal(result.outcome?.kind, "inserted", "session did not report insertion");
  assert.ok(["accessibility", "paste"].includes(result.outcome.method));
  assert.ok(result.latest?.id, "session added no history entry");
  assert.ok(!previousIds.includes(result.latest.id), "history entry predates this session");
  assert.equal(result.latest.status, "inserted", "history did not settle as inserted");
  assert.equal(typeof result.inserted, "string", "target text is missing");
  assert.ok(result.inserted.trim(), "target is empty");
  assert.equal(result.inserted, result.latest.text, "target differs from history text");
  shortContent(result.latest.raw);
  shortContent(result.latest.text, { rewritten });
}

export const scenarios = {
  "short-dictation": {
    settings: {},
    assert: insertedSession,
  },
  "cleanup-failure": {
    settings: {},
    assert(result, previousIds, probe) {
      insertedSession(result, previousIds);
      assert.deepEqual(
        probe,
        { failures: 1, successes: 0 },
        "cleanup rejection was not consumed once",
      );
      assert.equal(result.inserted, result.latest.raw, "cleanup failure lost the raw transcript");
    },
    assertRecovery(result, previousIds, probe) {
      insertedSession(result, previousIds);
      assert.deepEqual(probe, { failures: 1, successes: 1 }, "subsequent cleanup did not succeed");
    },
  },
  "dictionary-word": {
    settings: {
      dictionary: [{ id: "synthetic-word", phrase: "THURSDAY", replacement: null }],
    },
    assert(result, previousIds) {
      insertedSession(result, previousIds, { rewritten: true });
      assert.match(result.inserted, /\bTHURSDAY\b/, "saved dictionary spelling was not inserted");
      assert.match(result.latest.raw, /\bThursday\b/, "raw lost the original spelling");
      assert.doesNotMatch(result.latest.raw, /\bTHURSDAY\b/, "raw contains the dictionary rewrite");
    },
  },
  "snippet-expansion": {
    settings: {
      snippets: [
        {
          id: "synthetic-snippet",
          trigger: "Thursday",
          expansion: "Friday at noon",
          expansionHtml: null,
          enabled: true,
        },
      ],
    },
    assert(result, previousIds) {
      insertedSession(result, previousIds, { rewritten: true });
      assert.ok(
        result.inserted.includes("Friday at noon"),
        "saved snippet expansion was not inserted",
      );
      assert.doesNotMatch(result.inserted, /\bThursday\b/i, "snippet trigger was not replaced");
      assert.doesNotMatch(result.latest.raw, /Friday at noon/i, "raw contains the snippet rewrite");
    },
  },
};

export function scenarioNamed(name) {
  assert.ok(
    Object.hasOwn(scenarios, name),
    `choose a scenario: ${Object.keys(scenarios).join(" | ")}`,
  );
  return scenarios[name];
}

export function scenarioSettings(name) {
  return {
    hotkey: "fn",
    toggleHotkey: "rightOption",
    dictationLanguage: "en",
    copyToClipboard: false,
    muteWhileDictating: false,
    cleanup: { enabled: true },
    dictionary: [],
    snippets: [],
    ...scenarioNamed(name).settings,
  };
}

export function scenarioPrerequisites(report) {
  return {
    builds: [
      ...Object.entries(report.dependencies).filter(([, state]) => state !== "installed"),
      ...["app", "helper", "fnpost"]
        .filter((id) => report[id] !== "built")
        .map((id) => [id, report[id]]),
      ...(report.fixtures === "present" ? [] : [["fixtures", report.fixtures]]),
    ],
    models: Object.entries(report.testModels).filter(([, state]) => state !== "cached"),
    permissions: [],
    instance: report.instance === "none" ? [] : [report.instance],
    desktop: report.otherVoiceProcesses,
  };
}
