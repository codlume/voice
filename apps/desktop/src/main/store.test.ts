import { describe, expect, test } from "vite-plus/test";

import { DEFAULT_SETTINGS } from "../shared/api.ts";
import { POLISH_ID } from "../shared/transforms.ts";
import { idle, type Session } from "./session.ts";
import { toSnapshot, type AppState } from "./store.ts";
import { idleRun, type TransformRun } from "./transform-run.ts";

const reading: TransformRun = { phase: "reading", id: "r1", transformId: POLISH_ID };
const transformDone: TransformRun = { phase: "done", id: "r1", outcome: { kind: "noSelection" } };
const recording: Session = { phase: "recording", id: "s1", mode: "hold", pressedAt: 0 };
const dictationDone: Session = { phase: "done", id: "s1", outcome: { kind: "empty" } };

const state: AppState = {
  session: idle,
  transform: reading,
  permissions: { microphone: "granted", accessibility: "granted", systemAudio: "notDetermined" },
  loginItem: "off",
  models: { asr: { state: "ready" }, cleanup: { state: "ready" }, transform: { state: "missing" } },
  settings: DEFAULT_SETTINGS,
  updates: {
    version: "0.0.1",
    installedChannel: "stable",
    channel: "stable",
    status: { kind: "disabled", reason: "Test" },
  },
  microphones: { kind: "loading" },
  microphoneTest: { kind: "off" },
  account: { kind: "signedOut" },
};

describe("toSnapshot", () => {
  test("never carries the transform run to a window", () => {
    const snapshot = toSnapshot(state);
    expect(snapshot).not.toHaveProperty("transform");
    expect(Object.keys(snapshot).toSorted()).toEqual([
      "account",
      "loginItem",
      "microphoneTest",
      "microphones",
      "models",
      "permissions",
      "session",
      "settings",
      "updates",
    ]);
    expect(snapshot.session).toEqual({ kind: "transforming", loading: false });
  });

  const pill = (session: Session, transform: TransformRun) =>
    toSnapshot({ ...state, session, transform }).session;

  test("the pill shows a dictation in progress over a transform run", () => {
    expect(pill(recording, reading)).toEqual({ kind: "listening" });
    expect(pill(recording, transformDone)).toEqual({ kind: "listening" });
  });

  test("the pill shows a transform run, or its outcome, over a finished or idle dictation", () => {
    expect(pill(idle, reading)).toEqual({ kind: "transforming", loading: false });
    expect(pill(dictationDone, reading)).toEqual({ kind: "transforming", loading: false });
    expect(pill(dictationDone, transformDone)).toEqual({
      kind: "transformDone",
      outcome: { kind: "noSelection" },
    });
  });

  test("the pill falls back to the dictation session once the run is idle", () => {
    expect(pill(idle, idleRun)).toEqual({ kind: "idle" });
    expect(pill(dictationDone, idleRun)).toEqual({ kind: "done", outcome: { kind: "empty" } });
  });

  test("the pill names the model load only while generating with the model not ready", () => {
    const generating: TransformRun = {
      phase: "generating",
      id: "r1",
      transformId: POLISH_ID,
      via: "copy",
      words: 2,
    };
    const models = { ...state.models, transform: { state: "loading" } as const };
    expect(toSnapshot({ ...state, transform: generating, models }).session).toEqual({
      kind: "transforming",
      loading: true,
    });
  });
});
