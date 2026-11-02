import { describe, expect, test, vi } from "vite-plus/test";

import { DEFAULT_SETTINGS } from "../shared/api.ts";
import type { TransformId } from "../shared/transforms.ts";
import { activity, whenIdle, whenSpeechModelSettles } from "./activity.ts";
import { idle, type Session } from "./session.ts";
import { createStore, type AppState } from "./store.ts";
import { noMeetingFocus } from "./meeting-focus.ts";
import { idleRun, type TransformRun } from "./transform-run.ts";

const recording: Session = { phase: "recording", id: "s1", mode: "hold", pressedAt: 0 };
const dictationDone: Session = {
  phase: "done",
  id: "s1",
  outcome: { kind: "inserted", method: "paste" },
};
const reading: TransformRun = { phase: "reading", id: "r1", transformId: "polish" as TransformId };
const inserting: TransformRun = { phase: "inserting", id: "r1" };
const transformDone: TransformRun = { phase: "done", id: "r1", outcome: { kind: "noSelection" } };

describe("activity", () => {
  test("a finished run or session is idle, so its pill may linger while the next one starts", () => {
    expect(activity({ session: idle, transform: idleRun })).toBe("idle");
    expect(activity({ session: dictationDone, transform: idleRun })).toBe("idle");
    expect(activity({ session: idle, transform: transformDone })).toBe("idle");
    expect(activity({ session: dictationDone, transform: transformDone })).toBe("idle");
  });

  test("names whichever is busy", () => {
    expect(activity({ session: recording, transform: idleRun })).toBe("dictation");
    expect(activity({ session: idle, transform: reading })).toBe("transform");
    expect(activity({ session: dictationDone, transform: inserting })).toBe("transform");
  });
});

const busy: AppState = {
  session: idle,
  transform: reading,
  meeting: noMeetingFocus,
  permissions: { microphone: "granted", accessibility: "granted", systemAudio: "notDetermined" },
  speakerModel: "ready",
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

const microtasks = () => Promise.resolve();

describe("whenIdle", () => {
  test("a queued task that updates the store leaves every subscriber hearing the newest state last", async () => {
    const store = createStore(busy);
    const runWhenIdle = whenIdle(store);
    const heard: AppState["loginItem"][] = [];
    store.subscribe((state) => heard.push(state.loginItem));
    runWhenIdle(() => store.update((s) => ({ ...s, loginItem: "on" })));
    expect(heard).toEqual([]);

    store.update((s) => ({ ...s, transform: transformDone }));
    await microtasks();
    expect(heard).toEqual(["off", "on"]);
    expect(store.state.loginItem).toBe("on");
  });

  test("a task queued more than once while busy runs once, and a task queued while idle runs at once", async () => {
    const store = createStore(busy);
    const runWhenIdle = whenIdle(store);
    const check = vi.fn();
    runWhenIdle(check);
    runWhenIdle(check);
    runWhenIdle(check);
    expect(check).not.toHaveBeenCalled();

    store.update((s) => ({ ...s, transform: transformDone }));
    await microtasks();
    expect(check).toHaveBeenCalledOnce();

    runWhenIdle(check);
    expect(check).toHaveBeenCalledTimes(2);
  });

  test("a task stays queued when the task before it started a new run", async () => {
    const store = createStore(busy);
    const runWhenIdle = whenIdle(store);
    const order: string[] = [];
    runWhenIdle(() => {
      order.push("first");
      store.update((s) => ({ ...s, transform: reading }));
    });
    runWhenIdle(() => order.push("second"));

    store.update((s) => ({ ...s, transform: transformDone }));
    await microtasks();
    expect(order).toEqual(["first"]);

    store.update((s) => ({ ...s, transform: transformDone }));
    await microtasks();
    expect(order).toEqual(["first", "second"]);
  });
});

const setAsr = (store: ReturnType<typeof createStore>, asr: AppState["models"]["asr"]) =>
  store.update((s) => ({ ...s, models: { ...s.models, asr } }));

describe("whenSpeechModelSettles", () => {
  const launching: AppState = {
    ...busy,
    transform: idleRun,
    models: { ...busy.models, asr: { state: "missing" } },
  };

  test("waits through the launch placeholder and the load, then runs once the model is ready", () => {
    vi.useFakeTimers();
    try {
      const store = createStore(launching);
      const task = vi.fn();
      whenSpeechModelSettles(store, 2000, task);
      setAsr(store, { state: "missing" });
      setAsr(store, { state: "loading" });
      expect(task).not.toHaveBeenCalled();

      setAsr(store, { state: "ready" });
      expect(task).toHaveBeenCalledOnce();

      setAsr(store, { state: "failed", message: "gone" });
      vi.advanceTimersByTime(5000);
      expect(task).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a failed load settles it too", () => {
    const store = createStore({
      ...launching,
      models: { ...launching.models, asr: { state: "loading" } },
    });
    const task = vi.fn();
    whenSpeechModelSettles(store, 2000, task);
    setAsr(store, { state: "failed", message: "Speech model failed to load" });
    expect(task).toHaveBeenCalledOnce();
  });

  test("a model that never settles runs the task at the timeout, and only then", () => {
    vi.useFakeTimers();
    try {
      const store = createStore(launching);
      const task = vi.fn();
      whenSpeechModelSettles(store, 2000, task);
      setAsr(store, { state: "loading", preparing: true });
      vi.advanceTimersByTime(1999);
      expect(task).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(task).toHaveBeenCalledOnce();

      setAsr(store, { state: "ready" });
      expect(task).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a model that is already ready runs the task at once", () => {
    const store = createStore({
      ...launching,
      models: { ...launching.models, asr: { state: "ready" } },
    });
    const task = vi.fn();
    whenSpeechModelSettles(store, 2000, task);
    expect(task).toHaveBeenCalledOnce();
  });
});
