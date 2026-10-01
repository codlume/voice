import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import * as stylex from "@stylexjs/stylex";
import { useId, useState, type ReactNode } from "react";

import type {
  MicrophoneCatalog,
  MicrophoneTest,
  PermissionState,
  Settings as SettingsValue,
  SettingsPatch,
  Theme,
  UpdateChannel,
  UpdatesSnapshot,
} from "../shared/api.ts";
import { hotkeys } from "../shared/api.ts";
import { dictationLanguages, type DictationLanguage } from "../shared/dictation-language.ts";
import { hotkeyLabels } from "./checklist.ts";
import { MicrophoneRow } from "./MicrophoneRow.tsx";
import { Select } from "./Select.tsx";
import { Switch } from "./Switch.tsx";
import { color, font, radius, space } from "./tokens.stylex.ts";
import { updateStatusText } from "./updateStatus.ts";

const styles = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: space.xl },
  headline: {
    margin: 0,
    fontFamily: font.serif,
    fontSize: 36,
    fontWeight: 400,
    lineHeight: 1.15,
    letterSpacing: "-0.01em",
  },
  section: { display: "flex", flexDirection: "column", gap: space.sm },
  sectionLabel: { margin: 0, fontSize: 13, fontWeight: 600 },
  card: {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.large,
    backgroundColor: color.card,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: space.lg,
    paddingBlock: 14,
    paddingInline: space.lg,
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: color.border,
  },
  disabled: { opacity: 0.45 },
  rowText: { flexGrow: 1, minWidth: 0 },
  rowTitle: { display: "block", fontWeight: 500 },
  rowDetail: { margin: 0, color: color.mutedForeground, fontSize: 12.5 },
  segments: {
    display: "grid",
    gridAutoFlow: "column",
    gridAutoColumns: "1fr",
    gap: 2,
    padding: 3,
    borderRadius: radius.medium,
    backgroundColor: color.segmentTrack,
  },
  segment: {
    position: "relative",
    paddingBlock: 6,
    paddingInline: space.md,
    borderRadius: 7,
    color: color.mutedForeground,
    fontSize: 13,
    textAlign: "center",
    cursor: "pointer",
    outline: { default: "none", ":focus-visible": `2px solid ${color["--ring"]}` },
  },
  segmentOn: {
    backgroundColor: color.segmentSelected,
    color: color.foreground,
    fontWeight: 500,
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.1)",
  },
  hint: { margin: 0, color: color.mutedForeground, fontSize: 12.5 },
  error: { margin: 0, color: color.errorForeground, fontSize: 12.5 },
});

const hotkeyOptions = hotkeys.map((value) => ({ value, label: hotkeyLabels[value] }));
const updateChannels = [
  { value: "stable", label: "Stable" },
  { value: "nightly", label: "Nightly" },
] as const satisfies readonly { value: UpdateChannel; label: string }[];

function update(patch: SettingsPatch) {
  void window.voice.updateSettings(patch);
}

export function GlobeHint() {
  return (
    <p {...stylex.props(styles.hint)}>
      If the Globe key opens the emoji picker, set System Settings &gt; Keyboard &gt; &ldquo;Press
      🌐 key to&rdquo; to &ldquo;Do Nothing&rdquo;.
    </p>
  );
}

