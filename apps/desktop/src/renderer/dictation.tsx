import * as stylex from "@stylexjs/stylex";
import { tokens } from "@voice/ui/tokens.stylex";
import { defaultSetupPreferences } from "@voice/contracts/setup";
import type { Reply } from "@voice/contracts/desktop";

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
});
export function DictationView({ reply }: { reply: Reply | undefined }) {
  const shortcuts =
    (reply?.ok && reply.settings.setup?.shortcuts) || defaultSetupPreferences.shortcuts;
  const listening = reply?.ok && reply.status.shortcuts === "listening";
  const session = reply?.ok ? reply.session : undefined;
  return (
    <section {...stylex.props(styles.section)} aria-label="System-wide dictation">
      <h2 {...stylex.props(styles.heading)}>Dictate into any text field</h2>
      <p {...stylex.props(styles.text)}>
        Click into a text field in another app, then hold{" "}
        <span {...stylex.props(styles.keys)}>{shortcuts.hold}</span> and speak. Release to insert
        the transcript at the caret or over the selection. Press{" "}
        <span {...stylex.props(styles.keys)}>{shortcuts.toggle}</span> for hands-free dictation and{" "}
        <span {...stylex.props(styles.keys)}>{shortcuts.cancel}</span> to cancel.
      </p>
      <p {...stylex.props(styles.text)}>
        Voice inserts only into the field that was focused when you started. If focus moves, the
        field closes, or the insertion cannot be confirmed, the transcript waits in Temporary
        recovery. Terminals are not supported yet.
      </p>
      <p aria-live="polite" data-testid="dictation-status" {...stylex.props(styles.text)}>
        Shortcuts: {listening ? "listening" : "unavailable until setup is complete"}.
        {session?.origin === "dictation" ? ` Last session: ${session.message}` : ""}
      </p>
    </section>
  );
}
