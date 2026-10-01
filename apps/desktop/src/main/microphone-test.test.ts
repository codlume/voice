import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { START_TIMEOUT_MS } from "./dictation.ts";
import { MICROPHONE_TEST_MAX_MS, createMicrophoneTest } from "./microphone-test.ts";
import type { HelperCommand } from "./protocol.ts";
import { idle } from "./session.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { createStore } from "./store.ts";

const usb = { uid: "usb", name: "USB Microphone" };

function harness() {
  const store = createStore({
    updates: {
      version: "0.0.1",
      installedChannel: "stable",
      channel: "stable",
      status: { kind: "disabled", reason: "Test" },
    },
    session: idle,
    permissions: { microphone: "granted", accessibility: "granted" },
    loginItem: "off",
    models: { asr: { state: "ready" }, cleanup: { state: "ready" } },
    settings: { ...DEFAULT_SETTINGS, microphone: usb },
    microphones: { kind: "ready", devices: [usb], defaultUid: "usb" },
    microphoneTest: { kind: "off" },
    last: null,
  });
  const commands: HelperCommand[] = [];
  const levels: number[] = [];
  const run = createMicrophoneTest({
    store,
    send: (command) => commands.push(command),
    onLevel: (level) => levels.push(level),
  });
  const state = () => store.state.microphoneTest;
  const id = () => {
    const start = commands.findLast((command) => command.type === "microphone.test.start");
    if (!start) throw new Error("no test started");
    return start.id;
  };
  return { store, commands, levels, test: run, state, id };
}

