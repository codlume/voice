export const UNASSIGNED = "Unassigned";

export const decisionStatuses = ["final", "rejected", "open", "changed"] as const;
export const taskStatuses = ["agreed", "moved", "dropped", "idea", "done"] as const;

export type Part = {
  topics: string[];
  decisions: { decision: string; status: (typeof decisionStatuses)[number] }[];
  nextSteps: { owner: string; task: string; status: (typeof taskStatuses)[number] }[];
  overview?: string;
};

type Decision = { ref: string; part: number; text: string };
type Task = { ref: string; part: number; owner: string; text: string };

export type Ledger = {
  topics: readonly string[];
  decisions: readonly Decision[];
  tasks: readonly Task[];
  next: number;
};

export const emptyLedger: Ledger = { topics: [], decisions: [], tasks: [], next: 1 };

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

const STOP_WORDS = new Set(
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

const STEM_LENGTH = 6;

const contentWords = (text: string) =>
  new Set(
    words(text)
      .filter((word) => !STOP_WORDS.has(word))
      .map((word) => word.slice(0, STEM_LENGTH)),
  );

export function sameItem(a: string, b: string): boolean {
  const [fewer, more] = [contentWords(a), contentWords(b)].toSorted((x, y) => x.size - y.size);
  return fewer!.size >= 2 && [...fewer!].every((word) => more!.has(word));
}

const MIN_SUBJECT_WORD_LENGTH = 5;

const subjectWords = (text: string) =>
  new Set(words(text).filter((word) => word.length >= MIN_SUBJECT_WORD_LENGTH || /\d/.test(word)));

const SHARED_SUBJECT_WORDS = 2;

// Gemma under the JSON grammar sometimes opens a string with a stray "@".
const clean = (text: string) => text.trim().replace(/^@+\s*/, "");

/** A task needs a verb and an object; anything shorter is a fragment. */
const MIN_TASK_WORDS = 3;

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

export type Pair = {
  id: string;
  question: "changed" | "same";
  earlier: Item;
  later: Item;
  dropOnYes: Item;
};

const MAX_PAIRS = 40;

const owner = (item: Item) => ("owner" in item ? item.owner : null);

function pairOf(earlier: Item, later: Item): Omit<Pair, "id"> | null {
  const subjects = subjectWords(later.text);
  const shared = [...subjectWords(earlier.text)].filter((word) => subjects.has(word));
  if (shared.length < SHARED_SUBJECT_WORDS) return null;
  const sameOwner = owner(earlier) === owner(later);
  if (earlier.part < later.part) {
    return { question: sameOwner ? "changed" : "same", earlier, later, dropOnYes: earlier };
  }
  // In one part, two owners of similar work are each doing their own.
  if (!sameOwner) return null;
  const fuller = contentWords(earlier.text).size >= contentWords(later.text).size;
  return { question: "same", earlier, later, dropOnYes: fuller ? later : earlier };
}

const of = (items: readonly Item[]) =>
  items.flatMap((later, at) =>
    items.slice(0, at).flatMap((earlier) => pairOf(earlier, later) ?? []),
  );

export function candidatePairs({ decisions, tasks }: Ledger): Pair[] {
  // Decisions come first but leave tasks half the room: a hand-over is the most common change.
  const tasked = of(tasks);
  const decisionPairBudget = Math.max(MAX_PAIRS / 2, MAX_PAIRS - tasked.length);
  return [...of(decisions).slice(0, decisionPairBudget), ...tasked]
    .slice(0, MAX_PAIRS)
    .map((pair, index) => Object.assign(pair, { id: `P${index + 1}` }));
}

export const describeItem = (item: Item) =>
  "owner" in item ? `${item.owner}: ${item.text}` : item.text;

export function dropConfirmed(
  ledger: Ledger,
  pairs: readonly Pair[],
  confirmed: ReadonlySet<string>,
): Ledger {
  const dropped = new Set(
    pairs.filter(({ id }) => confirmed.has(id)).map(({ dropOnYes }) => dropOnYes.ref),
  );
  return {
    ...ledger,
    decisions: ledger.decisions.filter(({ ref }) => !dropped.has(ref)),
    tasks: ledger.tasks.filter(({ ref }) => !dropped.has(ref)),
  };
}
