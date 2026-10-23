import { wordSurvival } from "../plausibility.ts";

export type Verdict =
  | { ok: true; text: string }
  | { ok: false; reason: "truncated" | "empty" | "endsEarly" | "lostOpening" };

// Gemma stops early on long list-like text, and the shortened result reads as finished. Its last
// sentence then matches an input sentence well before the end. A sentence shares at least this
// much with the output's ending to count as found; a translation or a heavy rewrite shares less,
// so its ending cannot be located and the guard accepts it.
const LOCATE_SHARE = 0.5;
// The words that may follow the located sentence: 4 of 4 real early stops had more, 0 of 11
// legitimate results did (measured, #312).
const allowedGap = (inputWords: number) => Math.max(40, 0.1 * inputWords);
// A dictated command the model carried out (a translation, a grammar fix, a commit message) keeps
// almost none of the dictation's opening words. On 118 recorded Polish dictations this rejected
// 6 of 12 carried-out commands, all three translations among them, and 0 of 106 legitimate
// results; the lowest legitimate result kept 3 of its first 8 content words (measured, #312).
const MIN_DICTATION_HEAD = 0.25;

export function guard(
  input: string,
  output: string,
  { truncated, dictation }: { truncated: boolean; dictation: boolean },
): Verdict {
  if (truncated) return { ok: false, reason: "truncated" };
  const text = unwrap(output.trim());
  if (!text) return { ok: false, reason: "empty" };
  if (endsEarly(input, text)) return { ok: false, reason: "endsEarly" };
  if (dictation && wordSurvival(input, text).head < MIN_DICTATION_HEAD) {
    return { ok: false, reason: "lostOpening" };
  }
  return { ok: true, text };
}

function unwrap(output: string): string {
  return output.startsWith("<text>") && output.endsWith("</text>")
    ? output.slice("<text>".length, -"</text>".length).trim()
    : output;
}

function endsEarly(input: string, output: string): boolean {
  const outputSentences = sentences(output);
  let probe = outputSentences.at(-1) ?? "";
  if (contentWords(probe).length < 3 && outputSentences.length > 1) {
    probe = outputSentences.slice(-2).join(" ");
  }
  const probeWords = new Set(contentWords(probe));
  if (probeWords.size === 0) return false;

  let bestShare = -1;
  let wordsThroughBest = 0;
  let wordsSoFar = 0;
  for (const sentence of sentences(input)) {
    const sentenceWords = new Set(contentWords(sentence));
    const share =
      [...probeWords].filter((word) => sentenceWords.has(word)).length / probeWords.size;
    wordsSoFar += words(sentence).length;
    if (share >= bestShare) {
      bestShare = share;
      wordsThroughBest = wordsSoFar;
    }
  }
  if (bestShare < LOCATE_SHARE) return false;
  const inputWords = words(input).length;
  return inputWords - wordsThroughBest > allowedGap(inputWords);
}

const sentences = (text: string) =>
  text
    .split(/(?<=[.!?:])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

const contentWords = (text: string) =>
  words(text).filter((word) => word.length >= 4 && !STOP_WORDS.has(word));

const STOP_WORDS = new Set(
  `about above after again against also although always among another anyone anything around
  because been before being below between both cannot could does doing down during each either
  else enough even ever every first from further have having here hers herself himself however
  into itself just know last least less like made make many maybe more most much must myself near
  need never next once only other ought ours ourselves over own perhaps quite rather really same
  shall should since some something still such than that their theirs them themselves then there
  these they thing things think this those though through thus together under until upon very
  want well were what whatever when where whether which while whom whose will with within without
  would your yours yourself yourselves okay yeah basically actually honestly kind sort going mean`.split(
    /\s+/,
  ),
);
