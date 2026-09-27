import * as stylex from "@stylexjs/stylex";
import { useId, useRef, useState } from "react";

import type { Settings as SettingsValue, SettingsPatch } from "../shared/api.ts";
import { supportsCleanup, wantsCleanup } from "../shared/dictation-language.ts";
import { Switch } from "./Switch.tsx";
import { color, font, radius, space } from "./tokens.stylex.ts";

const stylings: {
  value: SettingsValue["cleanup"]["styling"];
  label: string;
  description: string;
  example: string;
}[] = [
  {
    value: "casual",
    label: "Casual",
    description: "Relaxed and conversational",
    example: "yeah sounds good, see you at 3",
  },
  {
    value: "semi-casual",
    label: "Semi-casual",
    description: "Easygoing, with a little polish",
    example: "Yeah, sounds good. See you at 3.",
  },
  {
    value: "semi-formal",
    label: "Semi-formal",
    description: "Clear and composed",
    example: "Sounds good. I'll see you at 3.",
  },
  {
    value: "formal",
    label: "Formal",
    description: "Polished and professional",
    example: "That sounds good. I will see you at 3:00.",
  },
];

const styles = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: space.lg },
  header: { display: "flex", flexDirection: "column", gap: space.sm },
  headline: {
    margin: 0,
    fontFamily: font.serif,
    fontSize: 36,
    fontWeight: 400,
    lineHeight: 1.15,
    letterSpacing: "-0.01em",
  },
  subtitle: { margin: 0, color: color.mutedForeground },
  cleanup: {
    display: "flex",
    alignItems: "center",
    gap: space.lg,
    paddingBlock: 14,
    paddingInline: space.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.large,
    backgroundColor: color.card,
  },
  cleanupText: { flexGrow: 1, minWidth: 0 },
  title: { display: "block", fontWeight: 500 },
  detail: { margin: 0, color: color.mutedForeground, fontSize: 12.5 },
  fieldset: { minWidth: 0, margin: 0, padding: 0, borderWidth: 0 },
  legend: { padding: 0, marginBottom: space.md, fontSize: 13, fontWeight: 600 },
  grid: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(2, minmax(0, 1fr))",
      "@media (max-width: 780px)": "minmax(0, 1fr)",
    },
    gap: space.md,
  },
  card: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    minHeight: 128,
    paddingBlock: space.md,
    paddingInline: space.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: color.border, ":hover": color.input },
    borderRadius: radius.large,
    backgroundColor: { default: color.card, ":hover": color.accent },
    cursor: "pointer",
    outline: { default: "none", ":has(:focus-visible)": `2px solid ${color["--ring"]}` },
    outlineOffset: 3,
  },
  selected: {
    borderColor: { default: color.primary, ":hover": color.primary },
    backgroundColor: {
      default: `color-mix(in srgb, ${color.primary} 7%, ${color.card})`,
      ":hover": `color-mix(in srgb, ${color.primary} 10%, ${color.card})`,
    },
  },
  disabled: { opacity: 0.5, cursor: "default" },
  radio: { position: "absolute", opacity: 0, pointerEvents: "none" },
  cardHeader: { display: "flex", alignItems: "center", gap: space.sm },
  cardTitle: { flexGrow: 1, fontWeight: 600 },
  mark: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 18,
    height: 18,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.input,
    borderRadius: radius.round,
    color: "transparent",
  },
  markSelected: {
    borderColor: color.primary,
    backgroundColor: color.primary,
    color: color.primaryForeground,
  },
  example: {
    display: "block",
    margin: 0,
    fontFamily: font.serif,
    fontSize: 18,
    lineHeight: 1.35,
    letterSpacing: "-0.01em",
  },
  error: { margin: 0, color: color.errorForeground, fontSize: 12.5 },
});

export function Style({ settings }: { settings: SettingsValue }) {
  const name = useId();
  const cleanupId = useId();
  const [saveError, setSaveError] = useState("");
  const saveVersion = useRef(0);
  const cleanupSupported = supportsCleanup(settings.dictationLanguage);
  const cleanupEnabled = wantsCleanup(settings);

  async function changeCleanup(cleanup: NonNullable<SettingsPatch["cleanup"]>) {
    const version = ++saveVersion.current;
    setSaveError("");
    try {
      await window.voice.updateSettings({ cleanup });
    } catch (error) {
      if (version === saveVersion.current) {
        setSaveError(
          error instanceof Error ? error.message : "Could not save your style settings.",
        );
      }
    }
  }

  return (
    <div {...stylex.props(styles.page)}>
      <header {...stylex.props(styles.header)}>
        <h1 {...stylex.props(styles.headline)}>Style</h1>
        <p {...stylex.props(styles.subtitle)}>Choose how your dictation reads.</p>
      </header>

      <div {...stylex.props(styles.cleanup)}>
        <div {...stylex.props(styles.cleanupText)}>
          <label htmlFor={cleanupId} {...stylex.props(styles.title)}>
            Clean up text
          </label>
          <p {...stylex.props(styles.detail)}>
            Removes filler words and fixes punctuation, on this Mac.
          </p>
        </div>
        <Switch
          id={cleanupId}
          checked={cleanupEnabled}
          disabled={!cleanupSupported}
          onChange={(enabled) => void changeCleanup({ enabled })}
        />
      </div>

      <fieldset disabled={!cleanupEnabled} {...stylex.props(styles.fieldset)}>
        <legend {...stylex.props(styles.legend)}>Writing style</legend>
        <div {...stylex.props(styles.grid)}>
          {stylings.map(({ value, label, description, example }) => {
            const selected = settings.cleanup.styling === value;
            const labelId = `${name}-${value}-label`;
            const descriptionId = `${name}-${value}-description`;
            const exampleId = `${name}-${value}-example`;
            return (
              <label
                key={value}
                {...stylex.props(
                  styles.card,
                  selected && styles.selected,
                  !cleanupEnabled && styles.disabled,
                )}
              >
                <input
                  type="radio"
                  name={name}
                  value={value}
                  checked={selected}
                  aria-labelledby={labelId}
                  aria-describedby={`${descriptionId} ${exampleId}`}
                  onChange={() => void changeCleanup({ styling: value })}
                  {...stylex.props(styles.radio)}
                />
                <span>
                  <span {...stylex.props(styles.cardHeader)}>
                    <span id={labelId} {...stylex.props(styles.cardTitle)}>
                      {label}
                    </span>
                    <span
                      aria-hidden="true"
                      {...stylex.props(styles.mark, selected && styles.markSelected)}
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path
                          d="m3 6 2 2 4-4"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </span>
                  </span>
                  <span id={descriptionId} {...stylex.props(styles.detail)}>
                    {description}
                  </span>
                </span>
                <span id={exampleId} {...stylex.props(styles.example)}>
                  &ldquo;{example}&rdquo;
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <p {...stylex.props(styles.detail)}>
        {!cleanupSupported
          ? "Text cleanup is available for English only. Choose English in Settings to use your saved style."
          : !cleanupEnabled
            ? "Turn on cleanup to apply a style. Your transcript is currently inserted as recognized."
            : "Applies to English dictation. Your meaning stays the same."}
      </p>
      {saveError && (
        <p role="alert" {...stylex.props(styles.error)}>
          {saveError}
        </p>
      )}
    </div>
  );
}
