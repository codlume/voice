import { access, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import { S1_MINI_FILE, type CleanupStyle } from "@voice/cleanup";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import type { ModelStatus, Settings } from "../shared/api.ts";
import { wantsCleanup, type DictationLanguage } from "../shared/dictation-language.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { createCleanup, type CleanupModule } from "./cleanup.ts";

const style: CleanupStyle = { styling: "formal" };
const signal = new AbortController().signal;

type Behavior = {
  loadError?: string;
  downloadError?: string;
  warmUpError?: string;
  downloadGate?: Promise<void>;
  loadGate?: Promise<void>;
  warmUpGate?: Promise<void>;
};

function fakeModule(behavior: Behavior = {}) {
  const calls = {
    downloads: 0,
    creates: 0,
    loads: 0,
    disposes: 0,
    cleans: [] as [string, CleanupStyle][],
    signals: [] as (AbortSignal | undefined)[],
  };
  const module: CleanupModule = {
    S1_MINI_FILE,
    async downloadS1Mini({ dir, onProgress }) {
      calls.downloads += 1;
      if (behavior.downloadError) throw new Error(behavior.downloadError);
      onProgress?.(0.5);
      await behavior.downloadGate;
      const path = NodePath.join(dir, S1_MINI_FILE);
      await writeFile(path, "weights");
      return path;
    },
    createS1Mini() {
      calls.creates += 1;
      return {
        async load() {
          calls.loads += 1;
          await behavior.loadGate;
          if (behavior.loadError) throw new Error(behavior.loadError);
        },
        async clean(raw, s, abort) {
          calls.cleans.push([raw, s]);
          calls.signals.push(abort);
          if (calls.cleans.length === 1) {
            await behavior.warmUpGate;
            if (behavior.warmUpError) throw new Error(behavior.warmUpError);
          }
          return raw.toUpperCase();
        },
        async dispose() {
          await behavior.loadGate;
          calls.disposes += 1;
        },
      };
    },
  };
  return { calls, loadModule: async () => module };
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
    createCleanup({ modelsDir: dir, shouldLoad, onStatus: (s) => statuses.push(s), ...fake });

  test("loadIfDownloaded without a model file reports missing and never loads a model", async () => {
    const fake = fakeModule();
    const cleanup = start(fake);
    await cleanup.loadIfDownloaded();
    expect(statuses).toEqual([{ state: "missing" }]);
    expect(fake.calls.loads).toBe(0);
    expect(cleanup.loaded()).toBe(false);
    await expect(cleanup.clean("hi", style, signal)).rejects.toThrow("not ready");
  });

  test("loadIfDownloaded with a model file goes loading then ready and cleans with the style", async () => {
    await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
    const fake = fakeModule();
    const cleanup = start(fake);
    await cleanup.loadIfDownloaded();
    expect(statuses).toEqual([{ state: "loading" }, { state: "ready" }]);
    await expect(cleanup.clean("hello", style, signal)).resolves.toBe("HELLO");
    expect(fake.calls.cleans.at(-1)).toEqual(["hello", style]);
  });

  test("clean hands the caller's abort signal to the model, so a budget stops the generation", async () => {
    await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
    const fake = fakeModule();
    const cleanup = start(fake);
    await cleanup.loadIfDownloaded();
    const controller = new AbortController();

    await cleanup.clean("hello", style, controller.signal);

    expect(fake.calls.signals.at(-1)).toBe(controller.signal);
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
    const session = cleanup.clean("hello", style, signal);

    finishWarmUp();
    await loading;
    expect(statuses).toEqual([{ state: "loading" }, { state: "ready" }]);
    await expect(session).resolves.toBe("HELLO");
    expect(fake.calls.cleans.map(([raw]) => raw)).toEqual([fake.calls.cleans[0]![0], "hello"]);
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

  test("a failed warm-up still reports ready with the model loaded", async () => {
    await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
    const fake = fakeModule({ warmUpError: "implausible output" });
    const cleanup = start(fake);
    await cleanup.loadIfDownloaded();
    expect(statuses).toEqual([{ state: "loading" }, { state: "ready" }]);
    await expect(cleanup.clean("hello", style, signal)).resolves.toBe("HELLO");
  });

  test("a load failure reports failed with the error message", async () => {
    await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
    const fake = fakeModule({ loadError: "bad gguf" });
    const cleanup = start(fake);
    await cleanup.loadIfDownloaded();
    expect(statuses).toEqual([{ state: "loading" }, { state: "failed", message: "bad gguf" }]);
    expect(fake.calls.cleans).toEqual([]);
    await expect(cleanup.clean("hi", style, signal)).rejects.toThrow();
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
      await expect(cleanup.clean("finish the English session", style, signal)).resolves.toBe(
        "FINISH THE ENGLISH SESSION",
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
    const disposing = cleanup.dispose();
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
    const disposing = cleanup.dispose();
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
    expect(statuses).toEqual([
      { state: "downloading", progress: 0 },
      { state: "downloading", progress: 0.5 },
      { state: "loading" },
      { state: "ready" },
    ]);
    await cleanup.install();
    expect(fake.calls.downloads).toBe(1);
  });

  test("a download failure reports failed and does not try to load", async () => {
    const fake = fakeModule({ downloadError: "offline" });
    const cleanup = start(fake);
    await cleanup.install();
    expect(statuses.at(-1)).toEqual({ state: "failed", message: "offline" });
    expect(fake.calls.loads).toBe(0);
  });

  describe("uninstall", () => {
    const modelPaths = () => {
      const file = NodePath.join(dir, S1_MINI_FILE);
      return [file, `${file}.LICENSE`, `${file}.NOTICE`, `${file}.part`];
    };
    const onDisk = async () =>
      (await readdir(dir)).filter((name) => name.startsWith(S1_MINI_FILE)).sort();

    test("removes the weights, legal files, and partial download, then reports missing", async () => {
      for (const path of modelPaths()) await writeFile(path, "bytes");
      await writeFile(NodePath.join(dir, "unrelated.bin"), "keep");
      const cleanup = start();

      await cleanup.uninstall();

      expect(await onDisk()).toEqual([]);
      expect(await readdir(dir)).toEqual(["unrelated.bin"]);
      expect(statuses).toEqual([{ state: "missing" }]);
    });

    test("succeeds twice in a row and with nothing on disk", async () => {
      await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
      const cleanup = start();

      await cleanup.uninstall();
      await cleanup.uninstall();

      expect(await onDisk()).toEqual([]);
      expect(statuses).toEqual([{ state: "missing" }, { state: "missing" }]);
    });

    test("frees a loaded model so cleaning stops", async () => {
      await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
      const fake = fakeModule();
      const cleanup = start(fake);
      await cleanup.loadIfDownloaded();

      await cleanup.uninstall();

      expect(fake.calls.disposes).toBe(1);
      expect(cleanup.loaded()).toBe(false);
      await expect(cleanup.clean("hi", style, signal)).rejects.toThrow("not ready");
      expect(statuses.at(-1)).toEqual({ state: "missing" });
    });

    test("removes a symlinked model without touching the file it points to", async () => {
      const cache = await mkdtemp(NodePath.join(tmpdir(), "voice-cleanup-cache-"));
      try {
        const cached = NodePath.join(cache, S1_MINI_FILE);
        await writeFile(cached, "weights");
        await symlink(cached, NodePath.join(dir, S1_MINI_FILE));
        const cleanup = start();

        await cleanup.uninstall();

        expect(await onDisk()).toEqual([]);
        await expect(readFile(cached, "utf8")).resolves.toBe("weights");
      } finally {
        await rm(cache, { recursive: true, force: true });
      }
    });
  });
});
