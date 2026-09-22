import { RecoveryView } from "./recovery";
import { PracticeView } from "./practice";
import { DictationView } from "./dictation";
import { SetupView } from "./setup";
import { useEffect, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { Atom } from "effect/unstable/reactivity";
import { useAtom } from "@effect/atom-react";
import { Sun, Moon } from "lucide-react";
import { SettingsPage, SaveButton } from "@voice/ui/settings";
import { tokens } from "@voice/ui/tokens.stylex";
import {
  defaultSettings,
  type DesktopApi,
  type Reply,
  type Settings,
} from "@voice/contracts/desktop";

declare global {
  interface Window {
    voice: DesktopApi & { onChanged: (listener: () => void) => () => void };
  }
}
const snapshot = Atom.make<Reply | undefined>(undefined);
const styles = stylex.create({
  heading: { fontSize: 16, fontWeight: 600, marginBlock: 0 },
  hint: { color: tokens.muted, fontSize: 13, lineHeight: 1.6, marginTop: 8, marginBottom: 22 },
  choices: { display: "flex", gap: 14, marginBottom: 24, borderWidth: 0, padding: 0 },
  choice: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    color: tokens.ink,
    fontSize: 14,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: tokens.border,
    borderRadius: 8,
    padding: 16,
    flexGrow: 1,
    cursor: "pointer",
  },
  footer: { display: "flex", alignItems: "center", gap: 16 },
  status: { fontSize: 13, color: tokens.muted },
  notice: { fontSize: 12, color: tokens.muted, marginTop: 24, lineHeight: 1.6 },
});

export function SettingsView() {
  const [reply, setReply] = useAtom(snapshot);
  const [draft, setDraft] = useState<Settings["appearance"] | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const settings = reply?.ok ? reply.settings : defaultSettings;
  const ready = reply?.ok && reply.status.storage === "ready";
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const value = await window.voice.command({ type: "settings.get" });
        if (active) setReply(value);
      } catch {
        if (active) setMessage("Settings could not be loaded. Try again.");
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
  }, [setReply]);
  async function save(retry = false) {
    setSaving(true);
    setMessage("");
    try {
      const result = await window.voice.command(
        retry
          ? { type: "storage.retry" }
          : { type: "settings.set", appearance: draft ?? settings.appearance },
      );
      if (result.ok) {
        setReply(result);
        setDraft(undefined);
        setMessage(retry ? "Settings restored." : "Saved.");
      } else setMessage("Settings could not be saved. Try again.");
    } catch {
      setMessage("Settings could not be saved. Try again.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <SettingsPage appearance={settings.appearance}>
      <SetupView reply={reply} onReply={setReply} />
      <DictationView reply={reply} />
      <PracticeView reply={reply} onReply={setReply} />
      <RecoveryView reply={reply} onReply={setReply} />
      <h2 {...stylex.props(styles.heading)}>Appearance</h2>
      <p {...stylex.props(styles.hint)}>Choose how Voice looks on your desktop.</p>
      <fieldset
        {...stylex.props(styles.choices)}
        disabled={!ready || saving}
        aria-label="Color theme"
      >
        {(["light", "dark"] as const).map((value) => (
          <label key={value} {...stylex.props(styles.choice)}>
            <input
              type="radio"
              name="appearance"
              value={value}
              checked={(draft ?? settings.appearance) === value}
              onChange={() => {
                setDraft(value);
                setMessage("");
              }}
            />
            {value === "light" ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
            {value === "light" ? "Light" : "Dark"}
          </label>
        ))}
      </fieldset>
      <div {...stylex.props(styles.footer)}>
        <SaveButton
          disabled={!ready || saving || (draft ?? settings.appearance) === settings.appearance}
          onClick={() => void save()}
        >
          {" "}
          {saving ? "Saving…" : "Save changes"}{" "}
        </SaveButton>
        <span role="status" {...stylex.props(styles.status)}>
          {message ||
            (ready
              ? "Saved on this Mac."
              : reply?.ok && reply.status.storage === "failed"
                ? "Settings unavailable."
                : "Loading settings…")}
        </span>
      </div>
      {reply &&
        (!reply.ok || reply.status.storage === "failed" || message.includes("could not")) && (
          <p role="alert">
            Settings storage is unavailable.{" "}
            <SaveButton disabled={saving} onClick={() => void save(true)}>
              Try again
            </SaveButton>
          </p>
        )}
      <p {...stylex.props(styles.notice)}>
        Development preview. After setup, shortcuts dictate into native text fields such as
        TextEdit. Browser, editor, and terminal support is still in development.
      </p>
    </SettingsPage>
  );
}
