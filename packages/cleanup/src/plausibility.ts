export const MAX_OUTPUT_RATIO = 3;
const MIN_WORD_RECALL = 0.8;
// A dropped instruction at either end of a long dictation barely moves the overall recall, so
// the first and last few content words are held to the same bar on their own.
const EDGE_WORDS = 8;

const CHAT_OPENERS = [
  "sorry",
  "i am sorry",
  "i can not",
  "as an ai",
  "sure",
  "certainly",
  "of course",
  "here is",
];

// Sounds and discourse phrases that cleanup is meant to drop. Real one-word replies such as
// "okay", "yes" and "thanks" are deliberately absent: the user said them, so they must survive.
const FILLERS = new Set([
  "um",
  "umm",
  "uh",
  "uhm",
  "er",
  "erm",
  "ah",
  "eh",
  "oh",
  "hmm",
  "hm",
  "mm",
  "mhm",
  "like",
  "so",
  "actually",
  "basically",
  "literally",
  "just",
  "you know",
  "i mean",
  "kind of",
  "sort of",
]);

// Words the model is free to turn into symbols or digits, so they are not required to survive.
const SPOKEN_SYMBOLS = new Set([
  "dot",
  "comma",
  "period",
  "colon",
  "semicolon",
  "slash",
  "dash",
  "hyphen",
  "at",
  "percent",
  "dollar",
  "dollars",
  "euro",
  "euros",
  "pound",
  "pounds",
  "cent",
  "cents",
  "degree",
  "degrees",
  "hashtag",
  "oclock",
  "o clock",
  "am",
  "pm",
  "new line",
  "new paragraph",
  "question mark",
  "exclamation mark",
  "exclamation point",
  "quote",
  "unquote",
  "end quote",
]);

// Words that number, time and date formatting absorbs ("a hundred", "three point five",
// "half past three", "the fourteenth of march"). Dropped everywhere rather than only next to
// a number, because an adjacency rule changed no verdict on the fixtures and costs more code.
const ABSORBED = new Set(["a", "an", "the", "and", "of", "to", "point", "half", "quarter", "past"]);

const UNITS =
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen";
const TENS = "twenty thirty forty fifty sixty seventy eighty ninety";
const SCALES = { hundred: 100, thousand: 1_000, million: 1_000_000, billion: 1_000_000_000 };
const CARDINALS = new Map<string, number>([
  ...UNITS.split(" ").map((word, value) => [word, value] as const),
  ...TENS.split(" ").map((word, i) => [word, 20 + 10 * i] as const),
  ...Object.entries(SCALES),
]);
const IRREGULAR_ORDINALS: Record<string, string> = {
  one: "first",
  two: "second",
  three: "third",
  five: "fifth",
  eight: "eighth",
  nine: "ninth",
  twelve: "twelfth",
};
const ORDINALS = new Map(
  [...CARDINALS].map(([word, value]) => [
    IRREGULAR_ORDINALS[word] ?? `${word.replace(/y$/, "ie")}th`,
    value,
  ]),
);
const NUMBER_WORDS = new Map([...CARDINALS, ...ORDINALS]);
const isNumber = (word: string) => NUMBER_WORDS.has(word) || /^\p{N}+$/u.test(word);

// Spoken between two numbers, these words belong to them: "two point five", "nine oh five".
const BETWEEN_NUMBERS = new Map([
  ["point", "."],
  ["oh", "0"],
]);

// The numbers in a word stream as digit strings. Spoken words join into one number while they
// still can, so "three thirty" is 3 and 30 and "twenty twenty six" is 20 and 26. A spoken
// ordinal is left out: cleanup may turn "the first one is ... the second one is ..." into a
// list, and the "one" after an ordinal is a pronoun.
function numbers(words: string[]): string[] {
  const found: string[] = [];
  let total = 0;
  let group = 0;
  let open = false;
  let accepts: "any" | "unit" | "none" = "any";
  const flush = (keep = true) => {
    if (open && keep) found.push(String(total + group));
    total = group = 0;
    open = false;
    accepts = "any";
  };
  words.forEach((word, i) => {
    const next = words[i + 1] ?? "";
    if (/^\p{N}+$/u.test(word)) {
      flush();
      // "2.5 million" scales its last digits the way "two point five million" does.
      if ((NUMBER_WORDS.get(next) ?? 0) >= 100) {
        group = Number(word);
        open = true;
      } else found.push(word);
      return;
    }
    const between = BETWEEN_NUMBERS.get(word);
    if (between && isNumber(words[i - 1] ?? "") && isNumber(next)) {
      flush();
      found.push(between);
      return;
    }
    if (word === "and" && accepts === "any" && NUMBER_WORDS.has(next)) return;
    if (word === "one" && ORDINALS.has(words[i - 1] ?? "")) return;
    const value = NUMBER_WORDS.get(word);
    if (value === undefined) {
      flush();
      return;
    }
    if (value >= 100) {
      if (value === 100) group = (group || 1) * 100;
      else {
        total += (group || 1) * value;
        group = 0;
      }
      accepts = "any";
    } else {
      const fits = accepts === "any" || (accepts === "unit" && value < 10);
      if (!fits) flush();
      group += value;
      accepts = value < 20 ? "none" : "unit";
    }
    open = true;
    if (ORDINALS.has(word)) flush(false);
  });
  flush();
  return found;
}

