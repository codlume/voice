import { Field } from "@base-ui/react/field";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Slider } from "@base-ui/react/slider";
import * as stylex from "@stylexjs/stylex";
import { useId, useState, type ReactNode } from "react";

import type {
  DiagnosticsConsent,
  Hotkey,
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
import {
  DEFAULT_SETTINGS,
  hotkeys,
  MAX_PAGE_ANIMATION_MS,
  MIN_PAGE_ANIMATION_MS,
  PAGE_ANIMATION_STEP_MS,
} from "../shared/api.ts";
import { dictationLanguages, type DictationLanguage } from "../shared/dictation-language.ts";
import {
  historyRetentions,
  type HistoryEntry,
  type HistoryRetention,
  type HistoryState,
} from "../shared/history.ts";
import { models, type Model, type ModelId } from "../shared/models.ts";
import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { droppedBy } from "./historyView.ts";
import { dictatesWithFn, hotkeyLabel } from "./hotkeys.ts";
import { Keys } from "./Keycap.tsx";
import { MicrophoneRow } from "./MicrophoneRow.tsx";
import { activityOf, modelView, type Activity, type ModelAction } from "./modelView.ts";
import { PageAnimationPreview } from "./PageAnimationPreview.tsx";
import { pageStyles } from "./pageStyles.ts";
import { Select } from "./Select.tsx";
import { SettingTitle } from "./SettingTitle.tsx";
import { shortcutKeys } from "./shortcutCapture.ts";
import { jumpShortcuts, shortcuts } from "./shortcuts.ts";
import { shortcutsHint } from "./transformsView.ts";
import { useAction } from "./useAction.ts";
import { useKeyboardLayout } from "./useKeyboardLayout.ts";
import { Switch } from "./Switch.tsx";
import { color, radius, space } from "./tokens.stylex.ts";
import { updateStatusText } from "./updateStatus.ts";
import { hubApi } from "./voice.ts";

export const styles = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: space.xl },
  section: { display: "flex", flexDirection: "column", gap: space.sm },
  sectionLabel: { margin: 0, fontSize: 13, fontWeight: 600 },
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
  actions: { display: "flex", gap: space.sm },
  hint: { margin: 0, color: color.mutedForeground, fontSize: 12.5 },
  link: { textDecoration: "underline" },
});

