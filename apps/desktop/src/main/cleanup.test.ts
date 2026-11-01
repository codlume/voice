import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import type { CleanRequest, CleanupStyle } from "@voice/cleanup";
import { findModel, removeModel, S1_MINI, S1_MINI_FILE } from "@voice/cleanup/download";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { DEFAULT_SETTINGS, type ModelStatus, type Settings } from "../shared/api.ts";
import { wantsCleanup, type DictationLanguage } from "../shared/dictation-language.ts";
import { createCleanup, followSettings, type CleanupModule } from "./cleanup.ts";
import { createDictation } from "./dictation.ts";
import type { HelperCommand } from "./protocol.ts";
import { idle } from "./session.ts";
import { noMeetingFocus } from "./meeting-focus.ts";
import { idleRun } from "./transform-run.ts";
import { createStore } from "./store.ts";
import { noAutoApply } from "./testing/no-auto-apply.ts";

const style: CleanupStyle = { style: "veryCasual", layout: "email" };
const request: Required<CleanRequest> = { budgetMs: 1000, signal: new AbortController().signal };
const whole = (text: string) => ({ text, chunks: 1, cleaned: 1, queueMs: 0, generateMs: 0 });

type Behavior = {
  loadError?: string;
  createError?: string;
  downloadError?: string;
  removeError?: string;
  warmUpError?: string;
  moduleGate?: Promise<void>;
  downloadGate?: Promise<void>;
  loadGate?: Promise<void>;
  warmUpGate?: Promise<void>;
};

function fakeModule(behavior: Behavior = {}) {
  const calls = {
    downloads: 0,
    creates: 0,
    modelPaths: [] as string[],
    loads: 0,
    disposes: 0,
    cleans: [] as [string, CleanupStyle][],
    busy: [] as number[],
    requests: [] as (CleanRequest | undefined)[],
    downloadSignals: [] as (AbortSignal | undefined)[],
    lost: [] as ((message: string) => void)[],
  };
  const module: CleanupModule = {
    source: S1_MINI,
    findModel,
    async downloadModel({ dir, onProgress, signal: abort }) {
      calls.downloads += 1;
      calls.downloadSignals.push(abort);
      if (behavior.downloadError) throw new Error(behavior.downloadError);
      if (abort?.aborted) throw abort.reason;
      onProgress?.(0.5);
      await Promise.race([
        behavior.downloadGate,
        new Promise((_, reject) => abort?.addEventListener("abort", () => reject(abort.reason))),
      ]);
      const path = NodePath.join(dir, S1_MINI_FILE);
      await writeFile(path, "weights");
      return path;
    },
    async removeModel(options) {
      if (behavior.removeError) throw new Error(behavior.removeError);
      await removeModel(options);
    },
    createS1Mini({ modelPath, onLost }) {
      calls.creates += 1;
      if (behavior.createError) throw new Error(behavior.createError);
      calls.modelPaths.push(modelPath);
      calls.lost.push(onLost);
      return {
        async load() {
          calls.loads += 1;
          await behavior.loadGate;
          if (behavior.loadError) throw new Error(behavior.loadError);
        },
        keepGpuBusy(ms) {
          calls.busy.push(ms);
        },
        async clean(raw, s, cleanRequest) {
          calls.cleans.push([raw, s]);
          calls.requests.push(cleanRequest);
          if (calls.cleans.length === 1) {
            await behavior.warmUpGate;
            if (behavior.warmUpError) throw new Error(behavior.warmUpError);
          }
          return whole(raw.toUpperCase());
        },
        async dispose() {
          await behavior.loadGate;
          calls.disposes += 1;
        },
      };
    },
  };
  const loadModule = async () => {
    await behavior.moduleGate;
    return module;
  };
  return { calls, loadModule };
}

