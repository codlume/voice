import {
  isCancellable,
  isCapturing,
  startBlockerMessages,
  type SessionCommand,
  type SessionSnapshot,
} from "@voice/contracts/session";
import type { View } from "@voice/contracts/desktop";

export type MenuEntry =
  | { type: "separator" }
  | { label: string; enabled: boolean; sublabel?: string; run?: () => void };

// Menu-bar items for the one session. Each action is the same session command the other entry
// points send; a disabled action names its cause and is never queued for later.
export function menuEntries(
  snapshot: SessionSnapshot,
  actions: {
    session: (command: SessionCommand) => void;
    open: (view: View) => void;
    quit: () => void;
  },
): MenuEntry[] {
  const { armedPaste, blocker, lastTranscript } = snapshot;
  const pasteBlocker =
    blocker === "busy" || blocker === "paste" || blocker === "quitting" ? blocker : null;
  const held = snapshot.recovery.length;
  return [
    { label: statusLabel(snapshot), enabled: false },
    { type: "separator" },
    {
      label: "Start dictation",
      enabled: blocker === null,
      ...(blocker ? { sublabel: startBlockerMessages[blocker] } : {}),
      run: () => actions.session({ type: "session.start", origin: "dictation" }),
    },
    {
      label: "Stop",
      enabled: isCapturing(snapshot),
      run: () => actions.session({ type: "session.stop" }),
    },
    {
      label: armedPaste ? "Cancel paste" : "Cancel",
      enabled: isCancellable(snapshot),
      run: () => actions.session({ type: "session.cancel" }),
    },
    { type: "separator" },
    {
      label: "Copy last transcript",
      enabled: lastTranscript !== null,
      ...(lastTranscript ? {} : { sublabel: "No transcript is held." }),
      run: () => lastTranscript && actions.session({ type: "recovery.copy", id: lastTranscript }),
    },
    {
      label: "Paste last transcript",
      enabled: lastTranscript !== null && pasteBlocker === null,
      ...(lastTranscript
        ? pasteBlocker
          ? { sublabel: startBlockerMessages[pasteBlocker] }
          : {}
        : { sublabel: "No transcript is held." }),
      run: () => lastTranscript && actions.session({ type: "recovery.paste", id: lastTranscript }),
    },
    {
      label: held ? `Open recovery (${held} of 5)` : "Open recovery",
      enabled: true,
      run: () => actions.open("recovery"),
    },
    { type: "separator" },
    { label: "Open Voice Settings", enabled: true, run: () => actions.open("setup") },
    { label: "Quit Voice", enabled: true, run: actions.quit },
  ];
}
export function statusLabel({ phase, armedPaste, blocker, notice }: SessionSnapshot) {
  if (armedPaste) return "Paste: click the destination field";
  if (phase === "starting") return "Starting microphone…";
  if (phase === "recording")
    return notice === "connection"
      ? "Recording · offline"
      : notice === "rate-limit"
        ? "Recording · rate limited"
        : "Recording";
  if (phase === "processing")
    return notice === "connection" ? "Transcribing · waiting for connection" : "Transcribing…";
  if (phase === "inserting") return "Inserting…";
  if (blocker === "setup") return "Setup needs attention";
  if (blocker === "recovery-full") return "Recovery is full";
  return "Ready";
}
