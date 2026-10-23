import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";

import { APACHE_2_0_LICENSE } from "./apache-2.0.ts";
import {
  downloadModel,
  findModel,
  GEMMA_4_E2B,
  removeModel,
  S1_MINI,
  type LegalFile,
  type ModelSource,
} from "./download.ts";

const BYTES = 256 * 1024;
const MODEL = Buffer.from(Array.from({ length: BYTES }, (_, i) => (i * 31 + 7) % 256));
const SHA256 = createHash("sha256").update(MODEL).digest("hex");
const TRICKLE_CHUNK = 1024;
const CORRUPT = Buffer.from(MODEL.map((byte, i) => (i === BYTES / 2 ? byte ^ 1 : byte)));

type Behavior =
  | "complete"
  | "ignoreRange"
  | "trickle"
  | "short"
  | "stall"
  | "drop"
  | "silent"
  | "missing"
  | "corrupt";

let dir: string;
let behavior: Behavior;
let modelRequests: number;
let legalRequests: string[];
let ranges: (string | undefined)[];
let servedBytes: number;
let server: ReturnType<typeof createServer>;
let baseUrl: string;
const stalled: ServerResponse[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "voice-cleanup-download-"));
  behavior = "complete";
  modelRequests = 0;
  legalRequests = [];
  ranges = [];
  servedBytes = 0;
  server = createServer((req, res) => {
    if (req.url === "/LICENSE" || req.url === "/NOTICE") {
      legalRequests.push(req.url);
      return res.end(`${req.url} text`);
    }
    modelRequests++;
    ranges.push(req.headers.range);
    // Honours `Range: bytes=<start>-` the way Hugging Face's CDN does, unless told to ignore it.
    const start = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? "")?.[1] ?? 0);
    const send = (body: Buffer) => {
      if (start === 0 || behavior === "ignoreRange") {
        servedBytes += body.byteLength;
        return res.end(body);
      }
      if (start >= body.byteLength) {
        return res.writeHead(416, { "content-range": `bytes */${body.byteLength}` }).end();
      }
      servedBytes += body.byteLength - start;
      res.writeHead(206, {
        "content-range": `bytes ${start}-${body.byteLength - 1}/${body.byteLength}`,
      });
      return res.end(body.subarray(start));
    };
    if (behavior === "missing") return res.writeHead(404).end();
    if (behavior === "short") return send(MODEL.subarray(0, BYTES - 10));
    if (behavior === "corrupt") return send(CORRUPT);
    if (behavior === "trickle") {
      void (async () => {
        for (let i = 0; i < BYTES; i += TRICKLE_CHUNK) {
          res.write(MODEL.subarray(i, i + TRICKLE_CHUNK));
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        res.end();
      })();
      return;
    }
    if (behavior === "stall") {
      res.writeHead(200, { "content-length": BYTES });
      res.write(MODEL.subarray(0, BYTES / 2));
      stalled.push(res);
      return;
    }
    if (behavior === "drop") {
      res.writeHead(200, { "content-length": BYTES });
      res.write(MODEL.subarray(0, BYTES / 2), () => res.destroy());
      return;
    }
    if (behavior === "silent") {
      stalled.push(res);
      return;
    }
    send(MODEL);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const res of stalled.splice(0)) res.destroy();
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

const LICENSE_AND_NOTICE: readonly LegalFile[] = [
  { name: "LICENSE", from: "download" },
  { name: "NOTICE", from: "download" },
];
const source = (legal = LICENSE_AND_NOTICE): ModelSource => ({
  baseUrl: "unused",
  file: "model.gguf",
  bytes: BYTES,
  sha256: SHA256,
  legal,
});

const download = ({
  legal,
  ...options
}: {
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  stallTimeoutMs?: number;
  legal?: readonly LegalFile[];
} = {}) => downloadModel({ dir, source: source(legal), baseUrl, ...options });

test("downloads the model with its LICENSE and NOTICE and reports progress up to 1", async () => {
  const progress: number[] = [];

  const path = await download({ onProgress: (fraction) => progress.push(fraction) });

  expect(path).toBe(join(dir, "model.gguf"));
  expect((await readFile(path)).equals(MODEL)).toBe(true);
  expect(await readFile(join(dir, "model.gguf.LICENSE"), "utf8")).toBe("/LICENSE text");
  expect(await readFile(join(dir, "model.gguf.NOTICE"), "utf8")).toBe("/NOTICE text");
  expect(progress.at(-1)).toBe(1);
  expect(progress).toEqual(progress.toSorted((a, b) => a - b));
});

