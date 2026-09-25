import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import { S1_MINI_FILE, type CleanupStyle } from "@voice/cleanup";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import type { ModelStatus } from "../shared/api.ts";
import { createCleanup, type CleanupModule } from "./cleanup.ts";

const style: CleanupStyle = { styling: "formal", structure: "lists", context: "email" };

type Behavior = {
  loadError?: string;
  downloadError?: string;
  warmUpError?: string;
  loadGate?: Promise<void>;
  warmUpGate?: Promise<void>;
};

function fakeModule(behavior: Behavior = {}) {
  const calls = { downloads: 0, loads: 0, disposes: 0, cleans: [] as [string, CleanupStyle][] };
  const module: CleanupModule = {
    S1_MINI_FILE,
    async downloadS1Mini({ dir, onProgress }) {
      calls.downloads += 1;
      if (behavior.downloadError) throw new Error(behavior.downloadError);
      onProgress?.(0.5);
      const path = NodePath.join(dir, S1_MINI_FILE);
      await writeFile(path, "weights");
      return path;
    },
    createS1Mini: () => ({
      async load() {
        calls.loads += 1;
        await behavior.loadGate;
        if (behavior.loadError) throw new Error(behavior.loadError);
      },
      async clean(raw, s) {
        calls.cleans.push([raw, s]);
        if (calls.cleans.length === 1) {
          await behavior.warmUpGate;
          if (behavior.warmUpError) throw new Error(behavior.warmUpError);
        }
        return raw.toUpperCase();
      },
      // Like the real adapter: a dispose during load settles after the load does.
      async dispose() {
        await behavior.loadGate;
        calls.disposes += 1;
      },
    }),
  };
  return { calls, loadModule: async () => module };
}

describe("createCleanup", () => {
  let dir: string;
  let statuses: ModelStatus[];
  beforeEach(async () => {
    dir = await mkdtemp(NodePath.join(tmpdir(), "voice-cleanup-"));
    statuses = [];
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  test("load without a model file reports missing and never loads a model", async () => {
    const fake = fakeModule();
    const cleanup = createCleanup({ modelsDir: dir, onStatus: (s) => statuses.push(s), ...fake });
    await cleanup.load();
    expect(statuses).toEqual([{ state: "missing" }]);
    expect(fake.calls.loads).toBe(0);
    expect(cleanup.loaded()).toBe(false);
    await expect(cleanup.clean("hi", style)).rejects.toThrow("not ready");
  });

  test("load with a model file goes loading then ready and cleans with the style", async () => {
    await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
    const fake = fakeModule();
    const cleanup = createCleanup({ modelsDir: dir, onStatus: (s) => statuses.push(s), ...fake });
    await cleanup.load();
    expect(statuses).toEqual([{ state: "loading" }, { state: "ready" }]);
    await expect(cleanup.clean("hello", style)).resolves.toBe("HELLO");
    expect(fake.calls.cleans.at(-1)).toEqual(["hello", style]);
  });

  test("reports ready only after a warm-up clean, and a clean during warm-up is not refused", async () => {
    await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
    let finishWarmUp!: () => void;
    const fake = fakeModule({ warmUpGate: new Promise((resolve) => (finishWarmUp = resolve)) });
    const cleanup = createCleanup({ modelsDir: dir, onStatus: (s) => statuses.push(s), ...fake });
    const loading = cleanup.load();
    await expect.poll(() => fake.calls.cleans.length).toBe(1);
    expect(statuses).toEqual([{ state: "loading" }]);
    expect(cleanup.loaded()).toBe(true);
    const session = cleanup.clean("hello", style);

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
    const cleanup = createCleanup({ modelsDir: dir, onStatus: (s) => statuses.push(s), ...fake });
    const loading = cleanup.load();
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
    const cleanup = createCleanup({ modelsDir: dir, onStatus: (s) => statuses.push(s), ...fake });
    await cleanup.load();
    expect(statuses).toEqual([{ state: "loading" }, { state: "ready" }]);
    await expect(cleanup.clean("hello", style)).resolves.toBe("HELLO");
  });

  test("a load failure reports failed with the error message", async () => {
    await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
    const fake = fakeModule({ loadError: "bad gguf" });
    const cleanup = createCleanup({ modelsDir: dir, onStatus: (s) => statuses.push(s), ...fake });
    await cleanup.load();
    expect(statuses).toEqual([{ state: "loading" }, { state: "failed", message: "bad gguf" }]);
    expect(fake.calls.cleans).toEqual([]);
    await expect(cleanup.clean("hi", style)).rejects.toThrow();
  });

  test("setup downloads with progress, loads, and a concurrent second call joins the first", async () => {
    const fake = fakeModule();
    const cleanup = createCleanup({ modelsDir: dir, onStatus: (s) => statuses.push(s), ...fake });
    await Promise.all([cleanup.setup(), cleanup.setup()]);
    expect(fake.calls.downloads).toBe(1);
    expect(fake.calls.loads).toBe(1);
    expect(statuses).toEqual([
      { state: "downloading", progress: 0 },
      { state: "downloading", progress: 0.5 },
      { state: "loading" },
      { state: "ready" },
    ]);
    await cleanup.setup();
    expect(fake.calls.downloads).toBe(1);
  });

  test("a download failure reports failed and does not try to load", async () => {
    const fake = fakeModule({ downloadError: "offline" });
    const cleanup = createCleanup({ modelsDir: dir, onStatus: (s) => statuses.push(s), ...fake });
    await cleanup.setup();
    expect(statuses.at(-1)).toEqual({ state: "failed", message: "offline" });
    expect(fake.calls.loads).toBe(0);
  });
});
