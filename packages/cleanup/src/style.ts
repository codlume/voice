export const WRITING_STYLES = ["formal", "casual", "veryCasual"] as const;
export type WritingStyle = (typeof WRITING_STYLES)[number];
export const LAYOUTS = ["general", "email"] as const;
export type CleanupStyle = { style: WritingStyle; layout: (typeof LAYOUTS)[number] };

type Finish = { chunk(text: string): string; last(text: string): string };

const same = (text: string) => text;
const lowercase = (text: string) => text.toLowerCase();

const FINISHES: Record<WritingStyle, Finish> = {
  formal: { chunk: same, last: same },
  casual: { chunk: same, last: dropFinalPeriod },
  veryCasual: { chunk: lowercase, last: dropFinalPeriod },
};

export function finishChunk(style: WritingStyle, text: string, last: boolean): string {
  const { chunk, last: ending } = FINISHES[style];
  return last ? ending(chunk(text)) : chunk(text);
}

const ABBREVIATION_END =
  /(?:^|[^\p{L}\p{N}.])(?:(?:\p{L}\.){2,}|(?:etc|vs|dr|mr|mrs|ms|jr|sr|inc|ltd)\.)$/iu;

export function dropFinalPeriod(text: string): string {
  return /[^.]\.$/u.test(text) && !ABBREVIATION_END.test(text) ? text.slice(0, -1) : text;
}
