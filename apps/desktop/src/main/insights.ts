import { readFile, rm } from "node:fs/promises";

import {
  CATEGORIES,
  parseBundleId,
  type BundleId,
  type Category,
} from "../shared/app-categories.ts";
import {
  EMPTY_INSIGHTS,
  RECENT_SESSIONS,
  dayKey,
  isDayKey,
  type DayKey,
  type Insights,
  type Pace,
  type Usage,
} from "../shared/insights.ts";
import { writeFileAtomic } from "./atomic-file.ts";
import type { Log } from "./diagnostics-scrub.ts";
import type { Dictated } from "./dictation.ts";
import type { Destination } from "./session.ts";

export type InsightsStore = {
  record(dictated: Dictated): void;
  get(): Promise<Insights>;
  clear(): Promise<void>;
  settled(): Promise<void>;
};

const afterPendingInput = () => new Promise<void>((resolve) => setImmediate(resolve));

export function createInsights(options: {
  file: string;
  log: Log;
  onChange: (insights: Insights) => void;
}): InsightsStore {
  const { file, log, onChange } = options;
  let generation = 0;
  // Every method waits on current, so a load that throws must still settle.
  let current = load(file, log).catch(() => {
    log("insights: could not load the file, so nothing is recorded");
    return "unreadable" as const;
  });
  let writes = Promise.resolve();

  function mutate(change: (insights: Insights) => Insights) {
    const previous = current;
    current = previous
      .then((value) => (value === "unreadable" ? value : change(value)))
      .catch((error: unknown) => {
        log(`insights: could not count a session (${String(error)})`);
        return previous;
      });
    writes = writes.then(save).then(publishLatest);
  }

  async function save() {
    const value = await current;
    if (value === "unreadable") return;
    await writeFileAtomic(file, `${JSON.stringify({ version: 2, ...value })}\n`).catch(
      (error: unknown) => log(`insights: save failed (${String(error)})`),
    );
  }

  async function publishLatest() {
    const value = await current;
    if (value === "unreadable") return;
    try {
      onChange(value);
    } catch (error) {
      log(`insights: ${String(error)}`);
    }
  }

  return {
    record(dictated) {
      const at = generation;
      void afterPendingInput().then(() => {
        if (at === generation) mutate((value) => add(value, tally(dictated)));
      });
    },
    get: () => current.then((value) => (value === "unreadable" ? EMPTY_INSIGHTS : value)),
    async clear() {
      generation += 1;
      current = current.then(() => EMPTY_INSIGHTS);
      const removed = writes.then(() => rm(file, { force: true }));
      writes = removed.catch(() => {});
      await removed;
      onChange(EMPTY_INSIGHTS);
    },
    settled: () => afterPendingInput().then(() => writes),
  };
}

async function load(file: string, log: Log): Promise<Insights | "unreadable"> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_INSIGHTS;
    log(`insights: could not read the file, so nothing is recorded (${String(error)})`);
    return "unreadable";
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    log("insights: the file is not JSON, so counting starts over");
    return EMPTY_INSIGHTS;
  }
  const version = typeof json === "object" && json !== null && "version" in json ? json.version : 1;
  if (version !== 1 && version !== 2) {
    log("insights: the file is from another version, so nothing is recorded");
    return "unreadable";
  }
  return parseInsights(json);
}

export type Tally = {
  day: DayKey;
  words: number;
  corrected: number;
  dictionaryFixes: number;
  pace: Pace | null;
  destination: Destination | null;
};

export function tally(dictated: Dictated): Tally {
  const locale = dictated.language === "auto" ? undefined : dictated.language;
  const said = foldedWords(dictated.raw, locale);
  const { paceMs } = dictated;
  return {
    day: dayKey(new Date(dictated.finishedAt)),
    words: said.length,
    corrected:
      dictated.insertedCleanup === null
        ? 0
        : missing(said, foldedWords(dictated.insertedCleanup, locale)),
    dictionaryFixes: dictated.dictionaryFixes,
    pace:
      said.length > 0 && paceMs !== null && paceMs > 0
        ? { words: said.length, ms: Math.round(paceMs) }
        : null,
    destination: dictated.destination,
  };
}

