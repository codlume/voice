import { useEffect, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { SaveButton, dark } from "@voice/ui/settings";
import { tokens } from "@voice/ui/tokens.stylex";
import {
  isBusy,
  isCancellable,
  isCapturing,
  startBlockerMessages,
  type SessionCommand,
} from "@voice/contracts/session";
import type { Command, Reply } from "@voice/contracts/desktop";
import { repairAction } from "./notice";

// The floating bar. Main docks it compact after setup and widens it while a session or paste runs,
// briefly for a dictation outcome, and while setup or recovery blocks Start. The window never takes
// focus and the helper replays real clicks into it, so the external target stays focused.
// Nothing animates.
const compact = "@media (max-width: 240px)";
const styles = stylex.create({
  bar: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    height: "100vh",
    paddingInline: { default: 16, [compact]: 10 },
    boxSizing: "border-box",
    backgroundColor: tokens.panel,
    color: tokens.ink,
    fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
    fontSize: 13,
    lineHeight: 1.4,
    userSelect: "none",
  },
  dot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0, backgroundColor: tokens.muted },
  recording: { backgroundColor: "#ff5f57" },
  text: {
    display: { default: "block", [compact]: "none" },
    flexGrow: 1,
    minWidth: 0,
    margin: 0,
  },
  message: {
    margin: 0,
    overflow: "hidden",
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 3,
  },
  cause: { margin: 0, color: tokens.muted, fontSize: 12 },
  controls: { display: "flex", gap: 8, flexShrink: 0 },
  secondary: { display: { default: "inline-flex", [compact]: "none" } },
});
export function StatusView() {
  const [reply, setReply] = useState<Reply | undefined>(undefined);
  const [error, setError] = useState(false);
  useEffect(() => {
    document.title = "Voice status";
    let active = true;
    const refresh = async () => {
      try {
        const value = await window.voice.command({ type: "status.get" });
        if (active) setReply(value);
      } catch {
        /* The bar only mirrors state; the main window reports connection problems. */
      }
    };
    const unsubscribe = window.voice.onChanged(() => {
      void refresh();
    });
    void refresh();
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  const session = reply?.ok ? reply.session : undefined;
  async function run(command: SessionCommand | Extract<Command, { type: "app.open" }>) {
    setError(false);
    try {
      const result = await window.voice.command(command);
      if (result.ok) setReply(result);
      else setError(true);
    } catch {
      setError(true);
    }
  }
  if (!session)
    return (
      <div role="status" aria-label="Dictation status" {...stylex.props(dark, styles.bar)}>
        <span aria-hidden {...stylex.props(styles.dot)} />
        <p data-testid="panel-status" {...stylex.props(styles.text, styles.message)}>
          Connecting…
        </p>
      </div>
    );
  const busy = isBusy(session);
  const capturing = isCapturing(session);
  const cause =
    session.blocker === "setup" || session.blocker === "recovery-full"
      ? startBlockerMessages[session.blocker]
      : "";
  const message = session.armedPaste
    ? `Paste: ${session.recoveryMessage}`
    : !busy && session.lastUpdate === "recovery" && session.recoveryMessage
      ? session.recoveryMessage
      : session.phase === "idle"
        ? cause || "Ready."
        : session.message;
  const repair = repairAction(session);
  return (
    <div role="status" aria-label="Dictation status" {...stylex.props(dark, styles.bar)}>
      <span
        aria-hidden
        {...stylex.props(styles.dot, session.phase === "recording" && styles.recording)}
      />
      <div {...stylex.props(styles.text)}>
        <p data-testid="panel-status" {...stylex.props(styles.message)}>
          {error ? "Voice could not complete that action." : message}
        </p>
        {!busy && session.phase !== "idle" && cause && (
          <p {...stylex.props(styles.cause)}>Start unavailable: {cause}</p>
        )}
      </div>
      <div {...stylex.props(styles.controls)}>
        {capturing ? (
          <SaveButton onClick={() => void run({ type: "session.stop" })}>Stop</SaveButton>
        ) : (
          !busy && (
            <SaveButton
              aria-label="Start dictation"
              title={session.blocker ? startBlockerMessages[session.blocker] : undefined}
              disabled={session.blocker !== null}
              onClick={() => void run({ type: "session.start", origin: "dictation" })}
            >
              Start
            </SaveButton>
          )
        )}
        {isCancellable(session) && (
          <SaveButton onClick={() => void run({ type: "session.cancel" })}>
            {session.armedPaste ? "Cancel paste" : "Cancel"}
          </SaveButton>
        )}
        {repair && !busy && (
          <span {...stylex.props(styles.secondary)}>
            <SaveButton onClick={() => void run({ type: "app.open", view: repair.view })}>
              {repair.label}
            </SaveButton>
          </span>
        )}
      </div>
    </div>
  );
}
