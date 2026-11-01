/**
 * What the meeting settled, merged part by part. Within a part the model gives every item a
 * status, so an idea that part rejected, left open or moved never counts. An item that repeats
 * another word for word merges into it. The reconcile step then judges items that share a subject:
 * a later part's change or hand-over replaces the earlier item, since the later mention is the
 * meeting's last word, and one item said twice keeps its fuller wording.
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

/**
 * Two items of one kind that share a subject, and what a "yes" means. `changed`: the later part
 * changed the earlier item. `same`: both are one decision or one piece of work, said twice in a
 * part or handed to a new owner in a later one. A "yes" drops `drop`.
 */
export type Pair = {
  id: string;
  question: "changed" | "same";
  earlier: Item;
  later: Item;
  drop: Item;
};

const MAX_PAIRS = 40;

const owner = (item: Item) => ("owner" in item ? item.owner : null);

function pairOf(earlier: Item, later: Item): Omit<Pair, "id"> | null {
  const subjects = subjectWords(later.text);
  const shared = [...subjectWords(earlier.text)].filter((word) => subjects.has(word));
  if (shared.length < SHARED_SUBJECT_WORDS) return null;
  const sameOwner = owner(earlier) === owner(later);
  if (earlier.part < later.part) {
    return { question: sameOwner ? "changed" : "same", earlier, later, drop: earlier };
  }
  // In one part, two owners of similar work are each doing their own.
  if (!sameOwner) return null;
  const fuller = contentWords(earlier.text).size >= contentWords(later.text).size;
  return { question: "same", earlier, later, drop: fuller ? later : earlier };
}

const of = (items: readonly Item[]) =>
  items.flatMap((later, at) =>
    items.slice(0, at).flatMap((earlier) => pairOf(earlier, later) ?? []),
  );

export function candidatePairs({ decisions, tasks }: Ledger): Pair[] {
  // Decisions come first but leave tasks half the room: a hand-over is the most common change.
  const tasked = of(tasks);
  const share = Math.max(MAX_PAIRS / 2, MAX_PAIRS - tasked.length);
  return [...of(decisions).slice(0, share), ...tasked]
    .slice(0, MAX_PAIRS)
    .map((pair, index) => Object.assign(pair, { id: `P${index + 1}` }));
}

export const describeItem = (item: Item) =>
  "owner" in item ? `${item.owner}: ${item.text}` : item.text;

/** Drops each confirmed pair's `drop`. */
export function dropConfirmed(
  ledger: Ledger,
  pairs: readonly Pair[],
  confirmed: ReadonlySet<string>,
): Ledger {
  const dropped = new Set(pairs.filter(({ id }) => confirmed.has(id)).map(({ drop }) => drop.ref));
  return {
    ...ledger,
    decisions: ledger.decisions.filter(({ ref }) => !dropped.has(ref)),
    tasks: ledger.tasks.filter(({ ref }) => !dropped.has(ref)),
  };
}
