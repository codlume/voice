import { useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { SaveButton } from "@voice/ui/settings";
import { tokens } from "@voice/ui/tokens.stylex";
import {
  defaultSetupPreferences,
  permissionNames,
  bindingOptions,
  type SetupBlocker,
  type SetupCommand,
  type SetupPreferences,
} from "@voice/contracts/setup";
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
  text: { color: tokens.muted, fontSize: 13, lineHeight: 1.6, marginBlock: 8 },
  row: {
    display: "flex",
    flexWrap: "wrap",
    gap: 12,
    alignItems: "center",
    justifyContent: "space-between",
    marginBlock: 12,
  },
  label: { display: "grid", gap: 7, fontSize: 13, flexGrow: 1 },
  control: {
    backgroundColor: tokens.background,
    color: tokens.ink,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: tokens.border,
    borderRadius: 6,
    padding: 10,
    fontSize: 14,
    minWidth: 0,
    maxWidth: "100%",
    outlineColor: tokens.accent,
  },
  list: { color: tokens.muted, fontSize: 13, lineHeight: 1.7, paddingLeft: 20 },
  error: {
    color: tokens.ink,
    fontSize: 13,
    borderLeftWidth: 3,
    borderLeftStyle: "solid",
    borderLeftColor: tokens.accent,
    paddingLeft: 12,
  },
  summary: { fontSize: 14, fontWeight: 600, cursor: "pointer" },
});
const permissionLabels = {
  microphone: "Microphone",
  accessibility: "Accessibility",
  inputMonitoring: "Input Monitoring",
};
const bindingLabels = { hold: "Hold to talk", toggle: "Toggle dictation", cancel: "Cancel" };
const repairs: Record<SetupBlocker, string> = {
  "native-unavailable":
    "Native services are unavailable. Voice restarts them automatically; if this persists, quit and reopen Voice.",
  "permission-microphone": "Allow microphone access before dictating.",
  "permission-accessibility": "Allow Accessibility access for shortcuts and insertion.",
  "permission-inputMonitoring": "Allow Input Monitoring for global shortcuts.",
  "input-device": "Connect your selected microphone or choose another input.",
  shortcuts: "Review shortcut access and conflicts below.",
  "key-missing": "Add your Deepgram key.",
  "key-unavailable": "Unlock your login Keychain, then refresh setup or save your key again.",
  "key-rejected": "Deepgram rejected this key. Replace it with a working key.",
  "quota-exhausted":
    "Your Deepgram quota is exhausted. Add credit in your Deepgram account, then refresh setup status.",
};
const failures = {
  "invalid-command": "Check the input and try again.",
  unauthorized: "Reopen Voice to reconnect Settings.",
  "storage-unavailable": "Settings could not be saved. Restore settings storage and try again.",
  "native-unavailable":
    "Native services are unavailable. Voice restarts them automatically; try again in a moment.",
  "keychain-unavailable":
    "Keychain could not complete the change. Unlock your login Keychain and try again. Your key was not confirmed saved or removed.",
  "shortcut-conflict":
    "These shortcuts conflict. Choose different bindings, or turn off the macOS Fn action in Keyboard settings.",
};

