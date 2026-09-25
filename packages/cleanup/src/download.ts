import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export const S1_MINI_FILE = "s1-mini-q4_k_m.gguf";

const S1_MINI = {
  baseUrl: "https://huggingface.co/superwhisper/s1-mini-GGUF/resolve/main",
  file: S1_MINI_FILE,
  bytes: 484_219_808,
};

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
  onProgress,
  signal,
}: DownloadOptions & { baseUrl: string; file: string; bytes: number }): Promise<string> {
  const path = join(dir, file);
  if ((await sizeOf(path)) === bytes) return path;

  await mkdir(dir, { recursive: true });
  // Legal files land before the model because the model's presence marks the download complete.
  for (const name of LEGAL_FILES) {
    await fetchToFile(`${baseUrl}/${name}`, join(dir, `${file}.${name}`), { signal });
  }
  await fetchToFile(`${baseUrl}/${file}`, path, { bytes, onProgress, signal });
  return path;
}

async function sizeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
}

async function fetchToFile(
  url: string,
  path: string,
  { bytes, onProgress, signal }: Omit<DownloadOptions, "dir"> & { bytes?: number },
): Promise<void> {
  const response = await fetch(url, { signal: signal ?? null });
  if (!response.ok || !response.body)
    throw new Error(`Download of ${url} failed with HTTP ${response.status}`);

  const part = `${path}.part`;
  const handle = await open(part, "w");
  try {
    let received = 0;
    let reported = -1;
    for await (const chunk of response.body) {
      await handle.write(chunk);
      received += chunk.byteLength;
      if (bytes !== undefined && received > bytes) break;
      const permille = bytes ? Math.floor((received / bytes) * 1000) : 0;
      // Throttled to at most 1000 calls so a 484 MB download does not flood the caller.
      if (onProgress && permille > reported) {
        reported = permille;
        onProgress(permille / 1000);
      }
    }
    if (bytes !== undefined && received !== bytes) {
      throw new Error(`Download of ${url} returned ${received} bytes, expected ${bytes}`);
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
