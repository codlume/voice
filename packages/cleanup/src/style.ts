export const WRITING_STYLES = ["formal", "casual", "veryCasual"] as const;
export type WritingStyle = (typeof WRITING_STYLES)[number];
export const LAYOUTS = ["general", "email"] as const;
export type CleanupStyle = { style: WritingStyle; layout: (typeof LAYOUTS)[number] };

type Finish = { chunk(text: string): string; last(text: string): string };

const CASE_SENSITIVE = /:\/\/|[/@_=#]|\.[\p{L}\p{N}]{2,}/u;

const same = (text: string) => text;
const lowercase = (text: string) =>
  text.replace(/\S+/gu, (token) => (CASE_SENSITIVE.test(token) ? token : token.toLowerCase()));

const FINISHES: Record<WritingStyle, Finish> = {
  formal: { chunk: same, last: same },
  casual: { chunk: same, last: dropFinalPeriod },
  veryCasual: { chunk: lowercase, last: dropFinalPeriod },
};

export function finishOutputs(
  style: WritingStyle,
  outputs: readonly (string | undefined)[],
): (string | undefined)[] {
  const { chunk, last } = FINISHES[style];
  const finished = outputs.map((output) => (output === undefined ? undefined : chunk(output)));
  const end = finished.findLastIndex((output) => output !== "");
  const ending = finished[end];
  if (ending !== undefined) finished[end] = last(ending);
  return finished;
}

export function finishText(style: WritingStyle, text: string): string {
  const { chunk, last } = FINISHES[style];
  return last(chunk(text));
}

const ABBREVIATION_END =
  /(?:^|[^\p{L}\p{N}.])(?:(?:\p{L}\.){2,}|(?:etc|vs|dr|mr|mrs|ms|jr|sr|inc|ltd)\.)$/iu;

export function dropFinalPeriod(text: string): string {
  return /[^.]\.$/u.test(text) && !ABBREVIATION_END.test(text) ? text.slice(0, -1) : text;
}