// Some of the output's numbers, joined in order, spell the input's digits. Formatting may add
// a number ("half past three" becomes "3:30") or join two ("twenty twenty six" becomes "2026").
function numbersSurvive(input: string[], output: string[]): boolean {
  const target = input.join("");
  let reached = new Set([0]);
  for (const number of output) {
    const next = new Set(reached);
    for (const at of reached) if (target.startsWith(number, at)) next.add(at + number.length);
    reached = next;
  }
  return reached.has(target.length);
}

// A dropped or added negation flips the meaning while keeping almost every word. A false start
// such as "i don't i don't think" says it once.
const NEGATIONS = new Set(["not", "no", "never"]);
const negations = (words: string[]) =>
  withoutFalseStarts(words).filter((word) => NEGATIONS.has(word)).length;

const PRONOUNS = "i you he she it we they that there here what who where how when";
const MODALS = "would should could must might";
const AUXILIARIES = "is are was were has have had do does did need ca wo sha ai";
const STEM_SPELLINGS: Record<string, string> = { ca: "can", wo: "will", sha: "shall", ai: "is" };
const CONTRACTIONS = (
  [
    [new Set(PRONOUNS.split(" ")), { ll: "will", ve: "have", d: "would" }],
    [new Set("you we they that there here what who where how when".split(" ")), { re: "are" }],
    [new Set("he she it that there here what who where how when".split(" ")), { s: "is" }],
    [new Set(MODALS.split(" ")), { nt: "not", ve: "have" }],
    [new Set(AUXILIARIES.split(" ")), { nt: "not" }],
  ] satisfies [stems: Set<string>, suffixes: Record<string, string>][]
).flatMap(([stems, suffixes]) =>
  Object.entries(suffixes).map(([suffix, written]) => ({ stems, suffix, written })),
);

function expandContraction(word: string): string | undefined {
  if (word === "im") return "i am";
  for (const { stems, suffix, written } of CONTRACTIONS) {
    if (!word.endsWith(suffix)) continue;
    const stem = word.slice(0, -suffix.length);
    if (stems.has(stem)) return `${STEM_SPELLINGS[stem] ?? stem} ${written}`;
  }
  return undefined;
}

// Spoken forms with nothing to expand by rule. Applied to both sides.
const SPELLINGS = new Map(
  Object.entries({
    lets: "let us",
    cannot: "can not",
    dunno: "do not know",
    lemme: "let me",
    gimme: "give me",
    yall: "you all",
    gonna: "going to",
    wanna: "want to",
    gotta: "got to",
    kinda: "kind of",
    sorta: "sort of",
    cause: "because",
    til: "until",
    till: "until",
    ok: "okay",
    k: "okay",
    yeah: "yes",
    thanks: "thank you",
    alright: "all right",
    versus: "vs",
    mister: "mr",
    missus: "mrs",
    doctor: "dr",
    professor: "prof",
  }),
);

// Multi-word spoken forms. Fillers and spoken symbols vanish; the rest become their written word.
const PHRASES: Record<string, string> = {
  ...Object.fromEntries(
    [...FILLERS, ...SPOKEN_SYMBOLS].filter((entry) => entry.includes(" ")).map((p) => [p, ""]),
  ),
  "e mail": "email",
  "et cetera": "etc",
};
const PHRASE = new RegExp(` (?:${Object.keys(PHRASES).join("|")})(?= )`, "g");