export function add(insights: Insights, session: Tally): Insights {
  const { day, words, destination } = session;
  const counted: Insights = {
    ...insights,
    corrected: insights.corrected + session.corrected,
    dictionaryFixes: insights.dictionaryFixes + session.dictionaryFixes,
    recent:
      session.pace === null
        ? insights.recent
        : [...insights.recent, session.pace].slice(-RECENT_SESSIONS),
  };
  if (words === 0) return counted;
  const days = { ...insights.days, [day]: (insights.days[day] ?? 0) + words };
  if (destination === null) return { ...counted, days };
  const { bundleId, category } = destination;
  const usage = insights.categories[category];
  // "__proto__" and "constructor" are valid bundle ids; a plain read would reach Object.prototype.
  const appWords = Object.hasOwn(insights.apps, bundleId) ? insights.apps[bundleId] : undefined;
  return {
    ...counted,
    days,
    categories: {
      ...insights.categories,
      [category]: { words: usage.words + words, sessions: usage.sessions + 1 },
    },
    apps: { ...insights.apps, [bundleId]: (appWords ?? 0) + words },
  };
}

const segmenters = new Map<string | undefined, Intl.Segmenter>();

function foldedWords(text: string, locale: string | undefined): string[] {
  let segmenter = segmenters.get(locale);
  if (!segmenter) {
    segmenter = new Intl.Segmenter(locale, { granularity: "word" });
    segmenters.set(locale, segmenter);
  }
  const found: string[] = [];
  for (const { segment, isWordLike } of segmenter.segment(text)) {
    if (!isWordLike) continue;
    found.push(
      segment
        .normalize("NFC")
        .replace(/[‘’ʼ]/gu, "'")
        .toLocaleLowerCase(locale),
    );
  }
  return found;
}

function missing(raw: readonly string[], cleaned: readonly string[]): number {
  const left = new Map<string, number>();
  for (const word of cleaned) left.set(word, (left.get(word) ?? 0) + 1);
  let count = 0;
  for (const word of raw) {
    const n = left.get(word) ?? 0;
    if (n === 0) count += 1;
    else left.set(word, n - 1);
  }
  return count;
}

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

export function parseInsights(raw: unknown): Insights {
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const days: Record<DayKey, number> = {};
  if (typeof r.days === "object" && r.days !== null) {
    for (const [key, count] of Object.entries(r.days)) {
      if (isDayKey(key) && isCount(count) && count > 0) days[key] = count;
    }
  }
  const recent = Array.isArray(r.recent)
    ? r.recent.flatMap((item: unknown) => {
        if (typeof item !== "object" || item === null) return [];
        const { words, ms } = item as Record<string, unknown>;
        return isCount(words) && words > 0 && isCount(ms) && ms > 0 ? [{ words, ms }] : [];
      })
    : [];
  return {
    days,
    corrected: isCount(r.corrected) ? r.corrected : 0,
    dictionaryFixes: isCount(r.dictionaryFixes) ? r.dictionaryFixes : 0,
    recent: recent.slice(-RECENT_SESSIONS),
    categories: parseCategories(r.categories),
    apps: parseApps(r.apps),
  };
}

function parseCategories(raw: unknown): Record<Category, Usage> {
  const categories = { ...EMPTY_INSIGHTS.categories };
  if (typeof raw !== "object" || raw === null) return categories;
  const r = raw as Record<string, unknown>;
  for (const category of CATEGORIES) {
    const usage = r[category];
    if (typeof usage !== "object" || usage === null) continue;
    const { words, sessions } = usage as Record<string, unknown>;
    if (isCount(words) && isCount(sessions)) categories[category] = { words, sessions };
  }
  return categories;
}

// A Map, not an object: an id like "__proto__" must become a plain key, and two spellings of
// one id in a hand-edited file add up instead of the last one winning.
function parseApps(raw: unknown): Record<BundleId, number> {
  const apps = new Map<BundleId, number>();
  if (typeof raw !== "object" || raw === null) return {};
  for (const [key, words] of Object.entries(raw)) {
    const bundleId = parseBundleId(key);
    if (bundleId !== null && isCount(words) && words > 0)
      apps.set(bundleId, (apps.get(bundleId) ?? 0) + words);
  }
  return Object.fromEntries(apps);
}
