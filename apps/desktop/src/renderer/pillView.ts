import type { Outcome, PillState } from "../shared/api.ts";

type PillView =
  | { kind: "idle" }
  | { kind: "listening" }
  | { kind: "processing" }
  | { kind: "inserted"; method: Extract<Outcome, { kind: "inserted" }>["method"] }
  | { kind: "message"; text: string };

const notInsertedText: Record<
  Extract<Outcome, { kind: "notInserted" }>["reason"],
  { copyOff: string; copyOn: string }
> = {
  focusChanged: {
    copyOff: "Not inserted. Focus changed",
    copyOn: "Focus changed. Copied to clipboard",
  },
  noFocusedField: {
    copyOff: "Not inserted. No text field",
    copyOn: "No text field. Copied to clipboard",
  },
  secureInput: {
    copyOff: "Not inserted. Secure field",
    copyOn: "Secure field. Copied to clipboard",
  },
  failed: {
    copyOff: "Not inserted. Copy it from Voice",
    copyOn: "Not inserted. Copied to clipboard",
  },
};

function outcomeView(outcome: Outcome, copyToClipboard: boolean): PillView {
  switch (outcome.kind) {
    case "inserted":
      return { kind: "inserted", method: outcome.method };
    case "empty":
      return { kind: "message", text: "Nothing heard" };
    case "tooShort":
      return { kind: "message", text: "Too short. Hold to talk" };
    case "notInserted": {
      const text = notInsertedText[outcome.reason];
      return { kind: "message", text: copyToClipboard ? text.copyOn : text.copyOff };
    }
    case "failed":
      return { kind: "message", text: outcome.message };
  }
}

export function pillView(
  session: PillState,
  { copyToClipboard }: { copyToClipboard: boolean },
): PillView {
  return session.kind === "done" ? outcomeView(session.outcome, copyToClipboard) : session;
}

export const BAR_COUNT = 11;
export const MIN_BAR_SCALE = 0.18;
const LEVEL_RISE_RATE = 0.6;
const LEVEL_FALL_RATE = 0.25;

export function smoothLevel(previous: number, next: number): number {
  const target = Math.min(1, Math.max(0, next));
  const rate = target > previous ? LEVEL_RISE_RATE : LEVEL_FALL_RATE;
  return previous + (target - previous) * rate;
}

export function barScales(level: number, tick: number): number[] {
  const loud = Math.sqrt(Math.min(1, Math.max(0, level)));
  return Array.from({ length: BAR_COUNT }, (_, i) => {
    const center = 1 - Math.abs(i - (BAR_COUNT - 1) / 2) / BAR_COUNT;
    const ripple = 0.7 + 0.3 * Math.sin(tick * 0.9 + i * 1.7);
    return MIN_BAR_SCALE + (1 - MIN_BAR_SCALE) * loud * center * ripple;
  });
}
