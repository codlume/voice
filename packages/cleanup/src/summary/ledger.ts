/**
 * What the meeting settled, merged part by part. Within a part the model gives every item a
 * status, so an idea that part rejected, left open or moved never counts. An item that repeats
 * another merges into it. Across parts, a later item replaces an earlier one when the reconcile
 * step confirms that it changed it: the later mention is the meeting's last word.
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

// Words that tie an item to nothing: articles, pronouns, auxiliaries, prepositions, in English and
// Polish. Another language keeps every word, which only makes repeats rarer.
const FILLER = new Set(
  (
    "a an and are as at be been being but by can could did do does for from had has have he her " +
    "him his i if in into is it its may me might must my no not now of on or our shall she should " +
    "so than that the their them then there these they this those to too up us was we were will " +
    "with would you your " +
    "albo ale bez by dla do i ich ja jak jako jego jej jest juz lub ma mamy my na nad nie o od on " +
    "ona oni oraz po pod przez przy sa sie ta tak takze te tego tej ten to ty tylko tym u w we wy " +
    "z za ze"
  ).split(" "),
);

// Six letters keep "payment" and "payments", or "dokumenty" and "dokumentow", one word.
const contentWords = (text: string) =>
  new Set(
    words(text)
      .filter((word) => !FILLER.has(word))
      .map((word) => word.slice(0, 6)),
  );

/**
 * Says the same thing: every content word of the item with fewer is in the other, so a repeat may
 * only add a date or a detail. Any different name, object or number keeps both.
 */
export function sameItem(a: string, b: string): boolean {
  const [fewer, more] = [contentWords(a), contentWords(b)].toSorted((x, y) => x.size - y.size);
  return fewer!.size >= 2 && [...fewer!].every((word) => more!.has(word));
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

/** A repeat keeps the fuller wording at the first one's place, and counts as said in the later part. */
function merge<T extends Decision | Task>(
  items: readonly T[],
  item: T,
  same: (earlier: T, later: T) => boolean,
): T[] {
  const at = items.findIndex((earlier) => same(earlier, item));
  if (at < 0) return [...items, item];
  const earlier = items[at]!;
  const fuller = contentWords(earlier.text).size > contentWords(item.text).size ? earlier : item;
  return items.with(at, { ...item, text: fuller.text, ref: earlier.ref });
}

const sameDecision = (a: Decision, b: Decision) => sameItem(a.text, b.text);
// A task under another owner is a hand-over or a second person's own task: the pair step decides.
const sameTask = (a: Task, b: Task) => a.owner === b.owner && sameItem(a.text, b.text);

export function applyPart(
  ledger: Ledger,
  part: number,
  extracted: Part,
  owners: ReadonlySet<string>,
): Ledger {
  let { decisions, tasks, next } = ledger;
  for (const { decision, status } of extracted.decisions) {
    if (status !== "final" || clean(decision) === "") continue;
    decisions = merge(decisions, { ref: `D${next++}`, part, text: clean(decision) }, sameDecision);
  }
  for (const { owner, task, status } of extracted.nextSteps) {
    if (status !== "agreed" || words(task).length < MIN_TASK_WORDS) continue;
    const item = { owner: owners.has(owner) ? owner : UNASSIGNED, text: clean(task) };
    tasks = merge(tasks, { ...item, ref: `T${next++}`, part }, sameTask);
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
