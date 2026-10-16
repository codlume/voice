import type { ReleaseNotes } from "../shared/api.ts";

const MAX_RELEASES = 6;
const MAX_ITEMS = 30;
const MAX_ITEM_LENGTH = 240;

type FeedRelease = { version: string; notes: unknown };

export function notesSinceInstalled(updateInfo: unknown, installedVersion: string): ReleaseNotes {
  const releases = [];
  for (const { version, notes } of feedReleases(updateInfo)) {
    if (version === installedVersion) break;
    const items = releaseNoteItems(notes);
    if (items.length > 0) releases.push({ version, items });
  }
  return {
    releases: releases.slice(0, MAX_RELEASES),
    omitted: Math.max(0, releases.length - MAX_RELEASES),
  };
}

function feedReleases(updateInfo: unknown): readonly FeedRelease[] {
  if (typeof updateInfo !== "object" || updateInfo === null) return [];
  const history = "releaseHistory" in updateInfo ? updateInfo.releaseHistory : undefined;
  if (Array.isArray(history) && history.length > 0 && history.every(isFeedRelease)) return history;
  return feedWithoutHistory(updateInfo);
}

function feedWithoutHistory(updateInfo: object): readonly FeedRelease[] {
  const version = "version" in updateInfo ? updateInfo.version : undefined;
  if (typeof version !== "string") return [];
  return [{ version, notes: "releaseNotes" in updateInfo ? updateInfo.releaseNotes : undefined }];
}

function isFeedRelease(value: unknown): value is FeedRelease {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof value.version === "string" &&
    "notes" in value &&
    typeof value.notes === "string"
  );
}

export function releaseNoteItems(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const items: string[] = [];
  for (const raw of value.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^#+\s*New Contributors\b/i.test(line)) break;
    const bullet = /^[*-] (.*)$/.exec(line)?.[1];
    if (bullet === undefined) continue;
    const item = plainText(bullet);
    if (!item || items.includes(item)) continue;
    items.push(item);
    if (items.length === MAX_ITEMS) break;
  }
  return items;
}

function plainText(markdown: string): string {
  const text = markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)\S*/g, "#$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_ITEM_LENGTH ? `${text.slice(0, MAX_ITEM_LENGTH - 1).trimEnd()}…` : text;
}
