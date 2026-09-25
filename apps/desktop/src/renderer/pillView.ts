import type { Outcome, PillState } from "../shared/api.ts";

export type PillView =
  | { kind: "idle" }
  | { kind: "listening" }
  | { kind: "processing" }
  | { kind: "inserted" }
  | { kind: "message"; text: string };

const notInsertedText: Record<Extract<Outcome, { kind: "notInserted" }>["reason"], string> = {
  focusChanged: "Not inserted. Focus changed",
  noFocusedField: "Not inserted. No text field",
  secureInput: "Not inserted. Secure field",
  failed: "Not inserted. Copy it from Voice",
};

function outcomeView(outcome: Outcome): PillView {
  switch (outcome.kind) {
    case "inserted":
      return { kind: "inserted" };
    case "cancelled":
      return { kind: "idle" };
    case "empty":
      return { kind: "message", text: "Nothing heard" };
    case "tooShort":
      return { kind: "message", text: "Too short. Hold to talk" };
    case "notInserted":
      return { kind: "message", text: notInsertedText[outcome.reason] };
    case "failed":
      return { kind: "message", text: outcome.message };
  }
}

export function pillView(session: PillState): PillView {
  return session.kind === "done" ? outcomeView(session.outcome) : session;
}

export const BAR_COUNT = 11;
export const MIN_BAR_SCALE = 0.18;

// Rises fast so speech onsets feel immediate, falls slower so the bars settle instead of flickering.
export function smoothLevel(previous: number, next: number): number {
  const target = Math.min(1, Math.max(0, next));
  const rate = target > previous ? 0.6 : 0.25;
  return previous + (target - previous) * rate;
}

// Center bars reach higher; the tick shifts a slow ripple across the bars so a steady level
// still reads as a moving waveform rather than a pulsing block.
export function barScales(level: number, tick: number): number[] {
  const loud = Math.sqrt(Math.min(1, Math.max(0, level)));
  return Array.from({ length: BAR_COUNT }, (_, i) => {
    const center = 1 - Math.abs(i - (BAR_COUNT - 1) / 2) / BAR_COUNT;
    const ripple = 0.7 + 0.3 * Math.sin(tick * 0.9 + i * 1.7);
    return MIN_BAR_SCALE + (1 - MIN_BAR_SCALE) * loud * center * ripple;
  });
}
