export const MAX_OUTPUT_RATIO = 3;
const MIN_WORD_RECALL = 0.8;

const CHAT_OPENER_SPELLINGS = [
  ["sorry"],
  ["im sorry", "i am sorry"],
  ["i cannot", "i cant"],
  ["as an ai"],
  ["sure"],
  ["certainly"],
  ["of course"],
  ["here is", "heres"],
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
  "hmm",
  "hm",
  "mm",
  "mhm",
  "like",
  "so",
  "well",
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
  "oclock",
  "am",
  "pm",
  "new line",
  "new paragraph",
  "question mark",
  "exclamation mark",
  "exclamation point",
]);

const NUMBER_WORD =
  /^(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|(thir|four|fif|six|seven|eigh|nine)teen|(twen|thir|for|fif|six|seven|eigh|nine)ty|hundred|thousand|million|billion|first|second|third|(four|fif|six|seven|eigh|nin|ten|eleven|twelf|(thir|four|fif|six|seven|eigh|nine)teen|(twen|thir|for|fif|six|seven|eigh|nine)tie|hundred|thousand|million|billion)th|\p{N}+)$/u;

// Apostrophes are stripped before lookup, so "I'll" and the ASR spelling "ill" both expand.
const CONTRACTIONS: Record<string, string> = {
  im: "i am",
  ive: "i have",
  ill: "i will",
  id: "i would",
  youre: "you are",
  youve: "you have",
  youll: "you will",
  youd: "you would",
  hes: "he is",
  shes: "she is",
  its: "it is",
  were: "we are",
  weve: "we have",
  wed: "we would",
  theyre: "they are",
  theyve: "they have",
  theyll: "they will",
  theyd: "they would",
  thats: "that is",
  whats: "what is",
  theres: "there is",
  heres: "here is",
  wheres: "where is",
  lets: "let us",
  cant: "can not",
  cannot: "can not",
  wont: "will not",
  dont: "do not",
  doesnt: "does not",
  didnt: "did not",
  isnt: "is not",
  arent: "are not",
  wasnt: "was not",
  werent: "were not",
  hasnt: "has not",
  havent: "have not",
  hadnt: "had not",
  couldnt: "could not",
  shouldnt: "should not",
  wouldnt: "would not",
  gonna: "going to",
  wanna: "want to",
  gotta: "got to",
  kinda: "kind of",
  sorta: "sort of",
  cause: "because",
  til: "until",
  till: "until",
  ok: "okay",
};

const PHRASE = new RegExp(
  ` (?:${[...FILLERS, ...SPOKEN_SYMBOLS].filter((entry) => entry.includes(" ")).join("|")})(?= )`,
  "g",
);

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
      .trim()
  );
}

const words = (text: string): string[] => normalize(text).split(" ").filter(Boolean);

function contentWords(text: string): string[] {
  return ` ${normalize(text)} `
    .replaceAll(PHRASE, "")
    .split(" ")
    .flatMap((word) => (CONTRACTIONS[word] ?? word).split(" "))
    .filter(
      (word) =>
        word !== "" && !FILLERS.has(word) && !SPOKEN_SYMBOLS.has(word) && !NUMBER_WORD.test(word),
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

// The share of the input's content words that the output still contains, counted with
// multiplicity so a dictation that repeats itself cannot pass on its vocabulary alone.
export function wordRecall(input: string, output: string): number {
  const said = withoutFalseStarts(contentWords(input));
  if (said.length === 0) return 1;
  const remaining = new Map<string, number>();
  for (const word of contentWords(output)) remaining.set(word, (remaining.get(word) ?? 0) + 1);
  let kept = 0;
  for (const word of said) {
    const count = remaining.get(word) ?? 0;
    if (count > 0) {
      kept++;
      remaining.set(word, count - 1);
    }
  }
  return kept / said.length;
}

export function assertPlausibleCleanup(input: string, output: string, truncated: boolean): void {
  if (truncated) throw new Error("Cleanup output was cut off at the token limit");
  if (output.length > MAX_OUTPUT_RATIO * input.length)
    throw new Error(`Cleanup output is over ${MAX_OUTPUT_RATIO}x the input length`);
  if (/<\/?think>|<\|im_(start|end)\|>/.test(output))
    throw new Error("Cleanup output contains chat template markup");
  const said = ` ${words(input).join(" ")} `;
  const cleaned = ` ${words(output).join(" ")} `;
  const opener = CHAT_OPENER_SPELLINGS.find((group) =>
    group.some((phrase) => cleaned.startsWith(` ${phrase} `)),
  );
  if (opener && !opener.some((phrase) => said.includes(` ${phrase} `)))
    throw new Error("Cleanup output reads like a chat reply");
  const recall = wordRecall(input, output);
  if (recall < MIN_WORD_RECALL) {
    throw new Error(
      output.trim()
        ? `Cleanup kept only ${Math.round(recall * 100)}% of the words said`
        : "Cleanup output is empty for speech that is not filler",
    );
  }
}