export function SetupView({
  reply,
  onReply,
}: {
  reply: Reply | undefined;
  onReply: (reply: Reply) => void;
}) {
  const saved = reply?.ok
    ? (reply.settings.setup ?? defaultSetupPreferences)
    : defaultSetupPreferences;
  const status = reply?.ok ? reply.setup : undefined;
  const [draft, setDraft] = useState<SetupPreferences | undefined>();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const preferences = draft ?? saved;
  const storageReady = reply?.ok && reply.status.storage === "ready";
  async function run(command: SetupCommand, success: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await window.voice.command(command);
      if (result.ok) {
        onReply(result);
        setMessage(success);
        if (command.type === "setup.save") setDraft(undefined);
      } else {
        setError(failures[result.error]);
        const latest = await window.voice.command({ type: "status.get" });
        if (latest.ok) onReply(latest);
      }
    } catch {
      setError("Voice could not complete this change. Reopen the app and try again.");
    } finally {
      setBusy(false);
    }
  }
  function save(completed = saved.completed) {
    void run(
      {
        type: "setup.save",
        inputDevice: preferences.inputDevice,
        shortcuts: preferences.shortcuts,
        completed,
      },
      completed
        ? "Setup saved. Starting dictation will always require your action."
        : "Dictation settings saved.",
    );
  }
  const selectedMissing =
    preferences.inputDevice &&
    !status?.native?.devices.some((device) => device.id === preferences.inputDevice);
  return (
    <>
      <section
        id="section-setup"
        tabIndex={-1}
        {...stylex.props(styles.section)}
        aria-label="Dictation readiness"
      >
        <h2 {...stylex.props(styles.heading)}>
          {saved.completed ? "Dictation setup" : "Set up your first dictation"}
        </h2>
        <p {...stylex.props(styles.text)}>
          Local capture setup: {status?.localCapture === "available" ? "ready" : "needs attention"}.
          Capture is off.
        </p>
        <p {...stylex.props(styles.text)}>
          Connection: {status?.connectivity ?? "unknown"}. Provider: {status?.provider ?? "unknown"}
          .
        </p>
        {status?.connectivity === "offline" && (
          <p {...stylex.props(styles.text)}>
            You are offline. A new explicit capture can still start after setup; transcription needs
            an internet connection.
          </p>
        )}
        {status?.provider === "rate-limited" && (
          <p {...stylex.props(styles.text)}>
            Deepgram is temporarily rate limiting requests. Wait before trying again. This does not
            mean your quota is exhausted.
          </p>
        )}
        {status?.provider === "unreachable" && (
          <p {...stylex.props(styles.text)}>
            Deepgram is unreachable. Check your connection and try again.
          </p>
        )}
        <ul {...stylex.props(styles.list)}>
          {status?.blockers.map((blocker) => (
            <li key={blocker}>{repairs[blocker]}</li>
          ))}
        </ul>
        <SaveButton
          disabled={busy || !storageReady}
          onClick={() => void run({ type: "setup.refresh" }, "Setup status refreshed.")}
        >
          Refresh setup status
        </SaveButton>
      </section>
      <section {...stylex.props(styles.section)} aria-label="Permissions">
        <h2 {...stylex.props(styles.heading)}>Permissions</h2>
        <p {...stylex.props(styles.text)}>
          Voice checks access without recording. After changing access in System Settings, return
          here and refresh setup status.
        </p>
        {permissionNames.map((permission) => (
          <div key={permission} {...stylex.props(styles.row)}>
            <span>
              {permissionLabels[permission]} ·{" "}
              {status?.native?.permissions[permission] ?? "unavailable"}
            </span>
            <SaveButton
              disabled={
                busy || !storageReady || status?.native?.permissions[permission] === "granted"
              }
              onClick={() =>
                void run(
                  { type: "permission.request", permission },
                  "Permission request opened. Refresh setup after changing access.",
                )
              }
            >
              {status?.native?.permissions[permission] === "not-requested" ? "Allow" : "Review"}{" "}
              {permissionLabels[permission]}
            </SaveButton>
          </div>
        ))}
      </section>
      <section {...stylex.props(styles.section)} aria-label="Input and shortcuts">
        <h2 {...stylex.props(styles.heading)}>Input and shortcuts</h2>
        <label {...stylex.props(styles.label)}>
          Input device
          <select
            {...stylex.props(styles.control)}
            disabled={busy || !storageReady}
            aria-label="Input device"
            value={preferences.inputDevice ?? ""}
            onChange={(event) =>
              setDraft({ ...preferences, inputDevice: event.target.value || null })
            }
          >
            <option value="">System default input</option>
            {selectedMissing && (
              <option value={preferences.inputDevice ?? ""}>Selected input · disconnected</option>
            )}
            {status?.native?.devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
          </select>
        </label>
        {status?.native?.devices.length === 0 && (
          <p {...stylex.props(styles.text)}>
            No input device found. Connect a microphone. This is separate from microphone
            permission.
          </p>
        )}
        {(["hold", "toggle", "cancel"] as const).map((role) => (
          <div key={role} {...stylex.props(styles.row)}>
            <label {...stylex.props(styles.label)}>
              {bindingLabels[role]}
              <select
                {...stylex.props(styles.control)}
                aria-label={bindingLabels[role]}
                value={preferences.shortcuts[role]}
                disabled={busy || !storageReady}
                onChange={(event) => {
                  const binding = bindingOptions.find((value) => value === event.target.value);
                  if (binding)
                    setDraft({
                      ...preferences,
                      shortcuts: { ...preferences.shortcuts, [role]: binding },
                    });
                }}
              >
                {bindingOptions.map((binding) => (
                  <option key={binding} value={binding}>
                    {binding}
                  </option>
                ))}
              </select>
            </label>
            <span {...stylex.props(styles.text)}>
              {draft ? "Save to check" : (status?.native?.shortcuts[role] ?? "unavailable")}
            </span>
          </div>
        ))}
        <p {...stylex.props(styles.text)}>
          If Fn conflicts, set “Press 🌐 key to” to “Do Nothing” in macOS Keyboard settings. Choose
          another binding if an app reserves it. Setup checks known conflicts; protected fields can
          still block shortcuts.
        </p>
        <SaveButton disabled={busy || !storageReady || !draft} onClick={() => save()}>
          Save dictation settings
        </SaveButton>
      </section>
      <section {...stylex.props(styles.section)} aria-label="Deepgram account">
        <h2 {...stylex.props(styles.heading)}>Your Deepgram key</h2>
        <p {...stylex.props(styles.text)}>
          Key:{" "}
          {status?.credential.presence === "saved"
            ? "•••••••• saved in Keychain"
            : (status?.credential.presence ?? "checking")}
          . Access: {status?.credential.verification ?? "unverified"}.
        </p>
        <p {...stylex.props(styles.text)}>
          Saving a key does not verify authentication, quota, or transcription. A successful
          practice session will verify transcription when dictation is available.
        </p>
        <label {...stylex.props(styles.label)}>
          Deepgram API key
          <input
            {...stylex.props(styles.control)}
            type="password"
            autoComplete="off"
            spellCheck={false}
            maxLength={512}
            value={key}
            disabled={busy}
            onChange={(event) => setKey(event.target.value)}
          />
        </label>
        <div {...stylex.props(styles.row)}>
          <SaveButton
            disabled={busy || !key.trim()}
            onClick={() => {
              const value = key.trim();
              setKey("");
              void run(
                { type: "credential.set", key: value },
                "Key saved in Keychain. Access is not verified.",
              );
            }}
          >
            {status?.credential.presence === "saved" ? "Replace key" : "Add key"}
          </SaveButton>
          <SaveButton
            disabled={busy || status?.credential.presence === "missing"}
            onClick={() => void run({ type: "credential.remove" }, "Key removed from Keychain.")}
          >
            Remove key
          </SaveButton>
        </div>
      </section>
      <section {...stylex.props(styles.section)} aria-label="Remote processing">
        <details open={!saved.completed}>
          <summary {...stylex.props(styles.summary)}>Before you dictate</summary>
          <p {...stylex.props(styles.text)}>
            Your dictated audio goes directly to Deepgram in the EU under your own account. Deepgram
            bills you directly; Voice has no account or subscription. Model improvement is opted out
            on requests. Your account must allow processing without training on dictated content.
          </p>
          <p {...stylex.props(styles.text)}>
            Audio and transcripts stay temporarily in memory for recovery and disappear when Voice
            quits. Voice sends no surrounding document, selection, clipboard, screen, or app context
            for inference.
          </p>
          <p {...stylex.props(styles.text)}>
            Voice does not guarantee a spending cap. Retries can add billable audio. Voice provides
            basic punctuation and capitalization; spoken formatting commands may remain literal, and
            recognition mistakes need your correction.
          </p>
        </details>
        {!saved.completed && (
          <SaveButton disabled={busy || !storageReady} onClick={() => save(true)}>
            Finish setup
          </SaveButton>
        )}
      </section>
      {error && (
        <p role="alert" {...stylex.props(styles.error)}>
          {error}
        </p>
      )}
      <p aria-live="polite" {...stylex.props(styles.text)}>
        {busy ? "Applying setup change…" : message}
      </p>
    </>
  );
}
