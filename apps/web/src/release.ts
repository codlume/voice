import { parse } from "yaml";

export const FEED_URL =
  "https://downloads.voice.codlume.com/channels/stable/mac-arm64/latest-mac.yml";
export const RELEASES_URL = "https://github.com/codlume/voice/releases/latest";

export type Release = { version: string; dmgUrl: string; size: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function parseFeed(source: string): Release | null {
  let feed: unknown;
  try {
    feed = parse(source);
  } catch {
    return null;
  }
  if (!isRecord(feed) || typeof feed.version !== "string" || !Array.isArray(feed.files)) {
    return null;
  }
  const dmg: unknown = feed.files.find(
    (file) => isRecord(file) && typeof file.url === "string" && file.url.endsWith(".dmg"),
  );
  if (
    !isRecord(dmg) ||
    typeof dmg.url !== "string" ||
    !dmg.url.startsWith("https://") ||
    typeof dmg.size !== "number" ||
    !Number.isSafeInteger(dmg.size) ||
    dmg.size <= 0
  ) {
    return null;
  }
  return { version: feed.version, dmgUrl: dmg.url, size: dmg.size };
}

export async function loadRelease(): Promise<Release | null> {
  try {
    const response = await fetch(FEED_URL, { signal: AbortSignal.timeout(2000) });
    return response.ok ? parseFeed(await response.text()) : null;
  } catch {
    return null;
  }
}

export const formatSize = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;
