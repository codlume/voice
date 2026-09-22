import { useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { SaveButton } from "@voice/ui/settings";
import { tokens } from "@voice/ui/tokens.stylex";
import { defaultSetupPreferences } from "@voice/contracts/setup";
import {
  isCancellable,
  isCapturing,
  startBlockerMessages,
  type SessionCommand,
} from "@voice/contracts/session";
import type { Command, Reply } from "@voice/contracts/desktop";
import { repairAction } from "./notice";

const styles = stylex.create({
  section: {
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: tokens.border,
    paddingBottom: 24,
    marginBottom: 24,
  },
  heading: { fontSize: 17, fontWeight: 600, marginTop: 0, marginBottom: 12 },
  text: { color: tokens.muted, fontSize: 13, lineHeight: 1.6 },
  keys: { color: tokens.ink, fontWeight: 600 },
  controls: { display: "flex", flexWrap: "wrap", gap: 12, marginBlock: 16 },
});
export function DictationView({
  reply,
  onReply,
}: {
  reply: Reply | undefined;
  onReply: (reply: Reply) => void;
}) {
  const [error, setError] = useState("");
  const shortcuts =
    (reply?.ok && reply.settings.setup?.shortcuts) || defaultSetupPreferences.shortcuts;
  const listening = reply?.ok && reply.status.shortcuts === "listening";
  const session = reply?.ok ? reply.session : undefined;
  const repair = session && repairAction(session);
  async function run(command: SessionCommand | Extract<Command, { type: "app.open" }>) {
    setError("");
    try {
      const result = await window.voice.command(command);
      if (result.ok) onReply(result);
      else setError("Voice could not complete that action. Your work remains in memory.");
    } catch {
      setError("Voice could not connect. Reopen Voice to repair.");
    }
  }
  return (
    <section {...stylex.props(styles.section)} aria-label="System-wide dictation">
      <h2 {...stylex.props(styles.heading)}>Dictate into any text field</h2>
      <p {...stylex.props(styles.text)}>
        Click into a text field in another app, then hold{" "}
        <span {...stylex.props(styles.keys)}>{shortcuts.hold}</span> and speak. Release to insert
        the transcript at the caret or over the selection. Press{" "}
        <span {...stylex.props(styles.keys)}>{shortcuts.toggle}</span> for hands-free dictation and{" "}
        <span {...stylex.props(styles.keys)}>{shortcuts.cancel}</span> to cancel. The floating bar
        and the Voice menu-bar icon also start, stop, and cancel without moving your focus.
      </p>
      <p {...stylex.props(styles.text)}>
        Voice inserts only into the field that was focused when you started. If focus moves, the
        field closes, or the insertion cannot be confirmed, the transcript waits in Temporary
        recovery. Terminals are not supported yet.
      </p>
      <p {...stylex.props(styles.text)}>
        Starting here keeps the transcript in recovery, because this window is in front.
      </p>
      <div {...stylex.props(styles.controls)}>
        <SaveButton
          disabled={!session || session.blocker !== null}
          onClick={() => void run({ type: "session.start", origin: "dictation" })}
        >
          Start dictation
        </SaveButton>
        <SaveButton
          disabled={!session || !isCapturing(session)}
          onClick={() => void run({ type: "session.stop" })}
        >
          Stop
        </SaveButton>
        <SaveButton
          disabled={!session || !isCancellable(session)}
          onClick={() => void run({ type: "session.cancel" })}
        >
          Cancel
        </SaveButton>
        {repair && (
          <SaveButton onClick={() => void run({ type: "app.open", view: repair.view })}>
            {repair.label}
          </SaveButton>
        )}
      </div>
      {session?.blocker && session.blocker !== "busy" && (
        <p data-testid="start-blocker" {...stylex.props(styles.text)}>
          Start unavailable: {startBlockerMessages[session.blocker]}
        </p>
      )}
      <p aria-live="polite" data-testid="dictation-status" {...stylex.props(styles.text)}>
        Shortcuts: {listening ? "listening" : "unavailable until setup is complete"}.
        {session?.origin === "dictation" ? ` Last session: ${session.message}` : ""}
      </p>
      {error && (
        <p role="alert" {...stylex.props(styles.text)}>
          {error}
        </p>
      )}
    </section>
  );
}
