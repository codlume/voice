import type { InsertFailure, Outcome, PillState, TransformOutcome } from "../shared/api.ts";

type PillView =
  | { kind: "idle" }
  | { kind: "listening" }
  | { kind: "processing" }
  | { kind: "inserted"; method: Extract<Outcome, { kind: "inserted" }>["method"] }
  | { kind: "message"; text: string };

const notInsertedText: Record<InsertFailure, { copyOff: string; copyOn: string }> = {
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
  selectionChanged: {
    copyOff: "Not inserted. Text changed",
    copyOn: "Text changed. Copied to clipboard",
  },
  failed: {
    copyOff: "Not inserted. Copy it from Voice",
    copyOn: "Not inserted. Copied to clipboard",
  },
};

function outcomeView(outcome: Outcome): PillView {
  switch (outcome.kind) {
    case "inserted":
      return { kind: "inserted", method: outcome.method };
    case "empty":
      return { kind: "message", text: "Nothing heard" };
    case "tooShort":
      return { kind: "message", text: "Too short. Hold to talk" };
    case "notInserted": {
      const text = notInsertedText[outcome.reason];
      return { kind: "message", text: outcome.copied ? text.copyOn : text.copyOff };
    }
    case "failed":
      return { kind: "message", text: outcome.message };
  }
}

const transformNotInsertedText: Record<InsertFailure, string> = {
  focusChanged: "Focus changed. Result is in Voice",
  noFocusedField: "Can't write here. Result is in Voice",
  secureInput: "Secure field. Result is in Voice",
  selectionChanged: "Text changed. Result is in Voice",
  failed: "Not replaced. Result is in Voice",
};

function transformModelText(outcome: Extract<TransformOutcome, { kind: "modelUnavailable" }>) {
  switch (outcome.state) {
    case "missing":
      return "Set up the transform model in Voice";
    case "downloading":
      return outcome.progress === undefined
        ? "Transform model downloading"
        : `Transform model downloading ${Math.round(outcome.progress * 100)}%`;
    case "failed":
      return "Transform model failed. See Models";
  }
}

function transformOutcomeView(outcome: TransformOutcome): PillView {
  switch (outcome.kind) {
    case "inserted":
      return { kind: "inserted", method: outcome.method };
    case "notInserted":
      return { kind: "message", text: transformNotInsertedText[outcome.reason] };
    case "noSelection":
      return { kind: "message", text: "Select text first" };
    case "secureInput":
      return { kind: "message", text: "Can't read a secure field" };
    case "noFocusedField":
      return { kind: "message", text: "Click into the text first" };
    case "keysHeld":
      return { kind: "message", text: "Release the keys, then try again" };
    case "tooLong":
      return { kind: "message", text: `Too long. Select up to ${outcome.maxWords} words` };
    case "modelUnavailable":
      return { kind: "message", text: transformModelText(outcome) };
    case "cancelled":
      return { kind: "message", text: "Cancelled. Text unchanged" };
    case "failed":
      return { kind: "message", text: outcome.message };
  }
}

export function pillView(session: PillState): PillView {
  switch (session.kind) {
    case "done":
      return outcomeView(session.outcome);
    case "processing":
      return session.overdue
        ? { kind: "message", text: "Still transcribing" }
        : { kind: "processing" };
    case "transformDone":
      return transformOutcomeView(session.outcome);
    case "transforming":
      return session.loading ? { kind: "message", text: "Loading model" } : { kind: "processing" };
    case "idle":
    case "listening":
      return session;
  }
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
  const loud = Math.sqrt(level);
  return Array.from({ length: BAR_COUNT }, (_, i) => {
    const center = 1 - Math.abs(i - (BAR_COUNT - 1) / 2) / BAR_COUNT;
    const ripple = 0.7 + 0.3 * Math.sin(tick * 0.9 + i * 1.7);
    return MIN_BAR_SCALE + (1 - MIN_BAR_SCALE) * loud * center * ripple;
  });
}
