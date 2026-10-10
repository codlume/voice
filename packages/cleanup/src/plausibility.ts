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

const NUMBER_WORDS = new Set(
  (
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen " +
    "fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty " +
    "ninety hundred thousand million billion first second third fourth fifth sixth seventh " +
    "eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth " +
    "eighteenth nineteenth twentieth thirtieth fortieth fiftieth sixtieth seventieth eightieth " +
    "ninetieth hundredth thousandth millionth billionth"
  ).split(" "),
);
const isNumber = (word: string) => NUMBER_WORDS.has(word) || /^\p{N}+$/u.test(word);

const PRONOUNS = "i you he she it we they that there here what who where how when";
const MODALS = "would should could must might";
const AUXILIARIES = "is are was were has have had do does did need ca wo sha ai";
const STEM_SPELLINGS: Record<string, string> = { ca: "can", wo: "will", sha: "shall", ai: "is" };
const CONTRACTIONS: [stems: Set<string>, suffixes: Record<string, string>][] = [
  [new Set(PRONOUNS.split(" ")), { ll: "will", ve: "have", d: "would" }],
  [new Set("you we they that there here what who where how when".split(" ")), { re: "are" }],
  [new Set("he she it that there here what who where how when".split(" ")), { s: "is" }],
  [new Set(MODALS.split(" ")), { nt: "not", ve: "have" }],
  [new Set(AUXILIARIES.split(" ")), { nt: "not" }],
];

function expandContraction(word: string): string | undefined {
  if (word === "im") return "i am";
  for (const [stems, suffixes] of CONTRACTIONS) {
    for (const [suffix, written] of Object.entries(suffixes)) {
      const stem = word.slice(0, -suffix.length);
      if (word.endsWith(suffix) && stems.has(stem))
        return `${STEM_SPELLINGS[stem] ?? stem} ${written}`;
    }
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
  const said = ` ${spokenWords(input).join(" ")} `;
  const cleaned = ` ${spokenWords(output).join(" ")} `;
  const opener = CHAT_OPENERS.find((phrase) => cleaned.startsWith(` ${phrase} `));
  if (opener && !said.includes(` ${opener} `))
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
}
