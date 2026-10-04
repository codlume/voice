import { Field } from "@base-ui/react/field";
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
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { MicrophoneRow } from "./MicrophoneRow.tsx";
import { modelView, type ModelAction } from "./modelView.ts";
import { Select } from "./Select.tsx";
import { jumpShortcuts, shortcuts } from "./shortcuts.ts";
import { useAction } from "./useAction.ts";
import { Switch } from "./Switch.tsx";
import { color, font, radius, space } from "./tokens.stylex.ts";
import { updateStatusText } from "./updateStatus.ts";

export const styles = stylex.create({
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

type Action = ReturnType<typeof useAction>;

function update(action: Action, patch: SettingsPatch) {
  void action.run(() => window.voice.updateSettings(patch), "Could not save settings.");
}

export function GlobeHint() {
  return (
    <p {...stylex.props(styles.hint)}>
      If the Globe key opens the emoji picker, set System Settings &gt; Keyboard &gt; &ldquo;Press
      🌐 key to&rdquo; to &ldquo;Do Nothing&rdquo;.
    </p>
  );
}

// A native label passes its :hover and clicks to the labelled control, which is wrong for Select
// triggers. Switch rows opt in to keep click-to-toggle on the title.
function Row({
  title,
  detail,
  disabled = false,
  nativeLabel = false,
  children,
}: {
  title: string;
  detail: string;
  disabled?: boolean;
  nativeLabel?: boolean;
  children: ReactNode;
}) {
  return (
    <Field.Root {...stylex.props(styles.row, disabled && styles.disabled)}>
      <div {...stylex.props(styles.rowText)}>
        <Field.Label
          nativeLabel={nativeLabel}
          render={nativeLabel ? undefined : <div />}
          {...stylex.props(styles.rowTitle)}
        >
          {title}
        </Field.Label>
        <p {...stylex.props(styles.rowDetail)}>{detail}</p>
      </div>
      {children}
    </Field.Root>
  );
}

export function Section({ label, children }: { label: string; children: ReactNode }) {
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

function ThemePicker({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  const titleId = useId();
  return (
    <div {...stylex.props(styles.row)}>
      <div {...stylex.props(styles.rowText)}>
        <span id={titleId} {...stylex.props(styles.rowTitle)}>
          Theme
        </span>
        <p {...stylex.props(styles.rowDetail)}>Match your Mac, or pick light or dark.</p>
      </div>
      <Segmented labelledBy={titleId} options={themes} value={theme} onChange={onChange} />
    </div>
  );
}

export function GeneralSettings({
  settings,
  microphones,
  microphoneTest,
  microphonePermission,
  updates,
}: {
  settings: Settings;
  microphones: MicrophoneCatalog;
  microphoneTest: MicrophoneTest;
  microphonePermission: PermissionState;
  updates: UpdatesSnapshot;
}) {
  const microphoneAction = useAction();
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
    await microphoneAction.run(
      () => window.voice.updateSettings({ microphone }),
      "Could not save microphone.",
    );
  }

  const languageAction = useAction();

  async function changeLanguage(dictationLanguage: DictationLanguage) {
    await languageAction.run(
      () => window.voice.updateSettings({ dictationLanguage }),
      "Could not save dictation language.",
    );
  }

  const clipboardAction = useAction();
  const channelAction = useAction();

  async function changeChannel(channel: UpdateChannel) {
    await channelAction.run(
      () => window.voice.updateSettings({ updateChannel: channel }),
      "Could not change update channel.",
    );
  }

  return (
    <div {...stylex.props(styles.page)}>
      <h1 {...stylex.props(styles.headline)}>General</h1>

      <Section label="Input">
        <div {...stylex.props(styles.card)}>
          <MicrophoneRow
            detail={microphoneDetail}
            test={microphoneTest}
            permission={microphonePermission}
            canTest={microphones.kind === "ready" && devices.length > 0 && !missing}
          >
            <Select
              id="setting-microphone"
              value={selected?.uid ?? ""}
              options={microphoneOptions}
              disabled={microphoneAction.pending}
              grouped
              onChange={(uid) => void changeMicrophone(uid)}
            />
          </MicrophoneRow>
        </div>
        {microphoneAction.error && (
          <p role="alert" {...stylex.props(styles.error)}>
            {microphoneAction.error}
          </p>
        )}
      </Section>

      <Section label="Dictation language">
        <div {...stylex.props(styles.card)}>
          <Row
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
        {languageAction.error && (
          <p role="alert" {...stylex.props(styles.error)}>
            {languageAction.error}
          </p>
        )}
      </Section>

      <Section label="After dictation">
        <div {...stylex.props(styles.card)}>
          <Row
            nativeLabel
            title="Copy transcript to clipboard"
            detail="Keeps each transcript on your clipboard too, replacing what you copied before."
          >
            <Switch
              id="setting-copy-to-clipboard"
              checked={settings.copyToClipboard}
              onChange={(copyToClipboard) => update(clipboardAction, { copyToClipboard })}
            />
          </Row>
        </div>
        {clipboardAction.error && (
          <p role="alert" {...stylex.props(styles.error)}>
            {clipboardAction.error}
          </p>
        )}
      </Section>

      <Section label="About">
        <div {...stylex.props(styles.card)}>
          <Row
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
              {channelAction.error && (
                <p role="alert" {...stylex.props(styles.error)}>
                  {channelAction.error}
                </p>
              )}
            </div>
          </div>
        </div>
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
}: {
  settings: Settings;
  loginItem: LoginItem;
}) {
  const loginAction = useAction();
  const audioAction = useAction();
  const appearanceAction = useAction();
  return (
    <div {...stylex.props(styles.page)}>
      <h1 {...stylex.props(styles.headline)}>System</h1>

      <Section label="Startup">
        <div {...stylex.props(styles.card)}>
          <Row
            nativeLabel
            title="Open at login"
            detail={loginItemDetails[loginItem]}
            disabled={loginItem === "unavailable"}
          >
            <Switch
              id="setting-open-at-login"
              checked={loginItem === "on"}
              disabled={loginItem === "unavailable"}
              onChange={(on) =>
                void loginAction.run(
                  () => window.voice.setOpenAtLogin(on),
                  "Could not change open at login.",
                )
              }
            />
          </Row>
        </div>
        {loginAction.error && (
          <p role="alert" {...stylex.props(styles.error)}>
            {loginAction.error}
          </p>
        )}
      </Section>

      <Section label="Audio">
        <div {...stylex.props(styles.card)}>
          <Row
            nativeLabel
            title="Mute all audio while dictating"
            detail="Silences supported output devices while recording, then restores their previous audio state."
          >
            <Switch
              id="setting-mute-while-dictating"
              checked={settings.muteWhileDictating}
              onChange={(muteWhileDictating) => update(audioAction, { muteWhileDictating })}
            />
          </Row>
        </div>
        {audioAction.error && (
          <p role="alert" {...stylex.props(styles.error)}>
            {audioAction.error}
          </p>
        )}
      </Section>

      <Section label="Appearance">
        <div {...stylex.props(styles.card)}>
          <ThemePicker
            theme={settings.theme}
            onChange={(theme) => update(appearanceAction, { theme })}
          />
          <Row
            nativeLabel
            title="Show in Dock"
            detail="When off, Voice stays out of the Dock and Cmd-Tab. Open it from the menu bar."
          >
            <Switch
              id="setting-show-in-dock"
              checked={settings.showInDock}
              onChange={(showInDock) => update(appearanceAction, { showInDock })}
            />
          </Row>
          <Row
            nativeLabel
            title="Show Flow Bar at all times"
            detail="When off, the Flow Bar appears only while you dictate."
          >
            <Switch
              id="setting-always-show-pill"
              checked={settings.alwaysShowPill}
              onChange={(alwaysShowPill) => update(appearanceAction, { alwaysShowPill })}
            />
          </Row>
        </div>
        {appearanceAction.error && (
          <p role="alert" {...stylex.props(styles.error)}>
            {appearanceAction.error}
          </p>
        )}
      </Section>
    </div>
  );
}

export function DataPrivacySettings({ settings }: { settings: Settings }) {
  const diagnosticsAction = useAction();
  return (
    <div {...stylex.props(styles.page)}>
      <h1 {...stylex.props(styles.headline)}>Data and Privacy</h1>

      <Section label="Diagnostics">
        <div {...stylex.props(styles.card)}>
          <Row
            nativeLabel
            title="Share crash reports"
            detail="Sends crashes, dictation timings, and app events, such as a helper restart or a failed cleanup. Never sends your words, audio, clipboard, or the app you dictate into. Turning this on takes effect the next time Voice opens. Turning it off stops sending right away."
          >
            <Switch
              id="setting-diagnostics"
              checked={settings.diagnostics === "on"}
              onChange={(on) => update(diagnosticsAction, { diagnostics: on ? "on" : "off" })}
            />
          </Row>
        </div>
        {diagnosticsAction.error && (
          <p role="alert" {...stylex.props(styles.error)}>
            {diagnosticsAction.error}
          </p>
        )}
      </Section>
    </div>
  );
}

const modelActions = {
  Install: (id) => window.voice.installModel(id),
  Retry: (id) => window.voice.installModel(id),
  Uninstall: (id) => window.voice.uninstallModel(id),
} satisfies Record<ModelAction, (id: ModelId) => Promise<void>>;

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
  const { pending, error, run: runAction } = useAction();
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  const view = modelView(model, status, { cleanupEnabled, dictating });
  const canUninstall = view.actions.some(
    ({ label, disabled }) => label === "Uninstall" && !disabled,
  );
  // Dictation or a download can withdraw Uninstall while the dialog is open.
  if (confirmingUninstall && !canUninstall) setConfirmingUninstall(false);

  const run = (action: ModelAction) =>
    runAction(
      () => modelActions[action](model.id),
      `Could not ${action.toLowerCase()} ${model.name}.`,
    );

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
              {view.actions.map(({ label, disabled }) => (
                <Button
                  key={label}
                  variant={label === "Uninstall" ? "secondary" : "primary"}
                  aria-label={`${label} ${model.name}`}
                  disabled={pending || disabled}
                  onClick={() =>
                    label === "Uninstall" ? setConfirmingUninstall(true) : void run(label)
                  }
                >
                  {label}
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
      <ConfirmDialog
        open={confirmingUninstall}
        onOpenChange={setConfirmingUninstall}
        title={`Uninstall the ${model.kind.toLowerCase()}?`}
        description={`${model.lostUntilReinstalled} until you install it again, which is about a ${model.size} download.`}
        actions={[
          { label: "Uninstall", variant: "destructive", onClick: () => void run("Uninstall") },
        ]}
      />
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
  const hotkeyAction = useAction();
  return (
    <div {...stylex.props(styles.page)}>
      <h1 {...stylex.props(styles.headline)}>Shortcuts</h1>

      <Section label="Dictation">
        <div {...stylex.props(styles.card)}>
          <Row title="Hold to talk" detail="Hold the key while you speak.">
            <Select
              id="setting-hotkey"
              value={settings.hotkey}
              options={hotkeyOptions}
              onChange={(hotkey) => update(hotkeyAction, { hotkey })}
            />
          </Row>
          <ShortcutRow
            title="Cancel dictation"
            detail="Press while dictating to stop without inserting."
            keys={["Esc"]}
          />
        </div>
        {hotkeyAction.error && (
          <p role="alert" {...stylex.props(styles.error)}>
            {hotkeyAction.error}
          </p>
        )}
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
