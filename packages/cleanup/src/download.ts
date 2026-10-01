import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

export const S1_MINI_FILE = "s1-mini-q4_k_m.gguf";

// Pinned to a commit of superwhisper/s1-mini-GGUF rather than `main`, so the weights the app
// verifies against this hash cannot change under it.
export const S1_MINI = {
  baseUrl:
    "https://huggingface.co/superwhisper/s1-mini-GGUF/resolve/34add00a48a2e5d24e5a4ee5405a99620a3a240c",
  file: S1_MINI_FILE,
  bytes: 484_219_808,
  sha256: "3b41ebe2502cbd03e811d5d16b022f5ab551eda58d62597d152f89535003c634",
};

export type ModelSource = { baseUrl: string; file: string; bytes: number; sha256: string };

export type DownloadOptions = {
  dir: string;
  onProgress?: ((fraction: number) => void) | undefined;
  signal?: AbortSignal | undefined;
};

export function downloadS1Mini(options: DownloadOptions): Promise<string> {
  return downloadModel({ ...options, ...S1_MINI });
}

// The Apache 2.0 naming clause requires shipping S1-mini's LICENSE and NOTICE with the weights.
const LEGAL_FILES = ["LICENSE", "NOTICE"] as const;

export async function downloadModel({
  dir,
  baseUrl,
  file,
  bytes,
  sha256,
  onProgress,
  signal,
}: DownloadOptions & ModelSource): Promise<string> {
  const path = join(dir, file);
  if (await matches(path, bytes, sha256)) return path;

  await mkdir(dir, { recursive: true });
  for (const name of LEGAL_FILES) {
    await fetchToFile(`${baseUrl}/${name}`, join(dir, `${file}.${name}`), { signal });
  }
  await fetchToFile(`${baseUrl}/${file}`, path, { bytes, sha256, onProgress, signal });
  return path;
}

export function removeS1Mini({ dir }: Pick<DownloadOptions, "dir">): Promise<void> {
  return removeModel({ dir, file: S1_MINI_FILE });
}

export async function removeModel({ dir, file }: { dir: string; file: string }): Promise<void> {
  const paths = [file, ...LEGAL_FILES.map((name) => `${file}.${name}`)].map((name) =>
    join(dir, name),
  );
  await Promise.all(
    paths.flatMap((path) => [path, `${path}.part`]).map((path) => rm(path, { force: true })),
  );
}

// Size first, because hashing half a gigabyte is the expensive half of the check.
async function matches(path: string, bytes: number, sha256: string): Promise<boolean> {
  try {
    if ((await stat(path)).size !== bytes) return false;
  } catch {
    return false;
  }
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex") === sha256;
}

async function fetchToFile(
  url: string,
  path: string,
  {
    bytes,
    sha256,
    onProgress,
    signal,
  }: Omit<DownloadOptions, "dir"> & Partial<Pick<ModelSource, "bytes" | "sha256">>,
): Promise<void> {
  const response = await fetch(url, { signal: signal ?? null });
  if (!response.ok || !response.body)
    throw new Error(`Download of ${url} failed with HTTP ${response.status}`);

  const part = `${path}.part`;
  const handle = await open(part, "w");
  try {
    const hash = createHash("sha256");
    let received = 0;
    let reported = -1;
    for await (const chunk of response.body) {
      await handle.write(chunk);
      hash.update(chunk);
      received += chunk.byteLength;
      if (bytes !== undefined && received > bytes) break;
      const permille = bytes ? Math.floor((received / bytes) * 1000) : 0;
      if (onProgress && permille > reported) {
        reported = permille;
        onProgress(permille / 1000);
      }
    }
    if (bytes !== undefined && received !== bytes) {
      throw new Error(`Download of ${url} returned ${received} bytes, expected ${bytes}`);
    }
    if (sha256 !== undefined && hash.digest("hex") !== sha256) {
      throw new Error(`Download of ${url} does not match the expected SHA-256`);
    }
    await handle.sync();
    await handle.close();
    await rename(part, path);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(part, { force: true });
    throw error;
  }
}
