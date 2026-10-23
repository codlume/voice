export type Budget = { base: number; perWord: number; max: number };

export const budget = ({ base, perWord, max }: Budget, words: number) =>
  Math.min(max, base + perWord * words);

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
