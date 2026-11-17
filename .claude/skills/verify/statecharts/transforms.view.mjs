export const title = "Transforms: rewrite the selection in place";

const RUNNING = {
  reading: "Reading the selection",
  rewriting: "Rewriting",
  replacing: "Replacing the selection",
};

const LATE = "Pill says text unchanged, but it was replaced";

const outcomeLabel = (v) => {
  if (v.outcome === "replaced") return "Replaced";
  if (v.text !== "original") return LATE;
  if (v.outcome === "cancelled") return "Cancelled. Text unchanged";
  if (v.outcome === "notReplaced") return "Not replaced. Result is in Voice";
  return "Refused or failed. Text unchanged";
};

export const state = (v) => {
  if (v.phase === "idle") return v.on ? "Ready" : "Transforms off";
  if (v.phase in RUNNING) return ["Pill shows the run working", RUNNING[v.phase]];
  return ["Pill shows the outcome", outcomeLabel(v)];
};

export const group = (v) => {
  if (v.phase === "idle") return "idle";
  if (v.phase === "done") return "outcome";
  return "running";
};

export const colors = { idle: "tan", running: "blue", outcome: "teal" };

// An earlier run's write that lands late reaches the same chart state from every state of a
// later run. The chart keeps the one arrow from "Not replaced" and hides the rest. It also
// hides a new shortcut pressed while the pill still shows an outcome, which repeats the
// arrows out of Ready.
const hidden = (action, from, to) => {
  if (from.phase === "done" && action === "YouPressTheShortcutModelMissing") return true;
  if (to.phase === "done" && from.phase !== "done" && outcomeLabel(to) === LATE) {
    return from.phase !== "replacing" || from.text !== "original";
  }
  return (
    action === "HelperWriteLands" &&
    from.phase === "done" &&
    !(from.outcome === "notReplaced" && from.text === "original")
  );
};

const label = (action, from, to) => {
  switch (action) {
    case "YouTurnTransformsOn":
      return "you turn Transforms on";
    case "YouTurnTransformsOff":
      return from.phase in RUNNING
        ? "you press Escape or turn Transforms off"
        : "you turn Transforms off";
    case "YouPressEscape":
      return "you press Escape or turn Transforms off";
    case "YouPressTheShortcut":
      return "you press Option+1 or Option+2";
    case "YouPressTheShortcutModelMissing":
      return "you press Option+1 or Option+2 [model not set up]";
    case "HelperReadsByAccessibility":
    case "HelperGetsCopy":
    case "ReadTimesOut":
      return to.phase === "rewriting"
        ? "Voice reads the selection"
        : "nothing selected, a secure field, or the read fails";
    case "RewriteFinishes":
    case "RewriteFails":
      return to.phase === "replacing"
        ? "the rewrite finishes"
        : "the rewrite fails, is unusable, or is too long";
    case "HelperWriteLands":
      return from.phase === "replacing" ? "the write lands" : "the timed-out write lands late";
    case "HelperWriteRefused":
    case "WriteTimesOut":
      return "the write is refused or times out";
    case "PillHides":
      return "the pill hides";
    default:
      return action;
  }
};

export const step = (action, from, to) =>
  hidden(action, from, to) ? null : label(action, from, to);
