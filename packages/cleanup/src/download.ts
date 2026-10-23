import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import { APACHE_2_0_LICENSE } from "./apache-2.0.ts";

// Saved next to the weights as `${file}.${name}`. Downloaded from the source's base URL, or
// written from text Voice ships when the source repository has no such file.
export type LegalFile =
  | { name: "LICENSE" | "NOTICE"; from: "download" }
  | { name: "LICENSE" | "NOTICE"; from: "bundled"; text: string };

export type ModelSource = {
  baseUrl: string;
  file: string;
  bytes: number;
  sha256: string;
  legal: readonly LegalFile[];
};

export const S1_MINI_FILE = "s1-mini-q4_k_m.gguf";

// Pinned to a commit of superwhisper/s1-mini-GGUF rather than `main`, so the weights the app
// verifies against this hash cannot change under it.
export const S1_MINI: ModelSource = {
  baseUrl:
    "https://huggingface.co/superwhisper/s1-mini-GGUF/resolve/34add00a48a2e5d24e5a4ee5405a99620a3a240c",
  file: S1_MINI_FILE,
  bytes: 484_219_808,
  sha256: "3b41ebe2502cbd03e811d5d16b022f5ab551eda58d62597d152f89535003c634",
  // The Apache 2.0 naming clause requires shipping S1-mini's LICENSE and NOTICE with the weights.
  legal: [
    { name: "LICENSE", from: "download" },
    { name: "NOTICE", from: "download" },
  ],
};

// Gemma 4 is Apache 2.0, and the pinned unsloth/gemma-4-E2B-it-GGUF commit ships no LICENSE.
export const GEMMA_4_E2B: ModelSource = {
  baseUrl:
    "https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/0314792d7f1f7e229411f620751375812bb9faf2",
  file: "gemma-4-E2B-it-Q4_K_M.gguf",
  bytes: 3_106_738_272,
  sha256: "740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8",
  legal: [{ name: "LICENSE", from: "bundled", text: APACHE_2_0_LICENSE }],
};

type ModelOptions = { dir: string; source: ModelSource };

type DownloadOptions = ModelOptions & {
  // Overrides the source's base URL, as test mode does to serve the weights locally.
  baseUrl?: string | undefined;
  onProgress?: ((fraction: number) => void) | undefined;
  signal?: AbortSignal | undefined;
  stallTimeoutMs?: number | undefined;
};

const STALL_TIMEOUT_MS = 30_000;

// A stall, network error or abort keeps the weights' `.part`, and the next run resumes it.
export async function downloadModel({
  dir,
  source: { file, bytes, sha256, legal, ...source },
  baseUrl = source.baseUrl,
  onProgress,
  signal,
  stallTimeoutMs,
}: DownloadOptions): Promise<string> {
  const path = join(dir, file);
  if (await matches(path, bytes, sha256, signal)) return path;

  await mkdir(dir, { recursive: true });
  for (const entry of legal) {
    const legalPath = join(dir, `${file}.${entry.name}`);
    if (entry.from === "bundled") {
      await writeFile(legalPath, entry.text);
    } else {
      await fetchToFile(`${baseUrl}/${entry.name}`, legalPath, { signal, stallTimeoutMs });
    }
  }
  await fetchToFile(`${baseUrl}/${file}`, path, {
    expected: { bytes, sha256 },
    onProgress,
    signal,
    stallTimeoutMs,
  });
  return path;
}

// The download renames the weights into place last, so their presence means the install finished.
export async function findModel({ dir, source }: ModelOptions): Promise<string | undefined> {
  const path = join(dir, source.file);
  try {
    await access(path);
    return path;
  } catch {
    return undefined;
  }
}

export async function removeModel({ dir, source: { file, legal } }: ModelOptions): Promise<void> {
  const paths = [file, ...legal.map(({ name }) => `${file}.${name}`)].map((name) =>
    join(dir, name),
  );
  await Promise.all(
    paths.flatMap((path) => [path, `${path}.part`]).map((path) => rm(path, { force: true })),
  );
}