function normalize(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFD")
      .replaceAll(/\p{M}/gu, "")
      .replaceAll(/['’]/g, "")
      // "p.m." and "U.S." read as one word, while "example.com" stays two.
      .replaceAll(/(?<!\p{L})(\p{L})\.(?=\p{L}(?!\p{L}))/gu, "$1")
      // "14th" is the number 14, "2,500" is one number and "2.5" reads as "two point five".
      .replaceAll(/(?<=\p{N})(?:st|nd|rd|th)(?!\p{L})/gu, "")
      .replaceAll(/(?<=\p{N}),(?=\p{N}{3}(?!\p{N}))/gu, "")
      .replaceAll(/(?<=\p{N})\.(?=\p{N})/gu, " point ")
      .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
      // "3:30pm" and "10am" count their unit as its own word, like "three thirty pm" does.
      .replaceAll(/(?<=\p{N})(?=\p{L})|(?<=\p{L})(?=\p{N})/gu, " ")
      .trim()
  );
}

// Letters spelled one by one ("a p i", "w w w", "a i") become the word they spell, on both
// sides. A repeated "i" or "a" is a stutter, not spelling. Digits break a run so "q three"
// and "Q3" both count as "q".
function joinSpelledLetters(tokens: string[]): string[] {
  const joined: string[] = [];
  let run: string[] = [];
  const flush = () => {
    const stutter = (run[0] === "i" || run[0] === "a") && run.every((letter) => letter === run[0]);
    if (run.length > 1 && !stutter) joined.push(run.join(""));
    else joined.push(...run);
    run = [];
  };
  for (const token of tokens) {
    if (/^\p{L}$/u.test(token)) run.push(token);
    else {
      flush();
      joined.push(token);
    }
  }
  flush();
  return joined;
}

function spokenWords(text: string): string[] {
  const tokens = ` ${normalize(text)} `
    .replaceAll(PHRASE, (match) => ` ${PHRASES[match.slice(1)]}`)
    .split(" ")
    .filter(Boolean);
  return joinSpelledLetters(tokens).flatMap((word) =>
    (SPELLINGS.get(word) ?? expandContraction(word) ?? word).split(" "),
  );
}

function contentWords(text: string): string[] {
  return spokenWords(text).filter(
    (word) =>
      !FILLERS.has(word) && !SPOKEN_SYMBOLS.has(word) && !ABSORBED.has(word) && !isNumber(word),
  );
}

// A false start repeats a word or a short phrase back to back; cleanup keeps one copy.
function withoutFalseStarts(tokens: string[]): string[] {
  const kept: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const repeat = [4, 3, 2, 1].find(
      (n) =>
        i + 2 * n <= tokens.length &&
        tokens.slice(i, i + n).every((token, k) => token === tokens[i + n + k]),
    );
    if (repeat) {
      i += repeat;
    } else {
      kept.push(tokens[i]!);
      i++;
    }
  }
  return kept;
}

export type WordSurvival = {
  // The share of the input's content words the output still contains, counted with
  // multiplicity so a dictation that repeats itself cannot pass on its vocabulary alone.
  recall: number;
  // The same share over the first and last EDGE_WORDS content words of the input.
  head: number;
  tail: number;
};

const share = (flags: boolean[]) => flags.filter(Boolean).length / flags.length;

export function wordSurvival(input: string, output: string): WordSurvival {
  const said = withoutFalseStarts(contentWords(input));
  if (said.length === 0) return { recall: 1, head: 1, tail: 1 };
  const remaining = new Map<string, number>();
  for (const word of contentWords(output)) remaining.set(word, (remaining.get(word) ?? 0) + 1);
  const kept = said.map((word) => {
    const count = remaining.get(word) ?? 0;
    if (count === 0) return false;
    remaining.set(word, count - 1);
    return true;
  });
  return {
    recall: share(kept),
    head: share(kept.slice(0, EDGE_WORDS)),
    tail: share(kept.slice(-EDGE_WORDS)),
  };
}

export function assertPlausibleCleanup(input: string, output: string, truncated: boolean): void {
  if (truncated) throw new Error("Cleanup output was cut off at the token limit");
  if (output.length > MAX_OUTPUT_RATIO * input.length)
    throw new Error(`Cleanup output is over ${MAX_OUTPUT_RATIO}x the input length`);
  if (/<\/?think>|<\|im_(start|end)\|>/.test(output))
    throw new Error("Cleanup output contains chat template markup");
  const said = spokenWords(input);
  const cleaned = spokenWords(output);
  const opener = CHAT_OPENERS.find((phrase) => ` ${cleaned.join(" ")} `.startsWith(` ${phrase} `));
  if (opener && !` ${said.join(" ")} `.includes(` ${opener} `))
    throw new Error("Cleanup output reads like a chat reply");
  const { recall, head, tail } = wordSurvival(input, output);
  if (recall < MIN_WORD_RECALL) {
    throw new Error(
      output.trim()
        ? `Cleanup kept only ${Math.round(recall * 100)}% of the words said`
        : "Cleanup output is empty for speech that is not filler",
    );
  }
  if (head < MIN_WORD_RECALL)
    throw new Error(`Cleanup kept only ${Math.round(head * 100)}% of the opening words`);
  if (tail < MIN_WORD_RECALL)
    throw new Error(`Cleanup kept only ${Math.round(tail * 100)}% of the closing words`);
  if (!numbersSurvive(numbers(said), numbers(cleaned)))
    throw new Error("Cleanup changed a number the user said");
  if (negations(said) !== negations(cleaned))
    throw new Error("Cleanup changed a negation the user said");
  const added = wordSurvival(output, input);
  const kept = Math.min(added.recall, added.head, added.tail);
  if (kept < MIN_WORD_RECALL)
    throw new Error(`Cleanup added words that were not said (${Math.round(kept * 100)}% said)`);
}
