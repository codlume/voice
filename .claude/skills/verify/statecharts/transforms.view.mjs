export const title = "Transforms: rewrite the selection in place";

const RUNNING = {
  reading: "Reading the selection",
  rewriting: "Rewriting",
  replacing: "Replacing the selection",
};

const outcomeLabel = (v) => {
  if (v.outcome === "replaced") return "Replaced";
  if (v.outcome === "cancelled") return "Cancelled. Text unchanged";
  if (v.outcome === "notReplaced") return "Not replaced. Result is in Voice";
  if (v.outcome === "notConfirmed") return "Not confirmed. Check the text";
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

// The chart hides a new shortcut pressed while the pill still shows an outcome, which repeats
// the arrows out of Ready.
const hidden = (action, from) =>
  from.phase === "done" && action === "YouPressTheShortcutModelMissing";

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
      return "the write lands";
    case "HelperWriteUnconfirmed":
      return "the app does not answer the write in time";
    case "HelperWriteRefused":
    case "WriteTimesOut":
      return "the write is refused or times out";
    case "PillHides":
      return "the pill hides";
    default:
      return action;
  }
};

export const step = (action, from, to) => (hidden(action, from) ? null : label(action, from, to));