describe("createCleanup", () => {
  let dir: string;
  let statuses: ModelStatus[];
  let enabled: boolean;
  beforeEach(async () => {
    dir = await mkdtemp(NodePath.join(tmpdir(), "voice-cleanup-"));
    statuses = [];
    enabled = true;
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const start = (fake = fakeModule(), shouldLoad = () => enabled) =>
    createCleanup({
      modelsDir: dir,
      shouldLoad,
      onStatus: (s) => statuses.push(s),
      log: () => {},
      ...fake,
    });

  test("loadIfDownloaded without a model file reports missing and never loads a model", async () => {
    const fake = fakeModule();
    const cleanup = start(fake);
    await cleanup.loadIfDownloaded();
    expect(statuses).toEqual([{ state: "missing" }]);
    expect(fake.calls.loads).toBe(0);
    expect(cleanup.loaded()).toBe(false);
    await expect(cleanup.clean("hi", style, request)).rejects.toThrow("not ready");
  });

  test("loadIfDownloaded with a model file goes loading then ready and cleans with the style", async () => {
    await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
    const fake = fakeModule();
    const cleanup = start(fake);
    await cleanup.loadIfDownloaded();
    expect(statuses).toEqual([{ state: "loading" }, { state: "ready" }]);
    expect(fake.calls.modelPaths).toEqual([NodePath.join(dir, S1_MINI_FILE)]);
    await expect(cleanup.clean("hello", style, request)).resolves.toEqual(whole("HELLO"));
    expect(fake.calls.cleans.at(-1)).toEqual(["hello", style]);
  });

  test("clean hands the budget and the caller's abort signal to the model", async () => {
    await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
    const fake = fakeModule();
    const cleanup = start(fake);
    await cleanup.loadIfDownloaded();
    const controller = new AbortController();

    await cleanup.clean("hello", style, { budgetMs: 4200, signal: controller.signal });

    expect(fake.calls.requests.at(-1)?.budgetMs).toBe(4200);
    expect(fake.calls.requests.at(-1)?.signal).toBe(controller.signal);
  });

  test("reports ready only after a warm-up clean, and a clean during warm-up is not refused", async () => {
    await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
    let finishWarmUp!: () => void;
    const fake = fakeModule({ warmUpGate: new Promise((resolve) => (finishWarmUp = resolve)) });
    const cleanup = start(fake);
    const loading = cleanup.loadIfDownloaded();
    await expect.poll(() => fake.calls.cleans.length).toBe(1);
    expect(statuses).toEqual([{ state: "loading" }]);
    expect(cleanup.loaded()).toBe(true);
    const session = cleanup.clean("hello", style, request);

    finishWarmUp();
    await loading;
    expect(statuses).toEqual([{ state: "loading" }, { state: "ready" }]);
    await expect(session).resolves.toEqual(whole("HELLO"));
    expect(fake.calls.cleans.map(([raw]) => raw)).toEqual([fake.calls.cleans[0]![0], "hello"]);
    expect(fake.calls.requests).toEqual([undefined, request]);
  });

  test("the GPU busy loop is started and stopped only on a loaded model", async () => {
    await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
    let finishLoad!: () => void;
    const fake = fakeModule({ loadGate: new Promise((resolve) => (finishLoad = resolve)) });
    const cleanup = start(fake);
    const loading = cleanup.loadIfDownloaded();
    await expect.poll(() => fake.calls.loads).toBe(1);

    cleanup.keepGpuBusy();
    cleanup.letGpuIdle();
    expect(fake.calls.busy).toEqual([]);
    finishLoad();
    await loading;
    cleanup.keepGpuBusy();
    cleanup.letGpuIdle();
    expect(fake.calls.busy).toEqual([expect.any(Number), 0]);
    expect(fake.calls.busy[0]).toBeGreaterThan(0);

    enabled = false;
    await cleanup.unload();
    cleanup.keepGpuBusy();
    cleanup.letGpuIdle();
    expect(fake.calls.busy).toHaveLength(2);
  });

  test("dispose during load frees the model once it loads and never reports ready", async () => {
    await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
    let finishLoad!: () => void;
    const fake = fakeModule({ loadGate: new Promise((resolve) => (finishLoad = resolve)) });
    const cleanup = start(fake);
    const loading = cleanup.loadIfDownloaded();
    await expect.poll(() => statuses).toEqual([{ state: "loading" }]);

    const disposing = cleanup.dispose();
    finishLoad();
    await Promise.all([loading, disposing]);

    expect(fake.calls.disposes).toBe(1);
    expect(fake.calls.cleans).toEqual([]);
    expect(statuses).toEqual([{ state: "loading" }]);
    expect(cleanup.loaded()).toBe(false);
  });

  test("an engine lost after it was ready reloads on its own", async () => {
    await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
    const fake = fakeModule();
    const cleanup = start(fake);
    await cleanup.loadIfDownloaded();
    statuses = [];

    fake.calls.lost[0]!("The cleanup model stopped unexpectedly.");

    expect(cleanup.loaded()).toBe(false);
    await expect(cleanup.clean("hello", style, request)).rejects.toThrow("not ready");
    await expect.poll(() => statuses.at(-1)).toEqual({ state: "ready" });
    expect(statuses).toEqual([{ state: "loading" }, { state: "ready" }]);
    expect(fake.calls.creates).toBe(2);
    await expect(cleanup.clean("hello", style, request)).resolves.toEqual(whole("HELLO"));
    fake.calls.lost[0]!("late exit of the first engine");
    expect(statuses.at(-1)).toEqual({ state: "ready" });
    expect(cleanup.loaded()).toBe(true);
  });

  test("an engine lost after cleanup was turned off stays unloaded", async () => {
    await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
    const fake = fakeModule();
    let wanted = true;
    const cleanup = start(fake, () => wanted);
    await cleanup.loadIfDownloaded();
    wanted = false;
    statuses = [];

    fake.calls.lost[0]!("engine stopped");

    await expect.poll(() => statuses.at(-1)).toEqual({ state: "installed" });
    expect(fake.calls.creates).toBe(1);
    expect(cleanup.loaded()).toBe(false);
  });

  test("losing the engine during warm-up cannot restore ready", async () => {
    await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
    let finishWarmUp!: () => void;
    const fake = fakeModule({ warmUpGate: new Promise<void>((r) => (finishWarmUp = r)) });
    const cleanup = start(fake);
    const loading = cleanup.loadIfDownloaded();
    await vi.waitFor(() => expect(fake.calls.cleans).toHaveLength(1));
    fake.calls.lost[0]!("engine stopped");
    finishWarmUp();
    await loading;
    expect(statuses.at(-1)).toEqual({ state: "failed", message: "engine stopped" });
    expect(cleanup.loaded()).toBe(false);
  });

  test("a failed warm-up still reports ready with the model loaded", async () => {
    await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
    const fake = fakeModule({ warmUpError: "implausible output" });
    const cleanup = start(fake);
    await cleanup.loadIfDownloaded();
    expect(statuses).toEqual([{ state: "loading" }, { state: "ready" }]);
    await expect(cleanup.clean("hello", style, request)).resolves.toEqual(whole("HELLO"));
  });

  test("a failure to start the process reports failed and allows Retry", async () => {
    await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
    const behavior: Behavior = { createError: "cannot fork" };
    const fake = fakeModule(behavior);
    const cleanup = start(fake);
    await cleanup.loadIfDownloaded();
    expect(statuses.at(-1)).toEqual({ state: "failed", message: "cannot fork" });
    delete behavior.createError;
    await cleanup.install();
    expect(cleanup.loaded()).toBe(true);
    expect(statuses.at(-1)).toEqual({ state: "ready" });
  });

  test("a load failure reports failed with the error message", async () => {
    await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
    const fake = fakeModule({ loadError: "bad gguf" });
    const cleanup = start(fake);
    await cleanup.loadIfDownloaded();
    expect(statuses).toEqual([{ state: "loading" }, { state: "failed", message: "bad gguf" }]);
    expect(fake.calls.cleans).toEqual([]);
    expect(fake.calls.disposes).toBe(1);
    await expect(cleanup.clean("hi", style, request)).rejects.toThrow();
  });

  test.each(["auto", "pl"] satisfies DictationLanguage[])(
    "%s skips loading at startup, then English can load without another download",
    async (dictationLanguage) => {
      await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
      let settings: Settings = { ...DEFAULT_SETTINGS, dictationLanguage };
      const fake = fakeModule();
      const cleanup = start(fake, () => wantsCleanup(settings));
      await cleanup.loadIfDownloaded();
      expect(statuses).toEqual([{ state: "installed" }]);
      expect(fake.calls).toMatchObject({ downloads: 0, creates: 0 });
      settings = { ...settings, dictationLanguage: "en" };
      await cleanup.loadIfDownloaded();
      expect(cleanup.loaded()).toBe(true);
      expect(fake.calls).toMatchObject({ downloads: 0, loads: 1 });
      settings = { ...settings, dictationLanguage };
      await cleanup.loadIfDownloaded();
      await expect(cleanup.clean("finish the English session", style, request)).resolves.toEqual(
        whole("FINISH THE ENGLISH SESSION"),
      );
      expect(fake.calls).toMatchObject({ downloads: 0, loads: 1, disposes: 0 });
      await cleanup.dispose();
    },
  );

  test.each([
    ["installed", true],
    ["missing", false],
  ] as const)(
    "with cleanup switched off, loadIfDownloaded reports %s by file presence and never creates a model",
    async (state, onDisk) => {
      if (onDisk) await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
      enabled = false;
      const fake = fakeModule();
      const cleanup = start(fake);

      await cleanup.loadIfDownloaded();

      expect(statuses).toEqual([{ state }]);
      expect(fake.calls).toMatchObject({ downloads: 0, creates: 0 });
      expect(cleanup.loaded()).toBe(false);
    },
  );

  test("install with cleanup switched off downloads, ends installed, and never creates a model", async () => {
    enabled = false;
    const fake = fakeModule();
    const cleanup = start(fake);

    await cleanup.install();

    expect(statuses).toEqual([
      { state: "downloading", progress: 0 },
      { state: "downloading", progress: 0.5 },
      { state: "installed" },
    ]);
    expect(fake.calls).toMatchObject({ downloads: 1, creates: 0 });
    await expect(access(NodePath.join(dir, S1_MINI_FILE))).resolves.toBeUndefined();
  });

  test("switching cleanup off frees the loaded model and ends installed, not ready", async () => {
    await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
    const fake = fakeModule();
    const cleanup = start(fake);
    await cleanup.loadIfDownloaded();

    enabled = false;
    await cleanup.unload();

    expect(fake.calls.disposes).toBe(1);
    expect(cleanup.loaded()).toBe(false);
    expect(statuses.at(-1)).toEqual({ state: "installed" });
  });

  test("switching cleanup off during a download keeps the file but never loads it, and switching on loads it", async () => {
    let finishDownload!: () => void;
    const fake = fakeModule({ downloadGate: new Promise((resolve) => (finishDownload = resolve)) });
    const cleanup = start(fake);
    const downloading = cleanup.install();
    await expect.poll(() => fake.calls.downloads).toBe(1);

    enabled = false;
    const disposing = cleanup.unload();
    finishDownload();
    await Promise.all([downloading, disposing]);
    expect(fake.calls.loads).toBe(0);
    expect(cleanup.loaded()).toBe(false);
    expect(statuses.at(-1)).toEqual({ state: "installed" });

    enabled = true;
    await cleanup.loadIfDownloaded();
    expect(fake.calls).toMatchObject({ downloads: 1, loads: 1 });
    expect(cleanup.loaded()).toBe(true);
    expect(statuses.at(-1)).toEqual({ state: "ready" });
  });

  test("switching cleanup off and on during a load frees the first model, then loads a second", async () => {
    await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
    let finishLoad!: () => void;
    const fake = fakeModule({ loadGate: new Promise((resolve) => (finishLoad = resolve)) });
    const cleanup = start(fake);
    const first = cleanup.loadIfDownloaded();
    await expect.poll(() => statuses).toEqual([{ state: "loading" }]);

    enabled = false;
    const disposing = cleanup.unload();
    enabled = true;
    const second = cleanup.loadIfDownloaded();
    finishLoad();
    await Promise.all([first, disposing, second]);

    expect(fake.calls).toMatchObject({ loads: 2, disposes: 1 });
    expect(cleanup.loaded()).toBe(true);
    expect(statuses).toEqual([{ state: "loading" }, { state: "loading" }, { state: "ready" }]);
  });

  test("install downloads with progress, loads, and a concurrent second call does not download again", async () => {
    const fake = fakeModule();
    const cleanup = start(fake);
    await Promise.all([cleanup.install(), cleanup.install()]);
    expect(fake.calls.downloads).toBe(1);
    expect(fake.calls.loads).toBe(1);
    expect(fake.calls.modelPaths).toEqual([NodePath.join(dir, S1_MINI_FILE)]);
    expect(statuses).toEqual([
      { state: "downloading", progress: 0 },
      { state: "downloading", progress: 0.5 },
      { state: "loading" },
      { state: "ready" },
    ]);
    await cleanup.install();
    expect(fake.calls.downloads).toBe(1);
  });

  test("dispose during a download stops the download instead of waiting for it", async () => {
    const fake = fakeModule({ downloadGate: new Promise(() => {}) });
    const cleanup = start(fake);
    const installing = cleanup.install();
    await expect.poll(() => fake.calls.downloads).toBe(1);

    const disposing = cleanup.dispose();

    expect(fake.calls.downloadSignals[0]?.aborted).toBe(true);
    await Promise.all([installing, disposing]);
    expect(fake.calls.loads).toBe(0);
    expect(cleanup.loaded()).toBe(false);
  });

  test("uninstall during a download cancels it, ends missing without failed, and a later install downloads again", async () => {
    const behavior: Behavior = { downloadGate: new Promise(() => {}) };
    const fake = fakeModule(behavior);
    const cleanup = start(fake);
    const installing = cleanup.install();
    await expect.poll(() => fake.calls.downloads).toBe(1);

    const uninstalling = cleanup.uninstall();

    expect(fake.calls.downloadSignals[0]?.aborted).toBe(true);
    await Promise.all([installing, uninstalling]);
    expect(statuses.map((status) => status.state)).toEqual([
      "downloading",
      "downloading",
      "missing",
    ]);
    expect(fake.calls.loads).toBe(0);
    expect(await readdir(dir)).toEqual([]);

    delete behavior.downloadGate;
    await cleanup.install();
    expect(fake.calls.downloads).toBe(2);
    expect(statuses.at(-1)).toEqual({ state: "ready" });
  });

  test("a cancel that lands while the row shows Downloading but the module is still loading is honored", async () => {
    let finishModule!: () => void;
    const fake = fakeModule({ moduleGate: new Promise((resolve) => (finishModule = resolve)) });
    const cleanup = start(fake);
    const installing = cleanup.install();
    await expect.poll(() => statuses).toEqual([{ state: "downloading", progress: 0 }]);

    const uninstalling = cleanup.uninstall();
    finishModule();
    await Promise.all([installing, uninstalling]);

    expect(fake.calls.downloads).toBe(0);
    expect(fake.calls.loads).toBe(0);
    expect(statuses.map((status) => status.state)).not.toContain("failed");
    expect(statuses.at(-1)).toEqual({ state: "missing" });
  });

  test("uninstall with a second install queued cancels both, ends missing, and downloads once", async () => {
    let finishDownload!: () => void;
    const fake = fakeModule({ downloadGate: new Promise((resolve) => (finishDownload = resolve)) });
    const cleanup = start(fake);
    const first = cleanup.install();
    const second = cleanup.install();
    await expect.poll(() => fake.calls.downloads).toBe(1);

    const uninstalling = cleanup.uninstall();
    finishDownload();
    await Promise.all([first, second, uninstalling]);

    expect(fake.calls.downloads).toBe(1);
    expect(fake.calls.loads).toBe(0);
    expect(statuses.map((status) => status.state)).not.toContain("failed");
    expect(statuses.at(-1)).toEqual({ state: "missing" });
    expect(await readdir(dir)).toEqual([]);
  });

  test("dispose with a second install queued starts no second download", async () => {
    let finishDownload!: () => void;
    const fake = fakeModule({ downloadGate: new Promise((resolve) => (finishDownload = resolve)) });
    const cleanup = start(fake);
    const first = cleanup.install();
    const second = cleanup.install();
    await expect.poll(() => fake.calls.downloads).toBe(1);

    const disposing = cleanup.dispose();
    finishDownload();
    await Promise.all([first, second, disposing]);

    expect(fake.calls.downloads).toBe(1);
    expect(fake.calls.loads).toBe(0);
    expect(statuses.map((status) => status.state)).not.toContain("failed");
  });

  test("a cancel that lands as the download finishes never flashes installed", async () => {
    enabled = false;
    let finishDownload!: () => void;
    const fake = fakeModule({ downloadGate: new Promise((resolve) => (finishDownload = resolve)) });
    const cleanup = start(fake);
    const installing = cleanup.install();
    await expect.poll(() => fake.calls.downloads).toBe(1);

    finishDownload();
    const uninstalling = cleanup.uninstall();
    await Promise.all([installing, uninstalling]);

    expect(statuses.map((status) => status.state)).not.toContain("installed");
    expect(statuses.at(-1)).toEqual({ state: "missing" });
    expect(await readdir(dir)).toEqual([]);
  });

  test("a download failure reports failed and does not try to load", async () => {
    const fake = fakeModule({ downloadError: "offline" });
    const cleanup = start(fake);
    await cleanup.install();
    expect(statuses.at(-1)).toEqual({ state: "failed", message: "offline" });
    expect(fake.calls.loads).toBe(0);
  });

  describe("uninstall", () => {
    test("removes the model files, then reports missing, and succeeds again with nothing on disk", async () => {
      await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
      await writeFile(NodePath.join(dir, `${S1_MINI_FILE}.LICENSE`), "license");
      await writeFile(NodePath.join(dir, "unrelated.bin"), "keep");
      const cleanup = start();

      await cleanup.uninstall();
      await cleanup.uninstall();

      expect(await readdir(dir)).toEqual(["unrelated.bin"]);
      expect(statuses).toEqual([{ state: "missing" }, { state: "missing" }]);
    });

    test("a removal failure reports failed with the error message", async () => {
      const cleanup = start(fakeModule({ removeError: "permission denied" }));

      await cleanup.uninstall();

      expect(statuses).toEqual([{ state: "failed", message: "permission denied" }]);
    });

    test("frees a loaded model so cleaning stops", async () => {
      await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
      const fake = fakeModule();
      const cleanup = start(fake);
      await cleanup.loadIfDownloaded();

      await cleanup.uninstall();

      expect(fake.calls.disposes).toBe(1);
      expect(cleanup.loaded()).toBe(false);
      await expect(cleanup.clean("hi", style, request)).rejects.toThrow("not ready");
      expect(statuses.at(-1)).toEqual({ state: "missing" });
    });
  });
});

describe("followSettings", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(NodePath.join(tmpdir(), "voice-cleanup-"));
    await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  function app() {
    const store = createStore({
      updates: {
        version: "0.0.1",
        installedChannel: "stable",
        channel: "stable",
        status: { kind: "disabled", reason: "Test" },
      },
      session: idle,
      transform: idleRun,
      meeting: noMeetingFocus,
      permissions: {
        microphone: "granted",
        accessibility: "granted",
        systemAudio: "notDetermined",
      },
      speakerModel: "ready",
      loginItem: "off",
      models: {
        asr: { state: "ready" },
        cleanup: { state: "missing" },
        transform: { state: "missing" },
      },
      settings: { ...DEFAULT_SETTINGS, dictationLanguage: "en" },
      microphones: { kind: "loading" },
      microphoneTest: { kind: "off" },
      account: { kind: "signedOut" },
    });
    const cleanup = createCleanup({
      modelsDir: dir,
      shouldLoad: () => wantsCleanup(store.state.settings),
      onStatus: (status) =>
        store.update((s) => ({ ...s, models: { ...s.models, cleanup: status } })),
      log: () => {},
      ...fakeModule(),
    });
    store.subscribe((state, previous) => followSettings(cleanup, state, previous));
    const commands: HelperCommand[] = [];
    let clock = 0;
    const dictation = createDictation({
      store,
      send: (command) => commands.push(command),
      cleanup,
      transform: noAutoApply,
      onLevel: () => {},
      log: () => {},
      onSessionDone: () => {},
      onDictated: () => {},
      history: { remember: () => {}, settle: () => {} },
      copy: async () => {},
      now: () => clock,
    });
    const setLanguage = (dictationLanguage: DictationLanguage) =>
      store.update((s) => ({ ...s, settings: { ...s.settings, dictationLanguage } }));
    const record = () => {
      dictation.onHelperEvent({ type: "hotkey", action: "down", uptimeMs: null });
      const session = store.state.session;
      if (session.phase === "idle") throw new Error("no session");
      dictation.onHelperEvent({
        type: "capture.started",
        id: session.id,
        startMs: 40,
        relayMs: null,
        asrState: null,
      });
      return session.id;
    };
    const finish = (id: string, text: string) => {
      clock += 800;
      dictation.onHelperEvent({ type: "hotkey", action: "up", uptimeMs: null });
      dictation.onHelperEvent({
        type: "transcript",
        id,
        text,
        audioMs: 800,
        asrMs: 100,
        speechMs: 600,
        relayMs: null,
        target: null,
      });
    };
    return { store, cleanup, commands, dictation, setLanguage, record, finish };
  }

  test.each(["pl", "auto"] satisfies DictationLanguage[])(
    "switching English to %s mid-session cleans that session, then unloads the model",
    async (language) => {
      const a = app();
      await a.cleanup.loadIfDownloaded();
      const id = a.record();
      a.setLanguage(language);
      a.finish(id, "first");

      await expect
        .poll(() => a.commands.at(-1))
        .toEqual({
          type: "insert",
          id,
          text: "FIRST",
          html: null,
          keepOnClipboard: false,
        });
      expect(a.store.state.models.cleanup.state).toBe("ready");
      a.dictation.onHelperEvent({
        type: "insert.result",
        id,
        method: "paste",
        route: "forced",
        clipboardSaveMs: null,
      });
      await expect.poll(() => a.store.state.models.cleanup.state).toBe("installed");
      expect(a.cleanup.loaded()).toBe(false);
    },
  );
});
