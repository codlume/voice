import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import * as stylex from "@stylexjs/stylex";
import { CheckIcon } from "lucide-react";
import { useId } from "react";

import { finishText, type WritingStyle } from "@voice/cleanup/style";

import type { Settings as SettingsValue, SettingsPatch } from "../shared/api.ts";
import { supportsCleanup, wantsCleanup } from "../shared/dictation-language.ts";
import { pageStyles } from "./pageStyles.ts";
import { Switch } from "./Switch.tsx";
import { color, font, radius, space } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";
import { hubApi } from "./voice.ts";

const SAMPLE = "I'll be there at 5. Don't worry, it's fine.";

const writingStyles: { value: WritingStyle; label: string; rule: string }[] = [
  { value: "formal", label: "Formal", rule: "Caps + punctuation" },
  { value: "casual", label: "Casual", rule: "Caps, no period at the end" },
  { value: "veryCasual", label: "Very casual", rule: "No caps, no period at the end" },
];

const styles = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: space.lg },
  header: { display: "flex", flexDirection: "column", gap: space.sm },
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
      default: "repeat(3, minmax(0, 1fr))",
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
    outline: { default: "none", ":focus-visible": `2px solid ${color["--ring"]}` },
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
});

export function Style({ settings }: { settings: SettingsValue }) {
  const name = useId();
  const cleanupId = useId();
  const { error: saveError, run } = useAction();
  const cleanupSupported = supportsCleanup(settings.dictationLanguage);
  const cleanupEnabled = wantsCleanup(settings);

  const changeCleanup = (cleanup: NonNullable<SettingsPatch["cleanup"]>) =>
    run(() => hubApi().updateSettings({ cleanup }), "Could not save your style settings.");

  return (
    <div {...stylex.props(styles.page)}>
      <header {...stylex.props(styles.header)}>
        <h1 {...stylex.props(pageStyles.headline)}>Style</h1>
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
        <legend id={`${name}-legend`} {...stylex.props(styles.legend)}>
          Writing style
        </legend>
        <RadioGroup<WritingStyle>
          aria-labelledby={`${name}-legend`}
          value={settings.cleanup.style}
          disabled={!cleanupEnabled}
          onValueChange={(style) => void changeCleanup({ style })}
          {...stylex.props(styles.grid)}
        >
          {writingStyles.map(({ value, label, rule }) => {
            const selected = settings.cleanup.style === value;
            const labelId = `${name}-${value}-label`;
            const ruleId = `${name}-${value}-rule`;
            const exampleId = `${name}-${value}-example`;
            return (
              <Radio.Root
                key={value}
                value={value}
                aria-labelledby={labelId}
                aria-describedby={`${ruleId} ${exampleId}`}
                {...stylex.props(
                  styles.card,
                  selected && styles.selected,
                  !cleanupEnabled && styles.disabled,
                )}
              >
                <span>
                  <span {...stylex.props(styles.cardHeader)}>
                    <span id={labelId} {...stylex.props(styles.cardTitle)}>
                      {label}
                    </span>
                    <span
                      aria-hidden="true"
                      {...stylex.props(styles.mark, selected && styles.markSelected)}
                    >
                      <CheckIcon size={12} strokeWidth={3} />
                    </span>
                  </span>
                  <span id={ruleId} {...stylex.props(styles.detail)}>
                    {rule}
                  </span>
                </span>
                <span id={exampleId} {...stylex.props(styles.example)}>
                  &ldquo;{finishText(value, SAMPLE)}&rdquo;
                </span>
              </Radio.Root>
            );
          })}
        </RadioGroup>
      </fieldset>

      <p {...stylex.props(styles.detail)}>
        {!cleanupSupported
          ? "Text cleanup is available for English only. Choose English in Settings to use your saved style."
          : !cleanupEnabled
            ? "Turn on cleanup to apply a style. Your transcript is currently inserted as recognized."
            : "Applies to English dictation. Your meaning stays the same."}
      </p>
      {saveError && (
        <p role="alert" {...stylex.props(pageStyles.error)}>
          {saveError}
        </p>
      )}
    </div>
  );
}
