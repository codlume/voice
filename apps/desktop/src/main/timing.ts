// What the two effect runners share about time, so neither imports the other for it.

/** A time budget that grows with the text and stops at a cap. */
export type Budget = { base: number; perWord: number; max: number };

export const budget = ({ base, perWord, max }: Budget, words: number) =>
  Math.min(max, base + perWord * words);

/** The one log line per run: `<kind> <id8> outcome=<outcome> key=value…`. Numbers are rounded. */
export function timingLine(
  kind: string,
  id: string,
  outcome: string,
  fields: Record<string, number | string | undefined>,
): string {
  const parts = Object.entries(fields).flatMap(([key, value]) =>
    value === undefined ? [] : [`${key}=${typeof value === "number" ? Math.round(value) : value}`],
  );
  return [`${kind} ${id.slice(0, 8)} outcome=${outcome}`, ...parts].join(" ");
}
