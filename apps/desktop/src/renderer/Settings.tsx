import * as stylex from "@stylexjs/stylex";
import { useId, useState, type ReactNode } from "react";

import type {
  Hotkey,
  Settings as SettingsValue,
  SettingsPatch,
  UpdateChannel,
  UpdatesSnapshot,
} from "../shared/api.ts";
import { hotkeyLabels, stylings } from "./checklist.ts";
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
    backgroundColor: color.panel,
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
  stack: { flexDirection: "column", alignItems: "stretch", gap: space.md },
  disabled: { opacity: 0.45 },
  rowText: { flexGrow: 1, minWidth: 0 },
  rowTitle: { display: "block", fontWeight: 500 },
  rowDetail: { margin: 0, color: color.muted, fontSize: 12.5 },
  select: {
    paddingBlock: 6,
    paddingInline: 10,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.small,
    backgroundColor: color.panel,
    color: color.ink,
    font: "inherit",
    fontSize: 13,
  },
  switch: {
    position: "relative",
    flexShrink: 0,
    width: 36,
    height: 22,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.round,
    backgroundColor: "#d8d2c8",
    cursor: { default: "pointer", ":disabled": "default" },
    transitionProperty: "background-color",
    transitionDuration: "160ms",
  },
  switchOn: { backgroundColor: color.ink },
  thumb: {
    position: "absolute",
    top: 2,
    left: 2,
    width: 18,
    height: 18,
    borderRadius: radius.round,
    backgroundColor: "white",
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.2)",
    transitionProperty: "transform",
    transitionDuration: "160ms",
  },
  thumbOn: { transform: "translateX(14px)" },
  segments: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: 2,
    padding: 3,
    borderRadius: radius.medium,
    backgroundColor: color.sidebar,
  },
  segment: {
    position: "relative",
    paddingBlock: 6,
    borderRadius: 7,
    color: color.muted,
    fontSize: 13,
    textAlign: "center",
    cursor: "pointer",
    outline: { default: "none", ":has(:focus-visible)": "2px solid #4f6bd8" },
  },
  segmentOn: {
    backgroundColor: color.panel,
    color: color.ink,
    fontWeight: 500,
    boxShadow: "0 1px 2px rgba(31, 29, 26, 0.12)",
  },
  radio: { position: "absolute", opacity: 0, pointerEvents: "none" },
  example: { margin: 0, color: color.muted, fontSize: 13 },
  hint: { margin: 0, color: color.muted, fontSize: 12.5 },
  error: { margin: 0, color: color.failed, fontSize: 12.5 },
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

function Switch({
  checked,
  disabled = false,
  onChange,
  id,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  id: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      {...stylex.props(styles.switch, checked && styles.switchOn)}
    >
      <span {...stylex.props(styles.thumb, checked && styles.thumbOn)} />
    </button>
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

function StylePicker({ cleanup }: { cleanup: SettingsValue["cleanup"] }) {
  const name = useId();
  const current = stylings.find((s) => s.value === cleanup.styling) ?? stylings[0]!;
  const disabled = !cleanup.enabled;
  return (
    <div {...stylex.props(styles.row, styles.stack, disabled && styles.disabled)}>
      <span id={name} {...stylex.props(styles.rowTitle)}>
        Style
      </span>
      <div role="radiogroup" aria-labelledby={name} {...stylex.props(styles.segments)}>
        {stylings.map(({ value, label }) => (
          <label
            key={value}
            {...stylex.props(styles.segment, value === cleanup.styling && styles.segmentOn)}
          >
            <input
              type="radio"
              name={name}
              value={value}
              checked={value === cleanup.styling}
              disabled={disabled}
              onChange={() => update({ cleanup: { styling: value } })}
              {...stylex.props(styles.radio)}
            />
            {label}
          </label>
        ))}
      </div>
      <p {...stylex.props(styles.example)}>&ldquo;{current.example}&rdquo;</p>
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
  const { cleanup } = settings;
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

      <section aria-labelledby="cleanup" {...stylex.props(styles.section)}>
        <h2 id="cleanup" {...stylex.props(styles.sectionLabel)}>
          Cleanup
        </h2>
        <div {...stylex.props(styles.card)}>
          <Row
            id="setting-cleanup"
            title="Clean up text"
            detail="Removes filler words and fixes punctuation, on this Mac."
          >
            <Switch
              id="setting-cleanup"
              checked={cleanup.enabled}
              onChange={(enabled) => update({ cleanup: { enabled } })}
            />
          </Row>
          <StylePicker cleanup={cleanup} />
          <Row
            id="setting-lists"
            title="Lists"
            detail="Turns spoken lists into bullet points."
            disabled={!cleanup.enabled}
          >
            <Switch
              id="setting-lists"
              checked={cleanup.structure === "lists"}
              disabled={!cleanup.enabled}
              onChange={(on) => update({ cleanup: { structure: on ? "lists" : "prose" } })}
            />
          </Row>
          <Row
            id="setting-email"
            title="Email formatting"
            detail="Adds a greeting, paragraphs, and a sign-off."
            disabled={!cleanup.enabled}
          >
            <Switch
              id="setting-email"
              checked={cleanup.context === "email"}
              disabled={!cleanup.enabled}
              onChange={(on) => update({ cleanup: { context: on ? "email" : "general" } })}
            />
          </Row>
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
