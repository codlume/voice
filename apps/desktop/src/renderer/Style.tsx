import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Tabs } from "@base-ui/react/tabs";
import { Tooltip } from "@base-ui/react/tooltip";
import * as stylex from "@stylexjs/stylex";
import { CheckIcon } from "lucide-react";
import { useId, useState } from "react";

import { finishText, type WritingStyle } from "@voice/cleanup/style";

import type { InstalledApp, Settings as SettingsValue, SettingsPatch } from "../shared/api.ts";
import { CATEGORIES, type Category } from "../shared/app-categories.ts";
import { supportsCleanup, wantsCleanup } from "../shared/dictation-language.ts";
import { AppIcon } from "./AppIcon.tsx";
import { pageStyles } from "./pageStyles.ts";
import { bannerApps } from "./styleView.ts";
import { Switch } from "./Switch.tsx";
import { color, font, radius, space } from "./tokens.stylex.ts";
import { tooltipPopupClass, tooltipPositionerClass } from "./tooltip.ts";
import { useAction } from "./useAction.ts";
import { useInstalledApps } from "./useInstalledApps.ts";
import { hubApi } from "./voice.ts";

const SEMI_FORMAL_EXAMPLES: Record<Category, string> = {
  personal: "Hey, are you free for lunch tomorrow? Let's do 12 if that works for you.",
  work: "Hey Anna, can we move the sync to Thursday at 3pm? I'll send the notes to the team.",
  email: "Hi John,\n\nThanks for the update. I will review it tomorrow.",
  other: "The quarterly numbers look good, and churn is down.",
};

const CATEGORY_TABS: Record<Category, { label: string; appliesIn: string }> = {
  personal: { label: "Personal messages", appliesIn: "personal messengers" },
  work: { label: "Work messages", appliesIn: "workplace messengers" },
  email: { label: "Email", appliesIn: "all major email apps" },
  other: { label: "Other", appliesIn: "all other apps" },
};

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
  tabs: { display: "flex", flexDirection: "column", gap: space.md },
  tabList: {
    display: "grid",
    gridAutoFlow: "column",
    gridAutoColumns: "1fr",
    gap: 2,
    padding: 3,
    borderRadius: radius.medium,
    backgroundColor: color.segmentTrack,
  },
  tab: {
    paddingBlock: 6,
    paddingInline: space.md,
    borderWidth: 0,
    borderRadius: 7,
    backgroundColor: "transparent",
    color: color.mutedForeground,
    fontFamily: "inherit",
    fontSize: 13,
    textAlign: "center",
    cursor: "pointer",
    outline: { default: "none", ":focus-visible": `2px solid ${color["--ring"]}` },
  },
  tabOn: {
    backgroundColor: color.segmentSelected,
    color: color.foreground,
    fontWeight: 500,
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.1)",
  },
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    borderRadius: radius.medium,
    outline: { default: "none", ":focus-visible": `2px solid ${color["--ring"]}` },
    outlineOffset: 3,
  },
  banner: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space.sm,
    rowGap: 4,
    minHeight: 24,
  },
  apps: { display: "flex", alignItems: "center", gap: 4 },
  appCell: { display: "grid", placeItems: "center", width: 24, height: 24 },
  more: { paddingInline: 2, color: color.mutedForeground, fontSize: 12, fontWeight: 500 },
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
    whiteSpace: "pre-line",
  },
});

