import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import * as stylex from "@stylexjs/stylex";
import { useId, useState, type ReactNode } from "react";

import type {
  LoginItem,
  MicrophoneCatalog,
  MicrophoneTest,
  ModelStatus,
  PermissionState,
  PillState,
  Settings,
  SettingsPatch,
  Snapshot,
  Theme,
  UpdateChannel,
  UpdatesSnapshot,
} from "../shared/api.ts";
import { hotkeys } from "../shared/api.ts";
import { dictationLanguages, type DictationLanguage } from "../shared/dictation-language.ts";
import { models, type Model, type ModelId } from "../shared/models.ts";
import { Button } from "./Button.tsx";
import { hotkeyLabels } from "./checklist.ts";
import { MicrophoneRow } from "./MicrophoneRow.tsx";
import { Select } from "./Select.tsx";
import { jumpShortcuts, shortcuts } from "./shortcuts.ts";
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
  keys: { display: "flex", flexShrink: 0, gap: 4, fontFamily: "inherit" },
  key: {
    minWidth: 22,
    paddingBlock: 2,
    paddingInline: 6,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.small,
    backgroundColor: color.segmentTrack,
    color: color.foreground,
    fontFamily: "inherit",
    fontSize: 12,
    fontVariantNumeric: "tabular-nums",
    lineHeight: "16px",
    textAlign: "center",
  },
  actions: { display: "flex", gap: space.sm },
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

function Section({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} {...stylex.props(styles.section)}>
      <h2 id={id} {...stylex.props(styles.sectionLabel)}>
        {label}
      </h2>
      {children}
    </section>
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
  settings: Settings;
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

      <Section label="Input">
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
      </Section>

      <Section label="Dictation language">
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
      </Section>
    </div>
  );
}

const loginItemDetails: Record<LoginItem, string> = {
  on: "Start Voice when you log in to your Mac, so dictation is ready right away.",
  off: "Start Voice when you log in to your Mac, so dictation is ready right away.",
  needsApproval:
    "macOS needs your approval. Turn this on to open Login Items in System Settings, then allow Voice.",
  unavailable: "Development builds can't open at login.",
};

export function SystemSettings({
  settings,
  loginItem,
  updates,
}: {
  settings: Settings;
  loginItem: LoginItem;
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

      <Section label="Startup">
        <div {...stylex.props(styles.card)}>
          <Row
            id="setting-open-at-login"
            title="Open at login"
            detail={loginItemDetails[loginItem]}
            disabled={loginItem === "unavailable"}
          >
            <Switch
              id="setting-open-at-login"
              checked={loginItem === "on"}
              disabled={loginItem === "unavailable"}
              onChange={(on) => void window.voice.setOpenAtLogin(on)}
            />
          </Row>
        </div>
      </Section>

      <Section label="Audio">
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
      </Section>

      <Section label="Appearance">
        <div {...stylex.props(styles.card)}>
          <ThemePicker theme={settings.theme} />
          <Row
            id="setting-show-in-dock"
            title="Show in Dock"
            detail="When off, Voice stays out of the Dock and Cmd-Tab. Open it from the menu bar."
          >
            <Switch
              id="setting-show-in-dock"
              checked={settings.showInDock}
              onChange={(showInDock) => update({ showInDock })}
            />
          </Row>
          <Row
            id="setting-always-show-pill"
            title="Show Flow Bar at all times"
            detail="When off, the Flow Bar appears only while you dictate."
          >
            <Switch
              id="setting-always-show-pill"
              checked={settings.alwaysShowPill}
              onChange={(alwaysShowPill) => update({ alwaysShowPill })}
            />
          </Row>
        </div>
      </Section>

      <Section label="Updates">
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
      </Section>
    </div>
  );
}

export function DataPrivacySettings({ settings }: { settings: Settings }) {
  return (
    <div {...stylex.props(styles.page)}>
      <h1 {...stylex.props(styles.headline)}>Data and Privacy</h1>

      <Section label="Diagnostics">
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
      </Section>
    </div>
  );
}

const modelActions = {
  Install: (id) => window.voice.installModel(id),
  Retry: (id) => window.voice.installModel(id),
  Uninstall: (id) => window.voice.uninstallModel(id),
} satisfies Record<string, (id: ModelId) => Promise<void>>;

type ModelAction = keyof typeof modelActions;

