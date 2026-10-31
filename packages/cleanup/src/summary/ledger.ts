/**
 * What the meeting settled, merged part by part. Within a part the model gives every item a
 * status, so an idea that part rejected, left open or moved never counts. Across parts, a later
 * item replaces an earlier one when it repeats it, or when the reconcile step confirms that it
 * changed it: the later mention is the meeting's last word.
 */

export const UNASSIGNED = "Unassigned";

export const decisionStatuses = ["final", "rejected", "open", "changed"] as const;
export const taskStatuses = ["agreed", "moved", "dropped", "idea", "done"] as const;

/** One part's extraction, as the JSON grammar shapes it. Owners are speaker labels. */
export type Part = {
  topics: string[];
  decisions: { decision: string; status: (typeof decisionStatuses)[number] }[];
  nextSteps: { owner: string; task: string; status: (typeof taskStatuses)[number] }[];
  overview?: string;
};

export type Decision = { ref: string; part: number; text: string };
export type Task = { ref: string; part: number; owner: string; text: string };

export type Ledger = {
  topics: readonly string[];
  decisions: readonly Decision[];
  tasks: readonly Task[];
  next: number;
};

export const emptyLedger: Ledger = { topics: [], decisions: [], tasks: [], next: 1 };

/** The ledger as the overview reads it. */
export const describeLedger = ({ topics, decisions, tasks }: Ledger) =>
  [
    "Topics:",
    ...topics.map((topic) => `- ${topic}`),
    "Decisions:",
    ...decisions.map(({ text }) => `- ${text}`),
    "Tasks:",
    ...tasks.map(({ owner, text }) => `- ${owner}: ${text}`),
  ].join("\n");

const words = (text: string) =>
  text
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .match(/[\p{L}\p{N}]+/gu) ?? [];

/** Share of the shorter item's words the other one also has, above which both say the same. */
const DUPLICATE_OVERLAP = 0.7;

export function sameItem(a: string, b: string): boolean {
  const left = new Set(words(a));
  const right = new Set(words(b));
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / Math.max(1, Math.min(left.size, right.size)) >= DUPLICATE_OVERLAP;
}

// A name, a product, an amount: a word this long or with a digit. Short words such as "the" or
// "will" do not tie two items to one subject.
const subjectWords = (text: string) =>
  new Set(words(text).filter((word) => word.length >= 5 || /\d/.test(word)));

const SHARED_SUBJECT_WORDS = 2;

// Gemma under the JSON grammar sometimes opens a string with a stray "@".
const clean = (text: string) => text.trim().replace(/^@+\s*/, "");

/** A task needs a verb and an object; anything shorter is a fragment. */
const MIN_TASK_WORDS = 3;

function merge<T extends { ref: string; text: string }>(items: readonly T[], item: T): T[] {
  const at = items.findIndex(({ text }) => sameItem(text, item.text));
  return at < 0 ? [...items, item] : items.with(at, { ...item, ref: items[at]!.ref });
}

export function applyPart(
  ledger: Ledger,
  part: number,
  extracted: Part,
  owners: ReadonlySet<string>,
): Ledger {
  let { decisions, tasks, next } = ledger;
  for (const { decision, status } of extracted.decisions) {
    if (status !== "final" || clean(decision) === "") continue;
    decisions = merge(decisions, { ref: `D${next++}`, part, text: clean(decision) });
  }
  for (const { owner, task, status } of extracted.nextSteps) {
    if (status !== "agreed" || words(task).length < MIN_TASK_WORDS) continue;
    const item = { owner: owners.has(owner) ? owner : UNASSIGNED, text: clean(task) };
    tasks = merge(tasks, { ...item, ref: `T${next++}`, part });
  }
  const topics = [...ledger.topics, ...extracted.topics.map(clean).filter(Boolean)];
  return { topics, decisions, tasks, next };
}

type Item = Decision | Task;

/** An earlier item a later one may have changed: same kind, a later part, a shared subject. */
export type Pair = { id: string; earlier: Item; later: Item };

const MAX_PAIRS = 40;

export function candidatePairs({ decisions, tasks }: Ledger): Pair[] {
  const of = (items: readonly Item[]) =>
    items.flatMap((later) =>
      items
        .filter((earlier) => {
          if (earlier.part >= later.part) return false;
          const subjects = subjectWords(later.text);
          const shared = [...subjectWords(earlier.text)].filter((word) => subjects.has(word));
          return shared.length >= SHARED_SUBJECT_WORDS;
        })
        .map((earlier) => ({ earlier, later })),
    );
  return [...of(decisions), ...of(tasks)]
    .slice(0, MAX_PAIRS)
    .map(({ earlier, later }, index) => ({ id: `P${index + 1}`, earlier, later }));
}

export const describeItem = (item: Item) =>
  "owner" in item ? `${item.owner}: ${item.text}` : item.text;

/** Drops the earlier item of each pair the model says the later one replaced. */
export function dropReplaced(
  ledger: Ledger,
  pairs: readonly Pair[],
  replaced: ReadonlySet<string>,
): Ledger {
  const dropped = new Set(
    pairs.filter(({ id }) => replaced.has(id)).map(({ earlier }) => earlier.ref),
  );
  return {
    ...ledger,
    decisions: ledger.decisions.filter(({ ref }) => !dropped.has(ref)),
    tasks: ledger.tasks.filter(({ ref }) => !dropped.has(ref)),
  };
}
