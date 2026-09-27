import * as stylex from "@stylexjs/stylex";
import { useId, useState, type ReactNode } from "react";

import type {
  Hotkey,
  Settings as SettingsValue,
  SettingsPatch,
  Theme,
  UpdateChannel,
  UpdatesSnapshot,
} from "../shared/api.ts";
import {
  dictationLanguages,
  parseDictationLanguage,
  type DictationLanguage,
} from "../shared/dictation-language.ts";
import { hotkeyLabels } from "./checklist.ts";
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
  select: {
    paddingBlock: 6,
    paddingInline: 10,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.small,
    backgroundColor: color.card,
    color: color.foreground,
    font: "inherit",
    fontSize: 13,
  },
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
    outline: { default: "none", ":has(:focus-visible)": `2px solid ${color["--ring"]}` },
  },
  segmentOn: {
    backgroundColor: color.segmentSelected,
    color: color.foreground,
    fontWeight: 500,
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.1)",
  },
  radio: { position: "absolute", opacity: 0, pointerEvents: "none" },
  hint: { margin: 0, color: color.mutedForeground, fontSize: 12.5 },
  error: { margin: 0, color: color.errorForeground, fontSize: 12.5 },
});

const isHotkey = (value: string): value is Hotkey => value in hotkeyLabels;

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
  const name = useId();
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} {...stylex.props(styles.segments)}>
      {options.map((option) => (
        <label
          key={option.value}
          {...stylex.props(styles.segment, option.value === value && styles.segmentOn)}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={option.value === value}
            disabled={disabled}
            onChange={() => onChange(option.value)}
            {...stylex.props(styles.radio)}
          />
          {option.label}
        </label>
      ))}
    </div>
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

export function Settings({
  settings,
  updates,
}: {
  settings: SettingsValue;
  updates: UpdatesSnapshot;
}) {
  const [updateError, setUpdateError] = useState("");
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
      <h1 {...stylex.props(styles.headline)}>Settings</h1>

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
            <select
              id="setting-hotkey"
              value={settings.hotkey}
              onChange={(event) => {
                const hotkey = event.currentTarget.value;
                if (isHotkey(hotkey)) update({ hotkey });
              }}
              {...stylex.props(styles.select)}
            >
              {Object.entries(hotkeyLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Row>
        </div>
        {settings.hotkey === "fn" && <GlobeHint />}
      </section>

      <section aria-labelledby="dictation-languages" {...stylex.props(styles.section)}>
        <h2 id="dictation-languages" {...stylex.props(styles.sectionLabel)}>
          Dictation languages
        </h2>
        <div {...stylex.props(styles.card)}>
          <Row
            id="setting-dictation-language"
            title="Spoken language"
            detail="Your choice guides speech recognition for your next dictation. Choose Auto-detect for multiple languages. Text cleanup is available for English only."
          >
            <select
              id="setting-dictation-language"
              value={settings.dictationLanguage}
              onChange={(event) =>
                void changeLanguage(parseDictationLanguage(event.currentTarget.value))
              }
              {...stylex.props(styles.select)}
            >
              {dictationLanguages.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Row>
        </div>
        {languageError && (
          <p role="alert" {...stylex.props(styles.error)}>
            {languageError}
          </p>
        )}
      </section>

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
            <select
              id="setting-update-channel"
              value={updates.channel}
              disabled={updates.status.kind === "installing"}
              onChange={(event) => {
                const channel = event.currentTarget.value;
                if (channel === "stable" || channel === "nightly") void changeChannel(channel);
              }}
              {...stylex.props(styles.select)}
            >
              <option value="stable">Stable</option>
              <option value="nightly">Nightly</option>
            </select>
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
    </div>
  );
}
