import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { expect, it, vi } from "vite-plus/test";
import { StorageWorker } from "./storage";

it("startup timeout stays failed when a worker is released late", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-delayed-worker-"));
  const entry = join(directory, "worker.cjs");
  await writeFile(
    entry,
    `const { parentPort } = require('node:worker_threads');
parentPort.once('message', () => parentPort.postMessage({ type: 'ready', settings: { appearance: 'dark' } }));`,
  );
  const storage = new StorageWorker(
    { entry, filename: ":memory:", migrations: directory },
    () => {},
  );
  vi.useFakeTimers();
  try {
    const opening = storage.start();
    const rejected = expect(opening).rejects.toThrow("Settings storage unavailable");
    const worker = storage.worker!;
    await once(worker, "online");
    const delivered = new Promise<void>((resolve) => {
      worker.once("message", () => resolve());
      worker.once("exit", () => resolve());
    });
    vi.advanceTimersByTime(15_000);
    await rejected;
    worker.postMessage("release");
    await delivered;
    expect(storage.state).toBe("failed");
  } finally {
    vi.useRealTimers();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("closing a starting worker rejects its pending readiness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-closing-worker-"));
  const entry = join(directory, "worker.cjs");
  await writeFile(entry, `require('node:worker_threads').parentPort.on('message', () => {});`);
  const storage = new StorageWorker(
    { entry, filename: ":memory:", migrations: directory },
    () => {},
  );
  try {
    const opening = storage.start();
    const rejected = expect(opening).rejects.toThrow();
    await storage.close();
    await rejected;
  } finally {
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
