import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";

import { downloadModel, S1_MINI } from "./download.ts";

const BYTES = 256 * 1024;
const MODEL = Buffer.from(Array.from({ length: BYTES }, (_, i) => (i * 31 + 7) % 256));
const SHA256 = createHash("sha256").update(MODEL).digest("hex");
const CORRUPT = Buffer.from(MODEL.map((byte, i) => (i === BYTES / 2 ? byte ^ 1 : byte)));

type Behavior = "complete" | "short" | "stall" | "missing" | "corrupt";

let dir: string;
let behavior: Behavior;
let modelRequests: number;
let server: ReturnType<typeof createServer>;
let baseUrl: string;
const stalled: ServerResponse[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "voice-cleanup-download-"));
  behavior = "complete";
  modelRequests = 0;
  server = createServer((req, res) => {
    if (req.url === "/LICENSE" || req.url === "/NOTICE") return res.end(`${req.url} text`);
    modelRequests++;
    if (behavior === "missing") return res.writeHead(404).end();
    if (behavior === "short") return res.end(MODEL.subarray(0, BYTES - 10));
    if (behavior === "corrupt") return res.end(CORRUPT);
    if (behavior === "stall") {
      res.writeHead(200, { "content-length": BYTES });
      res.write(MODEL.subarray(0, BYTES / 2));
      stalled.push(res);
      return;
    }
    res.end(MODEL);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const res of stalled.splice(0)) res.destroy();
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

const download = (
  options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
) => downloadModel({ dir, baseUrl, file: "model.gguf", bytes: BYTES, sha256: SHA256, ...options });

test("downloads the model with its LICENSE and NOTICE and reports progress up to 1", async () => {
  const progress: number[] = [];

  const path = await download({ onProgress: (fraction) => progress.push(fraction) });

  expect(path).toBe(join(dir, "model.gguf"));
  expect((await readFile(path)).equals(MODEL)).toBe(true);
  expect(await readFile(join(dir, "model.gguf.LICENSE"), "utf8")).toBe("/LICENSE text");
  expect(await readFile(join(dir, "model.gguf.NOTICE"), "utf8")).toBe("/NOTICE text");
  expect(progress.at(-1)).toBe(1);
  expect(progress).toEqual(progress.toSorted((a, b) => a - b));
  expect(progress.length).toBeLessThanOrEqual(1001);
});

test("returns an existing complete model without a request", async () => {
  await download();
  modelRequests = 0;

  await expect(download()).resolves.toBe(join(dir, "model.gguf"));
  expect(modelRequests).toBe(0);
});

test("an aborted run leaves no model and the next run completes it", async () => {
  behavior = "stall";
  const controller = new AbortController();

  await expect(
    download({
      signal: controller.signal,
      onProgress: (fraction) => fraction > 0 && controller.abort(),
    }),
  ).rejects.toThrow(/abort/i);
  expect(await readdir(dir)).not.toContain("model.gguf");

  behavior = "complete";
  const path = await download();
  expect((await readFile(path)).equals(MODEL)).toBe(true);
});

test("a full-size .part left by a crash is never treated as complete", async () => {
  await writeFile(join(dir, "model.gguf.part"), Buffer.alloc(BYTES));

  const path = await download();

  expect(modelRequests).toBe(1);
  expect((await readFile(path)).equals(MODEL)).toBe(true);
  expect(await readdir(dir)).not.toContain("model.gguf.part");
});

test("rejects a size mismatch and keeps no model", async () => {
  behavior = "short";

  await expect(download()).rejects.toThrow(`returned ${BYTES - 10} bytes, expected ${BYTES}`);
  expect(await readdir(dir)).not.toContain("model.gguf");
  expect(await readdir(dir)).not.toContain("model.gguf.part");
});

test("replaces an existing model of the wrong size", async () => {
  await writeFile(join(dir, "model.gguf"), "truncated");

  const path = await download();

  expect((await readFile(path)).equals(MODEL)).toBe(true);
});

test("replaces an existing model of the right size whose content does not match the hash", async () => {
  await writeFile(join(dir, "model.gguf"), CORRUPT);

  const path = await download();

  expect(modelRequests).toBe(1);
  expect((await readFile(path)).equals(MODEL)).toBe(true);
});

test("rejects a download whose content does not match the hash and keeps no model", async () => {
  behavior = "corrupt";

  await expect(download()).rejects.toThrow("does not match the expected SHA-256");
  expect(await readdir(dir)).not.toContain("model.gguf");
  expect(await readdir(dir)).not.toContain("model.gguf.part");
});

test("rejects an HTTP error", async () => {
  behavior = "missing";

  await expect(download()).rejects.toThrow("HTTP 404");
});

test("S1-mini is pinned to a commit revision with a full SHA-256, never to a moving branch", () => {
  expect(S1_MINI.baseUrl).toMatch(/\/resolve\/[0-9a-f]{40}$/);
  expect(S1_MINI.sha256).toMatch(/^[0-9a-f]{64}$/);
});
