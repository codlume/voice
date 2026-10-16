import { gt, valid } from "semver";

import type { ReleaseNotes } from "../shared/api.ts";

const MAX_RELEASES = 6;
const MAX_ITEMS = 30;
const MAX_ITEM_LENGTH = 240;

// electron-updater's UpdateInfo fits this. releaseHistory is ours, so the library leaves it untyped.
type Feed = { version: string; releaseNotes?: unknown; releaseHistory?: unknown };
type Entry = { version: string; notes?: unknown };

/** Notes for every release newer than the installed one, the rule electron-updater's GitHub changelog uses. */
export function notesSinceInstalled(feed: Feed, installedVersion: string): ReleaseNotes {
  const recorded = Array.isArray(feed.releaseHistory) ? feed.releaseHistory.filter(isEntry) : [];
  const history =
    recorded.length > 0 ? recorded : [{ version: feed.version, notes: feed.releaseNotes }];
  const releases = history
    .filter(({ version }) => gt(version, installedVersion))
    .map(({ version, notes }) => ({ version, items: releaseNoteItems(notes) }))
    .filter(({ items }) => items.length > 0);
  // The publisher caps the history, so one that never reaches the installed version may be cut short.
  const truncated =
    recorded.length > 0 && recorded.every(({ version }) => gt(version, installedVersion));
  return {
    releases: releases.slice(0, MAX_RELEASES),
    more: releases.length > MAX_RELEASES || truncated,
  };
}

function isEntry(value: unknown): value is Entry {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof value.version === "string" &&
    valid(value.version) !== null
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