// Size first, because hashing gigabytes is the expensive half of the check.
async function matches(
  path: string,
  bytes: number,
  sha256: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  try {
    if ((await stat(path)).size !== bytes) return false;
  } catch {
    return false;
  }
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash, { signal });
  return hash.digest("hex") === sha256;
}

type Expected = Pick<ModelSource, "bytes" | "sha256">;

// Only a download with a known size and hash resumes, because only that one can be verified whole.
async function fetchToFile(
  url: string,
  path: string,
  {
    expected,
    onProgress,
    signal,
    stallTimeoutMs = STALL_TIMEOUT_MS,
  }: Pick<DownloadOptions, "onProgress" | "signal" | "stallTimeoutMs"> & { expected?: Expected },
): Promise<void> {
  const part = `${path}.part`;
  const kept = expected ? await keptBytes(part, expected.bytes) : 0;
  let hash = createHash("sha256");
  if (kept > 0) {
    for await (const chunk of createReadStream(part, { signal })) hash.update(chunk);
  }

  const stall = new AbortController();
  const timer = setTimeout(
    () => stall.abort(new Error("Download stalled. Check your connection and try again.")),
    stallTimeoutMs,
  );
  try {
    const response = await fetch(url, {
      signal: signal ? AbortSignal.any([signal, stall.signal]) : stall.signal,
      headers: kept > 0 ? { range: `bytes=${kept}-` } : {},
    });
    timer.refresh();
    // Nothing lies past the part, so the part is the whole file or it is damaged.
    if (kept > 0 && response.status === 416) {
      await response.body?.cancel();
      return await install(url, part, path, { received: kept, hash, expected });
    }
    if (!response.ok || !response.body)
      throw new Error(`Download of ${url} failed with HTTP ${response.status}`);
    const resumed = kept > 0 && response.status === 206;
    if (resumed && rangeStart(response) !== kept) {
      await response.body.cancel();
      await rm(part, { force: true });
      throw new Error(`Download of ${url} resumed at the wrong byte`);
    }
    // Any other success is the whole file from its first byte.
    if (!resumed) hash = createHash("sha256");

    let received = resumed ? kept : 0;
    let reported = -1;
    const report = () => {
      const percent = expected ? Math.floor((received / expected.bytes) * 100) : 0;
      if (onProgress && percent > reported) {
        reported = percent;
        onProgress(percent / 100);
      }
    };
    if (resumed) report();
    const handle = await open(part, resumed ? "a" : "w");
    try {
      for await (const chunk of response.body) {
        timer.refresh();
        await handle.write(chunk);
        hash.update(chunk);
        received += chunk.byteLength;
        if (expected && received > expected.bytes) break;
        report();
      }
      clearTimeout(timer);
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
    }
    await install(url, part, path, { received, hash, expected });
  } catch (error) {
    // fetch reports a refused or dropped connection as a TypeError such as "terminated".
    if (signal?.aborted || stall.signal.aborted || !(error instanceof TypeError)) throw error;
    throw new Error("Download interrupted. Check your connection and try again.", {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function keptBytes(part: string, bytes: number): Promise<number> {
  let size: number;
  try {
    size = (await stat(part)).size;
  } catch {
    return 0;
  }
  if (size <= bytes) return size;
  await rm(part, { force: true });
  return 0;
}

function rangeStart(response: Response): number | undefined {
  const start = /^bytes (\d+)-/.exec(response.headers.get("content-range") ?? "")?.[1];
  return start === undefined ? undefined : Number(start);
}

// A part of the wrong size or content is deleted, because resuming it would keep the damage.
async function install(
  url: string,
  part: string,
  path: string,
  { received, hash, expected }: { received: number; hash: Hash; expected: Expected | undefined },
): Promise<void> {
  if (expected) {
    const problem =
      received !== expected.bytes
        ? `returned ${received} bytes, expected ${expected.bytes}`
        : hash.digest("hex") !== expected.sha256
          ? "does not match the expected SHA-256"
          : undefined;
    if (problem) {
      await rm(part, { force: true });
      throw new Error(`Download of ${url} ${problem}`);
    }
  }
  await rename(part, path);
}