export function Style({ settings }: { settings: SettingsValue }) {
  const name = useId();
  const cleanupId = useId();
  const { error: saveError, run } = useAction();
  const cleanupSupported = supportsCleanup(settings.dictationLanguage);
  const cleanupEnabled = wantsCleanup(settings);
  const [category, setCategory] = useState<Category>("personal");
  const installed = useInstalledApps();

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

      <Tabs.Root
        value={category}
        onValueChange={(value: unknown) => {
          const next = CATEGORIES.find((c) => c === value);
          if (next) setCategory(next);
        }}
        {...stylex.props(styles.tabs)}
      >
        <Tabs.List {...stylex.props(styles.tabList)}>
          {CATEGORIES.map((value) => (
            <Tabs.Tab
              key={value}
              value={value}
              {...stylex.props(styles.tab, value === category && styles.tabOn)}
            >
              {CATEGORY_TABS[value].label}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        {CATEGORIES.map((value) => (
          <Tabs.Panel key={value} value={value} {...stylex.props(styles.panel)}>
            <AppliesIn category={value} installed={installed} />
            <StyleCards
              id={`${name}-${value}`}
              category={value}
              style={settings.cleanup.styles[value]}
              enabled={cleanupEnabled}
              onChange={(style) => void changeCleanup({ styles: { [value]: style } })}
            />
          </Tabs.Panel>
        ))}
      </Tabs.Root>

      <p {...stylex.props(styles.detail)}>
        {!cleanupSupported
          ? "Text cleanup is available for English only. Choose English in Settings to use your saved style."
          : !cleanupEnabled
            ? "Turn on cleanup to apply a style. Your transcript is currently inserted as recognized."
            : "Style applies to English dictation. Voice checks which app, and which website in a browser, you are dictating into, on this Mac only. Nothing is saved or sent."}
      </p>
      {saveError && (
        <p role="alert" {...stylex.props(pageStyles.error)}>
          {saveError}
        </p>
      )}
    </div>
  );
}

function AppliesIn({
  category,
  installed,
}: {
  category: Category;
  installed: readonly InstalledApp[];
}) {
  const { shown, overflow } = bannerApps(category, installed);
  const hidden = overflow.join(", ");
  return (
    <div {...stylex.props(styles.banner)}>
      <p {...stylex.props(styles.detail)}>
        This style applies in {CATEGORY_TABS[category].appliesIn}
      </p>
      {shown.length > 0 && (
        <Tooltip.Provider delay={150} closeDelay={0}>
          <Tooltip.Root<string>>
            {({ payload }) => (
              <>
                <span {...stylex.props(styles.apps)}>
                  {shown.map((app) => (
                    <Tooltip.Trigger
                      key={app.bundleId}
                      payload={app.name}
                      render={<span />}
                      {...stylex.props(styles.appCell)}
                    >
                      <AppIcon bundleId={app.bundleId} name={app.name} />
                    </Tooltip.Trigger>
                  ))}
                  {overflow.length > 0 && (
                    <Tooltip.Trigger
                      payload={hidden}
                      render={<span role="img" aria-label={`${overflow.length} more: ${hidden}`} />}
                      {...stylex.props(styles.more)}
                    >
                      +{overflow.length}
                    </Tooltip.Trigger>
                  )}
                </span>
                <Tooltip.Portal>
                  <Tooltip.Positioner
                    side="top"
                    sideOffset={6}
                    className={tooltipPositionerClass()}
                  >
                    <Tooltip.Popup className={tooltipPopupClass()}>{payload}</Tooltip.Popup>
                  </Tooltip.Positioner>
                </Tooltip.Portal>
              </>
            )}
          </Tooltip.Root>
        </Tooltip.Provider>
      )}
    </div>
  );
}

function StyleCards({
  id,
  category,
  style,
  enabled,
  onChange,
}: {
  id: string;
  category: Category;
  style: WritingStyle;
  enabled: boolean;
  onChange: (style: WritingStyle) => void;
}) {
  return (
    <fieldset disabled={!enabled} {...stylex.props(styles.fieldset)}>
      <legend id={`${id}-legend`} {...stylex.props(styles.legend)}>
        Writing style
      </legend>
      <RadioGroup<WritingStyle>
        aria-labelledby={`${id}-legend`}
        value={style}
        disabled={!enabled}
        onValueChange={onChange}
        {...stylex.props(styles.grid)}
      >
        {writingStyles.map(({ value, label, rule }) => {
          const selected = style === value;
          const labelId = `${id}-${value}-label`;
          const ruleId = `${id}-${value}-rule`;
          const exampleId = `${id}-${value}-example`;
          return (
            <Radio.Root
              key={value}
              value={value}
              aria-labelledby={labelId}
              aria-describedby={`${ruleId} ${exampleId}`}
              {...stylex.props(
                styles.card,
                selected && styles.selected,
                !enabled && styles.disabled,
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
                &ldquo;{finishText(value, SEMI_FORMAL_EXAMPLES[category])}&rdquo;
              </span>
            </Radio.Root>
          );
        })}
      </RadioGroup>
    </fieldset>
  );
}