describe("microphone test", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("start asks the helper to meter the saved microphone and shows starting", () => {
    const h = harness();
    h.test.start();
    expect(h.commands).toEqual([{ type: "microphone.test.start", id: h.id(), microphone: usb }]);
    expect(h.state()).toEqual({ kind: "starting" });
  });

  test("a second start while one runs does not open another test", () => {
    const h = harness();
    h.test.start();
    h.test.start();
    expect(h.commands).toHaveLength(1);
  });

  test("shows listening only once audio flows", () => {
    const h = harness();
    h.test.start();
    h.test.onHelperEvent({ type: "microphone.test.level", id: h.id(), level: 0.4 });
    expect(h.state()).toEqual({ kind: "starting" });
    h.test.onHelperEvent({ type: "microphone.test.started", id: h.id() });
    expect(h.state()).toEqual({ kind: "listening", episode: 1 });
  });

  test("forwards levels for the current test only", () => {
    const h = harness();
    h.test.start();
    h.test.onHelperEvent({ type: "microphone.test.started", id: h.id() });
    h.test.onHelperEvent({ type: "microphone.test.level", id: h.id(), level: 0.4 });
    h.test.onHelperEvent({ type: "microphone.test.level", id: "stale", level: 0.9 });
    h.test.onHelperEvent({ type: "capture.level", id: h.id(), level: 0.7 });
    expect(h.levels).toEqual([0.4]);
  });

  test("an ended test turns off and stops forwarding levels", () => {
    const h = harness();
    h.test.start();
    const id = h.id();
    h.test.onHelperEvent({ type: "microphone.test.started", id });
    h.test.onHelperEvent({ type: "microphone.test.ended", id });
    expect(h.state()).toEqual({ kind: "off" });
    h.test.onHelperEvent({ type: "microphone.test.level", id, level: 0.5 });
    expect(h.levels).toEqual([]);
  });

  test("a failed test shows the helper's message and can start again", () => {
    const h = harness();
    h.test.start();
    const message = "Finish dictating, then test again.";
    h.test.onHelperEvent({ type: "microphone.test.failed", id: h.id(), message });
    expect(h.state()).toEqual({ kind: "failed", message });
    h.test.start();
    expect(h.commands.filter((command) => command.type === "microphone.test.start")).toHaveLength(
      2,
    );
    expect(h.state()).toEqual({ kind: "starting" });
  });

  test("events for an earlier test do not touch the current one", () => {
    const h = harness();
    h.test.start();
    const first = h.id();
    h.test.stop();
    h.test.start();
    h.test.onHelperEvent({ type: "microphone.test.started", id: h.id() });
    h.test.onHelperEvent({ type: "microphone.test.ended", id: first });
    h.test.onHelperEvent({ type: "microphone.test.failed", id: first, message: "old" });
    expect(h.state()).toEqual({ kind: "listening", episode: 1 });
  });

  test("the cap stops a forgotten test and tells the helper", () => {
    const h = harness();
    h.test.start();
    const id = h.id();
    h.test.onHelperEvent({ type: "microphone.test.started", id });
    vi.advanceTimersByTime(MICROPHONE_TEST_MAX_MS - 1);
    expect(h.state()).toEqual({ kind: "listening", episode: 1 });
    vi.advanceTimersByTime(1);
    expect(h.commands.at(-1)).toEqual({ type: "microphone.test.stop", id });
    expect(h.state()).toEqual({ kind: "off" });
  });

  test("a start the helper never answers fails at the start deadline and tells the helper", () => {
    const h = harness();
    h.test.start();
    const id = h.id();
    vi.advanceTimersByTime(START_TIMEOUT_MS - 1);
    expect(h.state()).toEqual({ kind: "starting" });
    vi.advanceTimersByTime(1);
    expect(h.commands.at(-1)).toEqual({ type: "microphone.test.stop", id });
    expect(h.state()).toEqual({
      kind: "failed",
      message: "Voice could not start the microphone. Test again.",
    });
  });

  test("a started test outlives the start deadline and stops at the cap", () => {
    const h = harness();
    h.test.start();
    const id = h.id();
    vi.advanceTimersByTime(START_TIMEOUT_MS - 1);
    h.test.onHelperEvent({ type: "microphone.test.started", id });
    vi.advanceTimersByTime(MICROPHONE_TEST_MAX_MS - 1);
    expect(h.state()).toEqual({ kind: "listening", episode: 1 });
    vi.advanceTimersByTime(1);
    expect(h.commands.at(-1)).toEqual({ type: "microphone.test.stop", id });
    expect(h.state()).toEqual({ kind: "off" });
  });

  test("a restarted test keeps its cap", () => {
    const h = harness();
    h.test.start();
    const id = h.id();
    h.test.onHelperEvent({ type: "microphone.test.started", id });
    vi.advanceTimersByTime(MICROPHONE_TEST_MAX_MS / 2);
    h.test.onHelperEvent({ type: "microphone.test.started", id });
    vi.advanceTimersByTime(MICROPHONE_TEST_MAX_MS / 2);
    expect(h.commands.at(-1)).toEqual({ type: "microphone.test.stop", id });
    expect(h.state()).toEqual({ kind: "off" });
  });

  test("each started for the current test is a new listening episode", () => {
    const h = harness();
    h.test.start();
    const id = h.id();
    h.test.onHelperEvent({ type: "microphone.test.started", id });
    expect(h.state()).toEqual({ kind: "listening", episode: 1 });
    h.test.onHelperEvent({ type: "microphone.test.started", id });
    expect(h.state()).toEqual({ kind: "listening", episode: 2 });
    h.test.onHelperEvent({ type: "microphone.test.started", id: "stale" });
    expect(h.state()).toEqual({ kind: "listening", episode: 2 });
  });

  test("a test that ended on its own does not fire the cap later", () => {
    const h = harness();
    h.test.start();
    h.test.onHelperEvent({ type: "microphone.test.ended", id: h.id() });
    vi.advanceTimersByTime(MICROPHONE_TEST_MAX_MS);
    expect(h.commands.map((command) => command.type)).toEqual(["microphone.test.start"]);
  });

  test("a helper exit fails a running test", () => {
    const h = harness();
    h.test.start();
    h.test.onHelperEvent({ type: "microphone.test.started", id: h.id() });
    h.test.helperExited();
    expect(h.state()).toEqual({
      kind: "failed",
      message: "The microphone test stopped while Voice reconnected. Test again.",
    });
    vi.advanceTimersByTime(MICROPHONE_TEST_MAX_MS);
    expect(h.commands.map((command) => command.type)).toEqual(["microphone.test.start"]);
  });

  test("a helper exit with no test running changes nothing", () => {
    const h = harness();
    const before = h.store.state;
    h.test.helperExited();
    expect(h.store.state).toBe(before);
  });

  test("stop is idempotent and clears a failure", () => {
    const h = harness();
    h.test.start();
    const id = h.id();
    h.test.stop();
    h.test.stop();
    expect(h.commands).toEqual([
      { type: "microphone.test.start", id, microphone: usb },
      { type: "microphone.test.stop", id },
    ]);
    expect(h.state()).toEqual({ kind: "off" });

    h.test.start();
    h.test.onHelperEvent({ type: "microphone.test.failed", id: h.id(), message: "No microphone." });
    const sent = h.commands.length;
    h.test.stop();
    expect(h.commands).toHaveLength(sent);
    expect(h.state()).toEqual({ kind: "off" });
  });

  test("stop with nothing to stop leaves the snapshot alone", () => {
    const h = harness();
    const before = h.store.state;
    h.test.stop();
    expect(h.store.state).toBe(before);
    expect(h.commands).toEqual([]);
  });
});