function Row({
  id,
  title,
  detail,
  disabled = false,
  children,
}: {
  id: string;
  title: string;
  detail: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <div {...stylex.props(styles.row, disabled && styles.disabled)}>
      <div {...stylex.props(styles.rowText)}>
        <label htmlFor={id} {...stylex.props(styles.rowTitle)}>
          {title}
        </label>
        <p {...stylex.props(styles.rowDetail)}>{detail}</p>
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  labelledBy,
  options,
  value,
  disabled = false,
  onChange,
}: {
  labelledBy: string;
  options: readonly { value: T; label: string }[];
  value: T;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <RadioGroup<T>
      aria-labelledby={labelledBy}
      value={value}
      disabled={disabled}
      onValueChange={onChange}
      {...stylex.props(styles.segments)}
    >
      {options.map((option) => (
        <Radio.Root
          key={option.value}
          value={option.value}
          {...stylex.props(styles.segment, option.value === value && styles.segmentOn)}
        >
          {option.label}
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}

const themes = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const satisfies readonly { value: Theme; label: string }[];

function ThemePicker({ theme }: { theme: Theme }) {
  const titleId = useId();
  return (
    <div {...stylex.props(styles.row)}>
      <div {...stylex.props(styles.rowText)}>
        <span id={titleId} {...stylex.props(styles.rowTitle)}>
          Theme
        </span>
        <p {...stylex.props(styles.rowDetail)}>Match your Mac, or pick light or dark.</p>
      </div>
      <Segmented
        labelledBy={titleId}
        options={themes}
        value={theme}
        onChange={(next) => update({ theme: next })}
      />
    </div>
  );
}

export function GeneralSettings({
  settings,
  microphones,
  microphoneTest,
  microphonePermission,
}: {
  settings: SettingsValue;
  microphones: MicrophoneCatalog;
  microphoneTest: MicrophoneTest;
  microphonePermission: PermissionState;
}) {
  const [microphoneError, setMicrophoneError] = useState("");
  const [savingMicrophone, setSavingMicrophone] = useState(false);
  const devices = microphones.kind === "ready" ? microphones.devices : [];
  const selected = settings.microphone;
  const missing = selected !== null && !devices.some((device) => device.uid === selected.uid);
  const microphoneOptions = [
    { value: "", label: "System default" },
    ...devices.map((device) => ({ value: device.uid, label: device.name })),
    ...(missing
      ? [
          {
            value: selected.uid,
            label: `${selected.name} (${microphones.kind === "ready" ? "unavailable" : "saved"})`,
          },
        ]
      : []),
  ];
  const defaultName =
    microphones.kind === "ready"
      ? devices.find((device) => device.uid === microphones.defaultUid)?.name
      : undefined;
  let microphoneDetail = "Changes apply to your next dictation.";
  if (microphones.kind === "loading") {
    microphoneDetail = "Looking for microphones…";
  } else if (microphones.kind === "unavailable") {
    microphoneDetail = microphones.message;
  } else if (missing) {
    microphoneDetail = "Reconnect this microphone or choose another before dictating.";
  } else if (devices.length === 0) {
    microphoneDetail = "No microphones found. Connect a microphone to dictate.";
  } else if (selected === null && defaultName) {
    microphoneDetail = `Currently ${defaultName}. Changes apply to your next dictation.`;
  }

  async function changeMicrophone(uid: string) {
    const microphone = uid === "" ? null : devices.find((device) => device.uid === uid);
    if (microphone === undefined) return;
    setMicrophoneError("");
    setSavingMicrophone(true);
    try {
      await window.voice.updateSettings({ microphone });
    } catch (error) {
      setMicrophoneError(error instanceof Error ? error.message : "Could not save microphone.");
    } finally {
      setSavingMicrophone(false);
    }
  }

  const [languageError, setLanguageError] = useState("");

  async function changeLanguage(dictationLanguage: DictationLanguage) {
    setLanguageError("");
    try {
      await window.voice.updateSettings({ dictationLanguage });
    } catch (error) {
      setLanguageError(
        error instanceof Error ? error.message : "Could not save dictation language.",
      );
    }
  }

  return (
    <div {...stylex.props(styles.page)}>
      <h1 {...stylex.props(styles.headline)}>General</h1>

      <section aria-labelledby="shortcut" {...stylex.props(styles.section)}>
        <h2 id="shortcut" {...stylex.props(styles.sectionLabel)}>
          Shortcut
        </h2>
        <div {...stylex.props(styles.card)}>
          <Row
            id="setting-hotkey"
            title="Hold to talk"
            detail="Hold the key while you speak. Press Escape to cancel."
          >
            <Select
              id="setting-hotkey"
              value={settings.hotkey}
              options={hotkeyOptions}
              onChange={(hotkey) => update({ hotkey })}
            />
          </Row>
        </div>
        {settings.hotkey === "fn" && <GlobeHint />}
      </section>

      <section aria-labelledby="input" {...stylex.props(styles.section)}>
        <h2 id="input" {...stylex.props(styles.sectionLabel)}>
          Input
        </h2>
        <div {...stylex.props(styles.card)}>
          <MicrophoneRow
            selectId="setting-microphone"
            detail={microphoneDetail}
            test={microphoneTest}
            permission={microphonePermission}
            canTest={microphones.kind === "ready" && devices.length > 0 && !missing}
          >
            <Select
              id="setting-microphone"
              value={selected?.uid ?? ""}
              options={microphoneOptions}
              disabled={savingMicrophone}
              grouped
              onChange={(uid) => void changeMicrophone(uid)}
            />
          </MicrophoneRow>
        </div>
        {microphoneError && (
          <p role="alert" {...stylex.props(styles.error)}>
            {microphoneError}
          </p>
        )}
      </section>

      <section aria-labelledby="dictation-language" {...stylex.props(styles.section)}>
        <h2 id="dictation-language" {...stylex.props(styles.sectionLabel)}>
          Dictation language
        </h2>
        <div {...stylex.props(styles.card)}>
          <Row
            id="setting-dictation-language"
            title="Spoken language"
            detail="Your choice guides speech recognition for your next dictation. Choose Auto-detect for multiple languages. Text cleanup is available for English only."
          >
            <Select
              id="setting-dictation-language"
              value={settings.dictationLanguage}
              options={dictationLanguages}
              onChange={(language) => void changeLanguage(language)}
            />
          </Row>
        </div>
        {languageError && (
          <p role="alert" {...stylex.props(styles.error)}>
            {languageError}
          </p>
        )}
      </section>
    </div>
  );
}

export function SystemSettings({
  settings,
  updates,
}: {
  settings: SettingsValue;
  updates: UpdatesSnapshot;
}) {
  const [updateError, setUpdateError] = useState("");

  async function changeChannel(channel: UpdateChannel) {
    setUpdateError("");
    try {
      await window.voice.updateSettings({ updateChannel: channel });
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : "Could not change update channel.");
    }
  }

  return (
    <div {...stylex.props(styles.page)}>
      <h1 {...stylex.props(styles.headline)}>System</h1>

      <section aria-labelledby="audio" {...stylex.props(styles.section)}>
        <h2 id="audio" {...stylex.props(styles.sectionLabel)}>
          Audio
        </h2>
        <div {...stylex.props(styles.card)}>
          <Row
            id="setting-mute-while-dictating"
            title="Mute all audio while dictating"
            detail="Silences supported output devices while recording, then restores their previous audio state."
          >
            <Switch
              id="setting-mute-while-dictating"
              checked={settings.muteWhileDictating}
              onChange={(muteWhileDictating) => update({ muteWhileDictating })}
            />
          </Row>
        </div>
      </section>

      <section aria-labelledby="appearance" {...stylex.props(styles.section)}>
        <h2 id="appearance" {...stylex.props(styles.sectionLabel)}>
          Appearance
        </h2>
        <div {...stylex.props(styles.card)}>
          <ThemePicker theme={settings.theme} />
        </div>
      </section>

      <section aria-labelledby="updates" {...stylex.props(styles.section)}>
        <h2 id="updates" {...stylex.props(styles.sectionLabel)}>
          Updates
        </h2>
        <div {...stylex.props(styles.card)}>
          <Row
            id="setting-update-channel"
            title="Update channel"
            detail="Stable gets regular releases. Nightly gets early builds."
            disabled={updates.status.kind === "installing"}
          >
            <Select
              id="setting-update-channel"
              value={updates.channel}
              options={updateChannels}
              disabled={updates.status.kind === "installing"}
              onChange={(channel) => void changeChannel(channel)}
            />
          </Row>
          <div {...stylex.props(styles.row)}>
            <div {...stylex.props(styles.rowText)}>
              <span {...stylex.props(styles.rowTitle)}>Installed version</span>
              <p {...stylex.props(styles.rowDetail)}>
                {updates.version} · {updates.installedChannel === "nightly" ? "Nightly" : "Stable"}
              </p>
            </div>
          </div>
          <div {...stylex.props(styles.row)}>
            <div {...stylex.props(styles.rowText)}>
              <span {...stylex.props(styles.rowTitle)}>Update status</span>
              <p role="status" aria-live="polite" {...stylex.props(styles.rowDetail)}>
                {updateStatusText(updates.status)}
              </p>
              {updateError && (
                <p role="alert" {...stylex.props(styles.error)}>
                  {updateError}
                </p>
              )}
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="privacy" {...stylex.props(styles.section)}>
        <h2 id="privacy" {...stylex.props(styles.sectionLabel)}>
          Privacy
        </h2>
        <div {...stylex.props(styles.card)}>
          <Row
            id="setting-diagnostics"
            title="Share crash reports"
            detail="Sends crashes and dictation timings, such as how long transcription took. Never sends your words, audio, clipboard, or the app you dictate into. Turning this on takes effect the next time Voice opens. Turning it off stops sending right away."
          >
            <Switch
              id="setting-diagnostics"
              checked={settings.diagnostics === "on"}
              onChange={(on) => update({ diagnostics: on ? "on" : "off" })}
            />
          </Row>
        </div>
      </section>
    </div>
  );
}