const motionStyles = stylex.create({
  control: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 7rem) minmax(8rem, 13rem)",
    alignItems: "center",
    gap: 16,
  },
  duration: { display: "flex", alignItems: "center", gap: space.md },
  readout: {
    minWidth: 64,
    paddingBlock: 4,
    paddingInline: space.sm,
    borderRadius: radius.small,
    backgroundColor: color.segmentTrack,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: 12,
    fontWeight: 500,
    fontVariantNumeric: "tabular-nums",
    textAlign: "center",
  },
  slider: { flexGrow: 1, minWidth: 0 },
  reducedMotionHint: {
    display: { default: "none", "@media (prefers-reduced-motion: reduce)": "block" },
  },
  sliderControl: {
    display: "flex",
    alignItems: "center",
    height: 24,
    cursor: "pointer",
    touchAction: "none",
  },
  track: {
    position: "relative",
    width: "100%",
    height: 6,
    borderRadius: radius.round,
    backgroundColor: `color-mix(in srgb, ${color.mutedForeground} 22%, transparent)`,
    boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color.border} 55%, transparent)`,
  },
  indicator: { borderRadius: radius.round, backgroundColor: color.primary },
  thumb: {
    width: 16,
    height: 16,
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: color.primary,
    borderRadius: radius.round,
    backgroundColor: color.background,
    boxShadow: {
      default: "0 1px 2px rgb(0 0 0 / 12%)",
      ":hover": "0 1px 3px rgb(0 0 0 / 20%)",
    },
    transform: {
      default: null,
      ":hover": "scale(1.08)",
      ":active": "scale(0.94)",
      ":is([data-dragging])": "scale(0.94)",
    },
    transitionProperty: "transform, box-shadow",
    transitionDuration: { default: "120ms", "@media (prefers-reduced-motion: reduce)": "0s" },
    transitionTimingFunction: "ease",
    outline: { default: "none", ":has(:focus-visible)": `2px solid ${color["--ring"]}` },
    outlineOffset: 2,
  },
});

// Saving every drag tick would write settings.json and broadcast a snapshot per tick, so the thumb
// holds its own value and saves once the gesture or key press commits.
function PageAnimationSlider({
  saved,
  onCommit,
}: {
  saved: number;
  onCommit: (ms: number) => Promise<boolean>;
}) {
  const [slider, setSlider] = useState({ ms: saved, saved });
  if (saved !== slider.saved) setSlider({ ms: saved, saved });
  const { ms } = slider;
  return (
    <div {...stylex.props(motionStyles.duration)}>
      <span aria-hidden {...stylex.props(motionStyles.readout)}>
        {ms} ms
      </span>
      <Slider.Root
        value={ms}
        onValueChange={(next) => setSlider((current) => ({ ...current, ms: next }))}
        onValueCommitted={(committed) => {
          void onCommit(committed).then((ok) => {
            // The updater reads the newest saved value, which another save may have changed since.
            if (!ok) setSlider((current) => ({ ...current, ms: current.saved }));
          });
        }}
        min={MIN_PAGE_ANIMATION_MS}
        max={MAX_PAGE_ANIMATION_MS}
        step={PAGE_ANIMATION_STEP_MS}
        largeStep={4 * PAGE_ANIMATION_STEP_MS}
        {...stylex.props(motionStyles.slider)}
      >
        <Slider.Control {...stylex.props(motionStyles.sliderControl)}>
          <Slider.Track {...stylex.props(motionStyles.track)}>
            <Slider.Indicator {...stylex.props(motionStyles.indicator)} />
            <Slider.Thumb
              aria-label="Page animation duration"
              getAriaValueText={(_, value) => `${value} milliseconds`}
              {...stylex.props(motionStyles.thumb)}
            />
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>
    </div>
  );
}

const hotkeyOptions = hotkeys.map((value) => ({ value, label: hotkeyLabel(value) }));
const TOGGLE_OFF = "off";
type ToggleChoice = Hotkey | typeof TOGGLE_OFF;
const retentionLabels: Record<HistoryRetention, string> = {
  memory: "Until I quit Voice",
  day: "24 hours",
  month: "30 days",
  forever: "Forever",
};
const retentionOptions = historyRetentions.map((value) => ({
  value,
  label: retentionLabels[value],
}));
// Outside the component so the purity lint sees the clock read happens on a click, not a render.
const dropsNow = (entries: readonly HistoryEntry[], to: HistoryRetention) =>
  droppedBy(entries, to, Date.now());
const shorteningDescription = (drops: number) =>
  `${drops === 1 ? "1 older transcript is" : `${drops} older transcripts are`} deleted from your history. This cannot be undone.`;
const updateChannels = [
  { value: "stable", label: "Stable" },
  { value: "nightly", label: "Nightly" },
] as const satisfies readonly { value: UpdateChannel; label: string }[];

type Action = ReturnType<typeof useAction>;

function update(action: Action, patch: SettingsPatch) {
  return action.run(() => hubApi().updateSettings(patch), "Could not save settings.");
}

export function GlobeHint() {
  return (
    <p {...stylex.props(styles.hint)}>
      If the Globe key opens the emoji picker, set System Settings &gt; Keyboard &gt; &ldquo;Press
      🌐 key to&rdquo; to &ldquo;Do Nothing&rdquo;.
    </p>
  );
}

// Undefined while the value already equals its default, which hides the reset button.
function resetTo<T>(
  value: T,
  defaultValue: T,
  change: (value: T) => void,
): (() => void) | undefined {
  return value === defaultValue ? undefined : () => change(defaultValue);
}

function Row({
  title,
  detail,
  disabled = false,
  nativeLabel = false,
  onReset,
  children,
}: {
  title: string;
  detail: string;
  disabled?: boolean;
  nativeLabel?: boolean;
  onReset: (() => void) | undefined;
  children: ReactNode;
}) {
  return (
    <Field.Root {...stylex.props(styles.row, disabled && styles.disabled)}>
      <div {...stylex.props(styles.rowText)}>
        <SettingTitle
          title={title}
          nativeLabel={nativeLabel}
          onReset={onReset}
          disabled={disabled}
        />
        <p {...stylex.props(styles.rowDetail)}>{detail}</p>
      </div>
      {children}
    </Field.Root>
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
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const id = useId();
  return (
    <RadioGroup<T> value={value} onValueChange={onChange} {...stylex.props(styles.segments)}>
      {options.map((option) => (
        // Inside a Field, Base UI labels each radio with the field's label, so each option points
        // at its own text to keep its name.
        <Radio.Root
          key={option.value}
          value={option.value}
          aria-labelledby={`${id}-${option.value}`}
          {...stylex.props(styles.segment, option.value === value && styles.segmentOn)}
        >
          <span id={`${id}-${option.value}`}>{option.label}</span>
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

  // The empty uid is the "System default" option, which saves no microphone.
  const microphoneUid = selected?.uid ?? "";

  function changeMicrophone(uid: string) {
    const microphone = uid === "" ? null : devices.find((device) => device.uid === uid);
    if (microphone === undefined) return;
    void microphoneAction.run(
      () => hubApi().updateSettings({ microphone }),
      "Could not save microphone.",
    );
  }

  const languageAction = useAction();

  function changeLanguage(dictationLanguage: DictationLanguage) {
    void languageAction.run(
      () => hubApi().updateSettings({ dictationLanguage }),
      "Could not save dictation language.",
    );
  }

  const clipboardAction = useAction();
  const changeClipboard = (copyToClipboard: boolean) =>
    update(clipboardAction, { copyToClipboard });

  const channelAction = useAction();

  function changeChannel(channel: UpdateChannel) {
    void channelAction.run(
      () => hubApi().updateSettings({ updateChannel: channel }),
      "Could not change update channel.",
    );
  }

  return (
    <div {...stylex.props(styles.page)}>
      <h1 {...stylex.props(pageStyles.headline)}>General</h1>

      <Section label="Input">
        <Card>
          <MicrophoneRow
            detail={microphoneDetail}
            test={microphoneTest}
            permission={microphonePermission}
            canTest={microphones.kind === "ready" && devices.length > 0 && !missing}
            onReset={resetTo(microphoneUid, "", changeMicrophone)}
            disabled={microphoneAction.pending}
          >
            <Select
              id="setting-microphone"
              value={microphoneUid}
              options={microphoneOptions}
              disabled={microphoneAction.pending}
              grouped
              onChange={changeMicrophone}
            />
          </MicrophoneRow>
        </Card>
        {microphoneAction.error && (
          <p role="alert" {...stylex.props(pageStyles.error)}>
            {microphoneAction.error}
          </p>
        )}
      </Section>

      <Section label="Dictation language">
        <Card>
          <Row
            title="Spoken language"
            detail="Your choice guides speech recognition for your next dictation. Choose Auto-detect for multiple languages. Text cleanup is available for English only."
            onReset={resetTo(
              settings.dictationLanguage,
              DEFAULT_SETTINGS.dictationLanguage,
              changeLanguage,
            )}
          >
            <Select
              id="setting-dictation-language"
              value={settings.dictationLanguage}
              options={dictationLanguages}
              onChange={changeLanguage}
            />
          </Row>
        </Card>
        {languageAction.error && (
          <p role="alert" {...stylex.props(pageStyles.error)}>
            {languageAction.error}
          </p>
        )}
      </Section>

      <Section label="After dictation">
        <Card>
          <Row
            nativeLabel
            title="Copy transcript to clipboard"
            detail="Keeps each transcript on your clipboard too, replacing what you copied before."
            onReset={resetTo(
              settings.copyToClipboard,
              DEFAULT_SETTINGS.copyToClipboard,
              changeClipboard,
            )}
          >
            <Switch
              id="setting-copy-to-clipboard"
              checked={settings.copyToClipboard}
              onChange={changeClipboard}
            />
          </Row>
        </Card>
        {clipboardAction.error && (
          <p role="alert" {...stylex.props(pageStyles.error)}>
            {clipboardAction.error}
          </p>
        )}
      </Section>

      <Section label="About">
        <Card>
          <Row
            title="Update channel"
            detail="Stable gets regular releases. Nightly gets early builds."
            disabled={updates.status.kind === "installing"}
            // The default is the installed build's channel, not DEFAULT_SETTINGS.updateChannel.
            onReset={resetTo(updates.channel, updates.installedChannel, changeChannel)}
          >
            <Select
              id="setting-update-channel"
              value={updates.channel}
              options={updateChannels}
              disabled={updates.status.kind === "installing"}
              onChange={changeChannel}
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
                <p role="alert" {...stylex.props(pageStyles.error)}>
                  {channelAction.error}
                </p>
              )}
            </div>
          </div>
        </Card>
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
  const motionAction = useAction();
  const changeLowerAudio = (lowerAudioWhileDictating: boolean) =>
    update(audioAction, { lowerAudioWhileDictating });
  const changeTheme = (theme: Theme) => update(appearanceAction, { theme });
  const changePageAnimation = (pageAnimationMs: number) =>
    update(motionAction, { pageAnimationMs });
  const changeDock = (showInDock: boolean) => update(appearanceAction, { showInDock });
  const changePill = (alwaysShowPill: boolean) => update(appearanceAction, { alwaysShowPill });
  return (
    <div {...stylex.props(styles.page)}>
      <h1 {...stylex.props(pageStyles.headline)}>System</h1>

      <Section label="Startup">
        <Card>
          <Row
            nativeLabel
            title="Open at login"
            detail={loginItemDetails[loginItem]}
            disabled={loginItem === "unavailable"}
            // Mirrors macOS Login Items rather than a stored setting, so it has no default.
            onReset={undefined}
          >
            <Switch
              id="setting-open-at-login"
              checked={loginItem === "on"}
              disabled={loginItem === "unavailable"}
              onChange={(on) =>
                void loginAction.run(
                  () => hubApi().setOpenAtLogin(on),
                  "Could not change open at login.",
                )
              }
            />
          </Row>
        </Card>
        {loginAction.error && (
          <p role="alert" {...stylex.props(pageStyles.error)}>
            {loginAction.error}
          </p>
        )}
      </Section>

      <Section label="Audio">
        <Card>
          <Row
            nativeLabel
            title="Lower audio while dictating"
            detail="Turns down supported output devices while recording, then restores their volume."
            onReset={resetTo(
              settings.lowerAudioWhileDictating,
              DEFAULT_SETTINGS.lowerAudioWhileDictating,
              changeLowerAudio,
            )}
          >
            <Switch
              id="setting-lower-audio-while-dictating"
              checked={settings.lowerAudioWhileDictating}
              onChange={changeLowerAudio}
            />
          </Row>
        </Card>
        {audioAction.error && (
          <p role="alert" {...stylex.props(pageStyles.error)}>
            {audioAction.error}
          </p>
        )}
      </Section>

      <Section label="Appearance">
        <Card>
          <Row
            title="Theme"
            detail="Match your Mac, or pick light or dark."
            onReset={resetTo(settings.theme, DEFAULT_SETTINGS.theme, changeTheme)}
          >
            <Segmented options={themes} value={settings.theme} onChange={changeTheme} />
          </Row>
          <Row
            nativeLabel
            title="Show in Dock"
            detail="When off, Voice stays out of the Dock and Cmd-Tab. Open it from the menu bar."
            onReset={resetTo(settings.showInDock, DEFAULT_SETTINGS.showInDock, changeDock)}
          >
            <Switch id="setting-show-in-dock" checked={settings.showInDock} onChange={changeDock} />
          </Row>
          <Row
            nativeLabel
            title="Show Flow Bar at all times"
            detail="When off, the Flow Bar appears only while you dictate."
            onReset={resetTo(settings.alwaysShowPill, DEFAULT_SETTINGS.alwaysShowPill, changePill)}
          >
            <Switch
              id="setting-always-show-pill"
              checked={settings.alwaysShowPill}
              onChange={changePill}
            />
          </Row>
        </Card>
        {appearanceAction.error && (
          <p role="alert" {...stylex.props(pageStyles.error)}>
            {appearanceAction.error}
          </p>
        )}
      </Section>

      <Section label="Motion">
        <Card>
          <Row
            title="Page animations"
            detail="Set how fast pages and the sidebar move."
            onReset={resetTo(
              settings.pageAnimationMs,
              DEFAULT_SETTINGS.pageAnimationMs,
              changePageAnimation,
            )}
          >
            <div {...stylex.props(motionStyles.control)}>
              <PageAnimationPreview />
              <PageAnimationSlider
                saved={settings.pageAnimationMs}
                onCommit={changePageAnimation}
              />
            </div>
          </Row>
        </Card>
        <p {...stylex.props(styles.hint, motionStyles.reducedMotionHint)}>
          Reduce motion is on in your system settings, so pages change without animation.
        </p>
        {motionAction.error && (
          <p role="alert" {...stylex.props(pageStyles.error)}>
            {motionAction.error}
          </p>
        )}
      </Section>
    </div>
  );
}

export function DataPrivacySettings({
  settings,
  history,
}: {
  settings: Settings;
  history: HistoryState;
}) {
  const diagnosticsAction = useAction();
  const changeDiagnostics = (diagnostics: DiagnosticsConsent) =>
    update(diagnosticsAction, { diagnostics });
  const clearAction = useAction();
  const [confirmingClear, setConfirmingClear] = useState(false);
  return (
    <div {...stylex.props(styles.page)}>
      <h1 {...stylex.props(pageStyles.headline)}>Data and Privacy</h1>

      <Section label="Diagnostics">
        <Card>
          <Row
            nativeLabel
            title="Share crash reports"
            detail="Sends crashes, dictation timings, and app events, such as a helper restart or a failed cleanup. Never sends your words, audio, clipboard, or the app you dictate into. Turning this on takes effect the next time Voice opens. Turning it off stops sending right away."
            onReset={resetTo(settings.diagnostics, DEFAULT_SETTINGS.diagnostics, changeDiagnostics)}
          >
            <Switch
              id="setting-diagnostics"
              checked={settings.diagnostics === "on"}
              onChange={(on) => changeDiagnostics(on ? "on" : "off")}
            />
          </Row>
        </Card>
        {diagnosticsAction.error && (
          <p role="alert" {...stylex.props(pageStyles.error)}>
            {diagnosticsAction.error}
          </p>
        )}
      </Section>

      <HistorySection history={history} />

      <Section label="Insights">
        <Card>
          <Row
            title="Clear insights"
            detail="Deletes your word counts, pace, fixes, streaks, and app usage from this Mac. Your dictionary and snippets stay."
            onReset={undefined}
          >
            <Button
              variant="secondary"
              aria-label="Clear insights"
              onClick={() => setConfirmingClear(true)}
            >
              Clear…
            </Button>
          </Row>
        </Card>
        {clearAction.error && (
          <p role="alert" {...stylex.props(pageStyles.error)}>
            {clearAction.error}
          </p>
        )}
        <ConfirmDialog
          open={confirmingClear}
          onOpenChange={setConfirmingClear}
          title="Clear insights?"
          description="Your words, pace, fixes, streaks, and app usage start again from zero. This cannot be undone."
          actions={[
            {
              label: "Clear",
              variant: "destructive",
              onClick: () =>
                void clearAction.run(() => hubApi().clearInsights(), "Could not clear insights."),
            },
          ]}
        />
      </Section>
    </div>
  );
}

// A shorter window that would drop entries on screen asks first. The dialog keeps what it asked
// while it fades out, so it stays mounted with `open: false` rather than losing its content.
type Shortening = { open: boolean; to: HistoryRetention; drops: number };

function HistorySection({ history: { entries, retention } }: { history: HistoryState }) {
  const action = useAction();
  const apply = (to: HistoryRetention) =>
    void action.run(
      () => hubApi().setHistoryRetention(to),
      "Could not change where your history is kept.",
    );
  const [shortening, setShortening] = useState<Shortening | null>(null);
  const change = (to: HistoryRetention) => {
    const drops = dropsNow(entries, to);
    if (drops > 0) setShortening({ open: true, to, drops });
    else apply(to);
  };
  const [confirmingClear, setConfirmingClear] = useState(false);
  return (
    <Section label="History">
      <Card>
        <Row
          title="Keep history"
          detail="Your transcripts on Home. Saved history stays on this Mac. Audio is never saved."
          disabled={action.pending}
          onReset={resetTo(retention, "memory", change)}
        >
          <Select
            id="setting-history-retention"
            value={retention}
            options={retentionOptions}
            disabled={action.pending}
            onChange={change}
          />
        </Row>
        <Row
          title="Clear history"
          detail="Deletes every transcript in your history, in memory and on this Mac."
          onReset={undefined}
        >
          <Button
            variant="secondary"
            aria-label="Clear history"
            onClick={() => setConfirmingClear(true)}
          >
            Clear…
          </Button>
        </Row>
      </Card>
      {action.error && (
        <p role="alert" {...stylex.props(pageStyles.error)}>
          {action.error}
        </p>
      )}
      {shortening && (
        <ConfirmDialog
          open={shortening.open}
          onOpenChange={(open) => setShortening({ ...shortening, open })}
          title={`Keep history for ${retentionLabels[shortening.to]}?`}
          description={shorteningDescription(shortening.drops)}
          actions={[
            { label: "Delete older", variant: "destructive", onClick: () => apply(shortening.to) },
          ]}
        />
      )}
      <ConfirmDialog
        open={confirmingClear}
        onOpenChange={setConfirmingClear}
        title="Clear history?"
        description="Every transcript in your history is deleted. This cannot be undone."
        actions={[
          {
            label: "Clear",
            variant: "destructive",
            onClick: () =>
              void action.run(() => hubApi().clearHistory(), "Could not clear history."),
          },
        ]}
      />
    </Section>
  );
}

const modelActions = {
  Install: (id) => hubApi().installModel(id),
  Retry: (id) => hubApi().installModel(id),
  Uninstall: (id) => hubApi().uninstallModel(id),
  Cancel: (id) => hubApi().uninstallModel(id),
} satisfies Record<ModelAction, (id: ModelId) => Promise<void>>;

function ModelSection({
  model,
  status,
  cleanupEnabled,
  activity,
}: {
  model: Model;
  status: ModelStatus;
  cleanupEnabled: boolean;
  activity: Activity;
}) {
  const { pending, error, run: runAction } = useAction();
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  const view = modelView(model, status, { cleanupEnabled, activity });
  const canUninstall = view.actions.some(
    ({ label, disabled }) => label === "Uninstall" && !disabled,
  );
  // Dictation, a transform or a download can withdraw Uninstall while the dialog is open.
  if (confirmingUninstall && !canUninstall) setConfirmingUninstall(false);

  const run = (action: ModelAction) =>
    runAction(
      () => modelActions[action](model.id),
      `Could not ${action.toLowerCase()} ${model.name}.`,
    );

  return (
    <Section label={model.purpose}>
      <Card>
        <div {...stylex.props(styles.row)}>
          <div {...stylex.props(styles.rowText)}>
            <span {...stylex.props(styles.rowTitle)}>{model.name}</span>
            <p {...stylex.props(styles.rowDetail)}>
              {model.vendor} · {model.size}
            </p>
            <p
              role="status"
              aria-live="polite"
              {...stylex.props(styles.rowDetail, status.state === "failed" && pageStyles.error)}
            >
              {view.text}
            </p>
          </div>
          {view.actions.length > 0 && (
            <div {...stylex.props(styles.actions)}>
              {view.actions.map(({ label, disabled }) => (
                <Button
                  key={label}
                  variant={label === "Install" || label === "Retry" ? "primary" : "secondary"}
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
      </Card>
      {error && (
        <p role="alert" {...stylex.props(pageStyles.error)}>
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
  const activity = activityOf(session);
  return (
    <div {...stylex.props(styles.page)}>
      <h1 {...stylex.props(pageStyles.headline)}>Models</h1>
      {models.map((model) => (
        <ModelSection
          key={model.id}
          model={model}
          status={statuses[model.id]}
          cleanupEnabled={settings.cleanup.enabled}
          activity={activity}
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
  keys: readonly string[] | null;
}) {
  return (
    <div {...stylex.props(styles.row)}>
      <div {...stylex.props(styles.rowText)}>
        <span {...stylex.props(styles.rowTitle)}>{title}</span>
        {detail && <p {...stylex.props(styles.rowDetail)}>{detail}</p>}
      </div>
      <Keys keys={keys} />
    </div>
  );
}

export function ShortcutsSettings({
  settings,
  transformModel,
  onOpenTransforms,
}: {
  settings: Settings;
  transformModel: ModelStatus;
  onOpenTransforms: () => void;
}) {
  const hotkeyAction = useAction();
  const layout = useKeyboardLayout();
  const transforms = settings.transforms;
  const changeHotkey = (hotkey: Hotkey) => update(hotkeyAction, { hotkey });
  const toggleChoice: ToggleChoice = settings.toggleHotkey ?? TOGGLE_OFF;
  const changeToggle = (choice: ToggleChoice) =>
    update(hotkeyAction, { toggleHotkey: choice === TOGGLE_OFF ? null : choice });
  const toggleOptions: readonly { value: ToggleChoice; label: string }[] = [
    { value: TOGGLE_OFF, label: "Off" },
    ...hotkeyOptions.filter((option) => option.value !== settings.hotkey),
  ];
  return (
    <div {...stylex.props(styles.page)}>
      <h1 {...stylex.props(pageStyles.headline)}>Shortcuts</h1>

      <Section label="Dictation">
        <Card>
          <Row
            title="Hold to talk"
            detail="Hold the key while you speak."
            onReset={resetTo(settings.hotkey, DEFAULT_SETTINGS.hotkey, changeHotkey)}
          >
            <Select
              id="setting-hotkey"
              value={settings.hotkey}
              options={hotkeyOptions}
              onChange={changeHotkey}
            />
          </Row>
          <Row
            title="Toggle dictation"
            detail="Tap once to start, tap again to stop and insert."
            onReset={resetTo(toggleChoice, TOGGLE_OFF, changeToggle)}
          >
            <Select
              id="setting-toggle-hotkey"
              value={toggleChoice}
              options={toggleOptions}
              onChange={changeToggle}
            />
          </Row>
          <ShortcutRow
            title="Cancel dictation"
            detail="Press while dictating to stop without inserting."
            keys={["Esc"]}
          />
        </Card>
        {hotkeyAction.error && (
          <p role="alert" {...stylex.props(pageStyles.error)}>
            {hotkeyAction.error}
          </p>
        )}
        {dictatesWithFn(settings) && <GlobeHint />}
      </Section>

      <Section label="Transforms">
        {transforms.items.length > 0 && (
          <Card style={!transforms.enabled && styles.disabled}>
            {transforms.items.map((transform) => (
              <ShortcutRow
                key={transform.id}
                title={transform.name}
                keys={transform.shortcut && shortcutKeys(transform.shortcut, layout)}
              />
            ))}
          </Card>
        )}
        <p {...stylex.props(styles.hint)}>
          {shortcutsHint(transforms, transformModel)}{" "}
          <Button variant="text" onClick={onOpenTransforms}>
            <span {...stylex.props(styles.link)}>Open Transforms</span>
          </Button>
        </p>
      </Section>

      <Section label="Voice window">
        <Card>
          <ShortcutRow title="Toggle sidebar" keys={shortcuts.toggleSidebar.keys} />
          <ShortcutRow title="Open Settings" keys={shortcuts.openSettings.keys} />
          <ShortcutRow title="Leave Settings" keys={shortcuts.closeSettings.keys} />
          <ShortcutRow
            title="Search history"
            detail="On Home."
            keys={shortcuts.searchHistory.keys}
          />
          <ShortcutRow
            title="Go to sidebar item"
            detail="Jump to an item in the sidebar, top to bottom."
            keys={["⌘", `1–${jumpShortcuts.length}`]}
          />
          <ShortcutRow title="Zoom in" keys={["⌘", "+"]} />
          <ShortcutRow title="Zoom out" keys={["⌘", "-"]} />
          <ShortcutRow title="Actual size" keys={["⌘", "0"]} />
        </Card>
      </Section>
    </div>
  );
}
