import { useEffect, useRef, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { SaveButton } from "@voice/ui/settings";
import { tokens } from "@voice/ui/tokens.stylex";
import type { Command, Reply } from "@voice/contracts/desktop";

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
  entry: {
    padding: 16,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: tokens.border,
    borderRadius: 8,
    marginBlock: 12,
  },
  controls: { display: "flex", flexWrap: "wrap", gap: 12, marginTop: 12 },
  label: { display: "grid", gap: 8, fontSize: 13 },
  field: {
    backgroundColor: tokens.background,
    color: tokens.ink,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: tokens.border,
    borderRadius: 6,
    padding: 12,
    minHeight: 80,
    fontSize: 14,
    resize: "vertical",
  },
  warning: {
    padding: 20,
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: tokens.ink,
    borderRadius: 8,
    marginBottom: 16,
  },
});

export function RecoveryView({
  reply,
  onReply,
}: {
  reply: Reply | undefined;
  onReply: (reply: Reply) => void;
}) {
  const session = reply?.ok ? reply.session : undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const warning = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (session?.quitWarning) warning.current?.focus();
  }, [session?.quitWarning]);
  async function run(command: Command) {
    setBusy(true);
    setError("");
    try {
      const result = await window.voice.command(command);
      if (result.ok) onReply(result);
      else setError("The action could not be completed. Your recovery remains available.");
    } catch {
      setError("Voice could not complete the action. Return to recovery and try again.");
    } finally {
      setBusy(false);
    }
  }
  const latest = session?.latestSuccessful;
  const armed = session?.armedPaste ?? null;
  const deliveryNotes = {
    undelivered: "",
    copied: "Text copied. The incomplete recording remains unresolved.",
    inserted: "Text inserted. The incomplete recording remains unresolved.",
    failed: "Delivery failed. Text remains available.",
    uncertain:
      "Check your target. Text remains available and will not be pasted again automatically.",
  } as const;
  return (
    <section
      id="section-recovery"
      tabIndex={-1}
      {...stylex.props(styles.section)}
      aria-label="Temporary recovery"
    >
      <h2 {...stylex.props(styles.heading)}>Temporary recovery</h2>
      {session?.quitWarning && (
        <div
          ref={warning}
          tabIndex={-1}
          role="alertdialog"
          aria-labelledby="quit-title"
          aria-describedby="quit-description"
          {...stylex.props(styles.warning)}
        >
          <h3 id="quit-title">Quit and discard undelivered work?</h3>
          <p id="quit-description" {...stylex.props(styles.text)}>
            Your retained recordings and transcripts will be lost when Voice quits.
          </p>
          <div {...stylex.props(styles.controls)}>
            <SaveButton disabled={busy} onClick={() => void run({ type: "app.quit.cancel" })}>
              Return to recovery
            </SaveButton>
            <SaveButton disabled={busy} onClick={() => void run({ type: "app.quit.confirm" })}>
              Quit and discard
            </SaveButton>
          </div>
        </div>
      )}
      <p {...stylex.props(styles.text)}>
        {session?.recovery.length ?? 0} of 5 recovery slots used. Recordings and transcripts stay in
        memory until you discard them or quit Voice.
      </p>
      {session?.recovery.length === 5 && (
        <p {...stylex.props(styles.text)}>
          Recovery is full. Resolve or discard a session before starting another.
        </p>
      )}
      {session?.recovery.map((entry, index) => (
        <article
          key={entry.id}
          aria-label={`Recovery session ${index + 1}`}
          {...stylex.props(styles.entry)}
        >
          <label {...stylex.props(styles.label)}>
            {entry.transcription === "complete"
              ? "Complete provider-final transcript"
              : "Available text, may be incomplete"}
            <textarea readOnly value={entry.text} {...stylex.props(styles.field)} />
          </label>
          <p {...stylex.props(styles.text)}>{entry.cause}</p>
          {entry.hasAudio && (
            <p {...stylex.props(styles.text)}>
              The recording is retained. Copy and Paste resolve only the available text; Discard
              also removes the recording.
            </p>
          )}
          {entry.delivery !== "undelivered" && (
            <p {...stylex.props(styles.text)}>{deliveryNotes[entry.delivery]}</p>
          )}
          <div {...stylex.props(styles.controls)}>
            <SaveButton
              disabled={busy || !entry.text}
              onClick={() => void run({ type: "recovery.copy", id: entry.id })}
            >
              Copy
            </SaveButton>
            <SaveButton
              disabled={busy || !entry.text || !!armed}
              onClick={() => void run({ type: "recovery.paste", id: entry.id })}
            >
              Paste
            </SaveButton>
            <SaveButton
              disabled={busy}
              onClick={() => void run({ type: "recovery.discard", id: entry.id })}
            >
              Discard
            </SaveButton>
          </div>
        </article>
      ))}
      {latest && (
        <article aria-label="Latest successful transcript" {...stylex.props(styles.entry)}>
          <label {...stylex.props(styles.label)}>
            Latest successful transcript
            <textarea readOnly value={latest.text} {...stylex.props(styles.field)} />
          </label>
          <div {...stylex.props(styles.controls)}>
            <SaveButton
              disabled={busy}
              onClick={() => void run({ type: "recovery.copy", id: latest.id })}
            >
              Copy
            </SaveButton>
            <SaveButton
              disabled={busy || !!armed}
              onClick={() => void run({ type: "recovery.paste", id: latest.id })}
            >
              Paste
            </SaveButton>
            <SaveButton
              disabled={busy}
              onClick={() => void run({ type: "recovery.discard", id: latest.id })}
            >
              Discard
            </SaveButton>
          </div>
        </article>
      )}
      <p aria-live="polite" data-testid="recovery-status" {...stylex.props(styles.text)}>
        {error || session?.recoveryMessage}
      </p>
      {armed && (
        <div {...stylex.props(styles.controls)}>
          <SaveButton disabled={busy} onClick={() => void run({ type: "session.cancel" })}>
            Cancel paste
          </SaveButton>
        </div>
      )}
      <SaveButton disabled={busy} onClick={() => void run({ type: "app.quit" })}>
        Quit Voice
      </SaveButton>
    </section>
  );
}