function modelView(
  status: ModelStatus,
  cleanupEnabled: boolean,
): { text: string; actions: readonly ModelAction[] } {
  switch (status.state) {
    case "missing":
      return { text: "Not installed", actions: ["Install"] };
    case "downloading":
      return {
        text:
          status.progress === undefined
            ? "Downloading"
            : `Downloading ${Math.round(status.progress * 100)}%`,
        actions: [],
      };
    case "loading":
      return { text: "Loading", actions: [] };
    case "ready":
      return { text: "Installed", actions: ["Uninstall"] };
    case "installed":
      return {
        text: cleanupEnabled
          ? "Installed. Loads when you dictate in English."
          : "Installed. Loads when text cleanup is on.",
        actions: ["Uninstall"],
      };
    case "failed":
      return { text: status.message, actions: ["Retry", "Uninstall"] };
  }
}

function ModelSection({
  model,
  status,
  cleanupEnabled,
  dictating,
}: {
  model: Model;
  status: ModelStatus;
  cleanupEnabled: boolean;
  dictating: boolean;
}) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const view = modelView(status, cleanupEnabled);

  async function run(action: ModelAction) {
    setError("");
    setPending(true);
    try {
      await modelActions[action](model.id);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : `Could not ${action.toLowerCase()} ${model.name}.`,
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Section label={model.purpose}>
      <div {...stylex.props(styles.card)}>
        <div {...stylex.props(styles.row)}>
          <div {...stylex.props(styles.rowText)}>
            <span {...stylex.props(styles.rowTitle)}>{model.name}</span>
            <p {...stylex.props(styles.rowDetail)}>
              {model.vendor} · {model.size}
            </p>
            <p
              role="status"
              aria-live="polite"
              {...stylex.props(styles.rowDetail, status.state === "failed" && styles.error)}
            >
              {view.text}
            </p>
          </div>
          {view.actions.length > 0 && (
            <div {...stylex.props(styles.actions)}>
              {view.actions.map((action) => (
                <Button
                  key={action}
                  variant={action === "Uninstall" ? "secondary" : "primary"}
                  aria-label={`${action} ${model.name}`}
                  disabled={pending || (action === "Uninstall" && model.id === "asr" && dictating)}
                  onClick={() => void run(action)}
                >
                  {action}
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" {...stylex.props(styles.error)}>
          {error}
        </p>
      )}
    </Section>
  );
}

export function ModelsSettings({
  models: statuses,
  settings,
  session,
}: {
  models: Snapshot["models"];
  settings: Settings;
  session: PillState;
}) {
  const dictating = session.kind === "listening" || session.kind === "processing";
  return (
    <div {...stylex.props(styles.page)}>
      <h1 {...stylex.props(styles.headline)}>Models</h1>
      {models.map((model) => (
        <ModelSection
          key={model.id}
          model={model}
          status={statuses[model.id]}
          cleanupEnabled={settings.cleanup.enabled}
          dictating={dictating}
        />
      ))}
    </div>
  );
}

function ShortcutRow({
  title,
  detail,
  keys,
}: {
  title: string;
  detail?: string | undefined;
  keys: readonly string[];
}) {
  return (
    <div {...stylex.props(styles.row)}>
      <div {...stylex.props(styles.rowText)}>
        <span {...stylex.props(styles.rowTitle)}>{title}</span>
        {detail && <p {...stylex.props(styles.rowDetail)}>{detail}</p>}
      </div>
      <kbd {...stylex.props(styles.keys)}>
        {keys.map((key) => (
          <kbd key={key} {...stylex.props(styles.key)}>
            {key}
          </kbd>
        ))}
      </kbd>
    </div>
  );
}

export function ShortcutsSettings({ settings }: { settings: Settings }) {
  return (
    <div {...stylex.props(styles.page)}>
      <h1 {...stylex.props(styles.headline)}>Shortcuts</h1>

      <Section label="Dictation">
        <div {...stylex.props(styles.card)}>
          <Row id="setting-hotkey" title="Hold to talk" detail="Hold the key while you speak.">
            <Select
              id="setting-hotkey"
              value={settings.hotkey}
              options={hotkeyOptions}
              onChange={(hotkey) => update({ hotkey })}
            />
          </Row>
          <ShortcutRow
            title="Cancel dictation"
            detail="Press while dictating to stop without inserting."
            keys={["Esc"]}
          />
        </div>
        {settings.hotkey === "fn" && <GlobeHint />}
      </Section>

      <Section label="Voice window">
        <div {...stylex.props(styles.card)}>
          <ShortcutRow title="Toggle sidebar" keys={shortcuts.toggleSidebar.keys} />
          <ShortcutRow title="Open Settings" keys={shortcuts.openSettings.keys} />
          <ShortcutRow title="Leave Settings" keys={shortcuts.closeSettings.keys} />
          <ShortcutRow
            title="Go to sidebar item"
            detail="Jump to an item in the sidebar, top to bottom."
            keys={["⌘", `1–${jumpShortcuts.length}`]}
          />
        </div>
      </Section>
    </div>
  );
}
