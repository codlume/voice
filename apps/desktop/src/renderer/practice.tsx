import { useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { SaveButton } from "@voice/ui/settings";
import { tokens } from "@voice/ui/tokens.stylex";
import type { Reply } from "@voice/contracts/desktop";
import type { SessionCommand } from "@voice/contracts/session";
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
  controls: { display: "flex", gap: 12, marginBlock: 16 },
  label: { display: "grid", gap: 8, fontSize: 13 },
  field: {
    backgroundColor: tokens.background,
    color: tokens.ink,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: tokens.border,
    borderRadius: 6,
    padding: 12,
    minHeight: 96,
    fontSize: 14,
    resize: "vertical",
  },
});
export function PracticeView({
  reply,
  onReply,
}: {
  reply: Reply | undefined;
  onReply: (reply: Reply) => void;
}) {
  const session = reply?.ok ? reply.session : undefined;
  const [error, setError] = useState("");
  const active = session && ["starting", "recording", "processing"].includes(session.phase);
  async function run(type: SessionCommand["type"]) {
    setError("");
    try {
      onReply(await window.voice.command({ type }));
    } catch {
      setError("Practice could not connect. Reopen Voice to repair.");
    }
  }
  return (
    <section {...stylex.props(styles.section)} aria-label="Practice dictation">
      <h2 {...stylex.props(styles.heading)}>Try a practice dictation</h2>
      <p {...stylex.props(styles.text)}>
        Press Start practice, speak, then Stop. The finished transcript appears only in the practice
        field below. Recording never starts automatically.
      </p>
      <div {...stylex.props(styles.controls)}>
        <SaveButton disabled={!session?.canStart} onClick={() => void run("session.start")}>
          Start practice
        </SaveButton>
        <SaveButton
          disabled={!session || !["starting", "recording"].includes(session.phase)}
          onClick={() => void run("session.stop")}
        >
          Stop
        </SaveButton>
        <SaveButton disabled={!active} onClick={() => void run("session.cancel")}>
          Cancel
        </SaveButton>
      </div>
      <p aria-live="polite" data-testid="practice-status" {...stylex.props(styles.text)}>
        {error || session?.message || "Complete setup to start practice."}
      </p>
      {reply?.ok && reply.setup?.connectivity === "offline" && active && (
        <p {...stylex.props(styles.text)}>
          You are offline. Audio stays in memory; transcription needs internet.
        </p>
      )}
      <label {...stylex.props(styles.label)}>
        Practice transcript
        <textarea {...stylex.props(styles.field)} readOnly value={session?.practiceText ?? ""} />
      </label>
      {!!session?.retainedCount && (
        <>
          <p {...stylex.props(styles.text)}>
            {session.retainedCount} unfinished session(s) remain in memory until Voice quits. Retry
            and recovery controls are not available yet. You can select and copy the available text
            below.
          </p>
          {!active && (
            <label {...stylex.props(styles.label)}>
              Available text, may be incomplete
              <textarea {...stylex.props(styles.field)} readOnly value={session.retainedText} />
            </label>
          )}
        </>
      )}
      <p {...stylex.props(styles.text)}>
        Recognition can change names or identifiers, including the known "fix" to "fixed" error.
        Spoken formatting commands may remain literal. Check the transcript before using it.
      </p>
    </section>
  );
}
