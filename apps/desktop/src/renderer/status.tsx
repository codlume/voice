import { useEffect, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import type { DesktopApi, Reply } from "@voice/contracts/desktop";

declare global {
  interface Window {
    voice: DesktopApi & { onChanged: (listener: () => void) => () => void };
  }
}

// Status text for the non-activating panel. It renders only while a session or paste runs,
// so idle Voice repaints nothing and the external target keeps focus.
const styles = stylex.create({
  panel: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    height: "100vh",
    paddingInline: 16,
    boxSizing: "border-box",
    backgroundColor: "#172b45",
    color: "#e9eff7",
    fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
    fontSize: 13,
    lineHeight: 1.4,
    userSelect: "none",
  },
  dot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0, backgroundColor: "#54677e" },
  recording: { backgroundColor: "#ff5f57" },
  text: {
    margin: 0,
    overflow: "hidden",
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 3,
  },
});
export function StatusView() {
  const [reply, setReply] = useState<Reply | undefined>(undefined);
  useEffect(() => {
    document.title = "Voice status";
    let active = true;
    const refresh = async () => {
      try {
        const value = await window.voice.command({ type: "status.get" });
        if (active) setReply(value);
      } catch {
        /* The panel only mirrors state; the main window reports connection problems. */
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
  const message = session?.armedPaste
    ? `Paste: ${session.recoveryMessage}`
    : (session?.message ?? "Ready.");
  return (
    <div role="status" aria-label="Dictation status" {...stylex.props(styles.panel)}>
      <span
        aria-hidden
        {...stylex.props(styles.dot, session?.phase === "recording" && styles.recording)}
      />
      <p data-testid="panel-status" {...stylex.props(styles.text)}>
        {message}
      </p>
    </div>
  );
}
