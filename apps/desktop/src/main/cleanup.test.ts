import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import { S1_MINI_FILE, type CleanupStyle } from "@voice/cleanup";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import type { ModelStatus } from "../shared/api.ts";
import { createCleanup, type CleanupModule } from "./cleanup.ts";

const style: CleanupStyle = { styling: "formal", structure: "lists", context: "email" };

function fakeModule(behavior: { loadError?: string; downloadError?: string } = {}) {
  const calls = { downloads: 0, loads: 0, cleans: [] as [string, CleanupStyle][] };
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
        if (behavior.loadError) throw new Error(behavior.loadError);
      },
      async clean(raw, s) {
        calls.cleans.push([raw, s]);
        return raw.toUpperCase();
      },
      async dispose() {},
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
    await expect(cleanup.clean("hi", style)).rejects.toThrow("not ready");
  });

  test("load with a model file goes loading then ready and cleans with the style", async () => {
    await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
    const fake = fakeModule();
    const cleanup = createCleanup({ modelsDir: dir, onStatus: (s) => statuses.push(s), ...fake });
    await cleanup.load();
    expect(statuses).toEqual([{ state: "loading" }, { state: "ready" }]);
    await expect(cleanup.clean("hello", style)).resolves.toBe("HELLO");
    expect(fake.calls.cleans).toEqual([["hello", style]]);
  });

  test("a load failure reports failed with the error message", async () => {
    await writeFile(NodePath.join(dir, S1_MINI_FILE), "weights");
    const fake = fakeModule({ loadError: "bad gguf" });
    const cleanup = createCleanup({ modelsDir: dir, onStatus: (s) => statuses.push(s), ...fake });
    await cleanup.load();
    expect(statuses).toEqual([{ state: "loading" }, { state: "failed", message: "bad gguf" }]);
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