test("a download in many small chunks reports progress at most once per whole percent", async () => {
  behavior = "trickle";
  const progress: number[] = [];

  await download({ onProgress: (fraction) => progress.push(fraction) });

  expect(progress.at(-1)).toBe(1);
  expect(progress.length).toBeLessThanOrEqual(101);
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

test("a download that stops sending bytes rejects as stalled, keeps the .part, and the next run resumes it", async () => {
  behavior = "stall";

  await expect(download({ stallTimeoutMs: 100 })).rejects.toThrow(/stalled/);
  expect(await readdir(dir)).not.toContain("model.gguf");
  expect((await stat(join(dir, "model.gguf.part"))).size).toBe(BYTES / 2);

  behavior = "complete";
  servedBytes = 0;
  const progress: number[] = [];
  const path = await download({ onProgress: (fraction) => progress.push(fraction) });

  expect((await readFile(path)).equals(MODEL)).toBe(true);
  expect(ranges.at(-1)).toBe(`bytes=${BYTES / 2}-`);
  expect(servedBytes).toBe(BYTES / 2);
  expect(progress[0]).toBe(0.5);
  expect(progress.at(-1)).toBe(1);
  expect(await readdir(dir)).not.toContain("model.gguf.part");
}, 2_000);

test("a dropped connection rejects as interrupted, keeps the .part, and the next run resumes it", async () => {
  behavior = "drop";

  await expect(download()).rejects.toThrow(
    "Download interrupted. Check your connection and try again.",
  );
  expect((await stat(join(dir, "model.gguf.part"))).size).toBeGreaterThan(0);

  behavior = "complete";
  const path = await download();
  expect(ranges.at(-1)).toMatch(/^bytes=\d+-$/);
  expect((await readFile(path)).equals(MODEL)).toBe(true);
});

test("a server that ignores Range sends the whole file again, which replaces the .part", async () => {
  await writeFile(join(dir, "model.gguf.part"), Buffer.alloc(BYTES / 2, 0xff));
  behavior = "ignoreRange";

  const path = await download();

  expect(ranges).toEqual([`bytes=${BYTES / 2}-`]);
  expect((await readFile(path)).equals(MODEL)).toBe(true);
});

test("a resumed .part whose kept bytes are damaged is deleted, and the next run starts over", async () => {
  await writeFile(join(dir, "model.gguf.part"), CORRUPT.subarray(0, BYTES * 0.75));

  await expect(download()).rejects.toThrow("does not match the expected SHA-256");
  expect(ranges).toEqual([`bytes=${BYTES * 0.75}-`]);
  expect(await readdir(dir)).not.toContain("model.gguf");
  expect(await readdir(dir)).not.toContain("model.gguf.part");

  const path = await download();
  expect(ranges.at(-1)).toBeUndefined();
  expect((await readFile(path)).equals(MODEL)).toBe(true);
});

test("a complete .part left by a crash is verified and moved into place without its bytes again", async () => {
  await writeFile(join(dir, "model.gguf.part"), MODEL);

  const path = await download();

  expect(ranges).toEqual([`bytes=${BYTES}-`]);
  expect(servedBytes).toBe(0);
  expect((await readFile(path)).equals(MODEL)).toBe(true);
  expect(await readdir(dir)).not.toContain("model.gguf.part");
});

test("the stall timeout is idle time, not total time: a trickle that outlasts it still completes", async () => {
  behavior = "trickle";
  const started = performance.now();

  const path = await download({ stallTimeoutMs: 150 });

  expect(performance.now() - started).toBeGreaterThan(150);
  expect((await readFile(path)).equals(MODEL)).toBe(true);
}, 5_000);

test("a server that never answers with headers rejects as stalled", async () => {
  behavior = "silent";

  await expect(download({ stallTimeoutMs: 100 })).rejects.toThrow(/stalled/);
  expect(await readdir(dir)).not.toContain("model.gguf.part");
}, 2_000);

test("a run cancelled before the check of an existing model rejects, requests nothing, and leaves the model on disk", async () => {
  await download();
  modelRequests = 0;
  const controller = new AbortController();
  controller.abort();

  await expect(download({ signal: controller.signal })).rejects.toThrow(/abort/i);
  expect(modelRequests).toBe(0);
  expect(await readdir(dir)).toContain("model.gguf");
});

test("a full-size .part of the wrong content is never treated as complete", async () => {
  await writeFile(join(dir, "model.gguf.part"), Buffer.alloc(BYTES));

  await expect(download()).rejects.toThrow("does not match the expected SHA-256");
  expect(await readdir(dir)).not.toContain("model.gguf");
  expect(await readdir(dir)).not.toContain("model.gguf.part");

  const path = await download();
  expect((await readFile(path)).equals(MODEL)).toBe(true);
});

test("a source with a bundled license writes its text and fetches no legal file", async () => {
  const path = await download({
    legal: [{ name: "LICENSE", from: "bundled", text: "bundled license" }],
  });

  expect((await readFile(path)).equals(MODEL)).toBe(true);
  expect(await readFile(join(dir, "model.gguf.LICENSE"), "utf8")).toBe("bundled license");
  expect(legalRequests).toEqual([]);
  expect((await readdir(dir)).toSorted()).toEqual(["model.gguf", "model.gguf.LICENSE"]);
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

test("removeModel deletes everything a download wrote and keeps other files", async () => {
  await download();
  await writeFile(join(dir, "other.gguf"), "keep");

  await removeModel({ dir, source: source() });

  expect(await readdir(dir)).toEqual(["other.gguf"]);
});

test("removeModel deletes partial downloads left by a crash and succeeds again with nothing left", async () => {
  for (const name of ["model.gguf.part", "model.gguf.LICENSE.part", "model.gguf.NOTICE.part"]) {
    await writeFile(join(dir, name), "partial");
  }

  await removeModel({ dir, source: source() });
  await removeModel({ dir, source: source() });

  expect(await readdir(dir)).toEqual([]);
});

test("removeModel unlinks a symlinked model without touching the file it points to", async () => {
  const cache = await mkdtemp(join(tmpdir(), "voice-cleanup-cache-"));
  try {
    await writeFile(join(cache, "model.gguf"), "weights");
    await symlink(join(cache, "model.gguf"), join(dir, "model.gguf"));

    await removeModel({ dir, source: source() });

    expect(await readdir(dir)).toEqual([]);
    expect(await readFile(join(cache, "model.gguf"), "utf8")).toBe("weights");
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});

test("removeModel deletes the legal files its source lists", async () => {
  const gemma = source([{ name: "LICENSE", from: "bundled", text: "license" }]);
  await download({ legal: gemma.legal });

  await removeModel({ dir, source: gemma });

  expect(await readdir(dir)).toEqual([]);
});

test("findModel finds a source's weights only once a download has renamed them into place", async () => {
  for (const name of ["model.gguf.part", "model.gguf.LICENSE", "model.gguf.NOTICE"]) {
    await writeFile(join(dir, name), "partial");
  }
  await expect(findModel({ dir, source: source() })).resolves.toBeUndefined();

  await writeFile(join(dir, "model.gguf"), "weights");

  await expect(findModel({ dir, source: source() })).resolves.toBe(join(dir, "model.gguf"));
});

test.each([S1_MINI, GEMMA_4_E2B])(
  "$file is pinned to a commit revision with a full SHA-256, never to a moving branch",
  (model) => {
    expect(model.baseUrl).toMatch(/\/resolve\/[0-9a-f]{40}$/);
    expect(model.sha256).toMatch(/^[0-9a-f]{64}$/);
  },
);

test("S1-mini downloads its LICENSE and NOTICE, and Gemma ships the canonical Apache 2.0 text", () => {
  expect(S1_MINI.legal).toEqual(LICENSE_AND_NOTICE);
  expect(GEMMA_4_E2B.legal).toEqual([
    { name: "LICENSE", from: "bundled", text: APACHE_2_0_LICENSE },
  ]);
  // The SHA-256 of https://www.apache.org/licenses/LICENSE-2.0.txt.
  expect(createHash("sha256").update(APACHE_2_0_LICENSE).digest("hex")).toBe(
    "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
  );
});
