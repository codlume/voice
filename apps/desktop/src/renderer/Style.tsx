import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Tabs } from "@base-ui/react/tabs";
import { Tooltip } from "@base-ui/react/tooltip";
import * as stylex from "@stylexjs/stylex";
import { CheckIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { finishText, type WritingStyle } from "@voice/cleanup/style";

import type { Settings as SettingsValue, SettingsPatch } from "../shared/api.ts";
import { CATEGORIES, type Category } from "../shared/app-categories.ts";
import { supportsCleanup, wantsCleanup } from "../shared/dictation-language.ts";
import type { Assignment } from "../shared/style.ts";
import { AppIcon } from "./AppIcon.tsx";
import { pageStyles } from "./pageStyles.ts";
import { AddToCategory, AssignmentChip } from "./StyleAssignments.tsx";
import { bannerApps, CATEGORY_LABELS, chips } from "./styleView.ts";
import { Switch } from "./Switch.tsx";
import { segmentStyles } from "./ToggleGroup.tsx";
import { color, elevation, leading, motion, radius, space, text } from "./tokens.stylex.ts";
import { tooltipPopupClass, tooltipPositionerClass } from "./tooltip.ts";
import { useAction } from "./useAction.ts";
import { useInstalledApps, type InstalledApps } from "./useInstalledApps.ts";
import { hubApi } from "./voice.ts";

const SEMI_FORMAL_EXAMPLES: Record<Category, string> = {
  personal: "Hey, are you free for lunch tomorrow? Let's do 12 if that works for you.",
  work: "Hey Anna, can we move the sync to Thursday at 3pm? I'll send the notes to the team.",
  email: "Hi John,\n\nThanks for the update. I will review it tomorrow.",
  other: "The quarterly numbers look good, and churn is down.",
};

const APPLIES_IN: Record<Category, string> = {
  personal: "personal messengers",
  work: "workplace messengers",
  email: "all major email apps",
  other: "all other apps",
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
    paddingBlock: space.md,
    paddingInline: space.base,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.large,
    backgroundColor: color.card,
    boxShadow: elevation.xs,
  },
  cleanupText: { flexGrow: 1, minWidth: 0 },
  tabs: { display: "flex", flexDirection: "column", gap: space.md },
  // Base UI renders each tab as a <button>; the segment look supplies everything else.
  tab: { borderWidth: 0, fontFamily: "inherit" },
  panel: { display: "flex", flexDirection: "column", gap: space.base, borderRadius: radius.medium },
  banner: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space.sm,
    rowGap: space.xxs,
    minHeight: 24,
  },
  apps: { display: "flex", alignItems: "center", gap: space.xxs },
  appCell: { display: "grid", placeItems: "center", width: 24, height: 24 },
  more: {
    paddingInline: 2,
    color: color.mutedForeground,
    fontSize: text.xs,
    fontWeight: 500,
    fontVariantNumeric: "tabular-nums",
  },
  title: { display: "block", fontWeight: 500 },
  detail: { margin: 0, color: color.mutedForeground, fontSize: text.xs, lineHeight: leading.xs },
  fieldset: { minWidth: 0, margin: 0, padding: 0, borderWidth: 0 },
  legend: {
    padding: 0,
    marginBottom: space.sm,
    color: color.mutedForeground,
    fontSize: text.xs,
    fontWeight: 500,
    lineHeight: leading.xs,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(3, minmax(0, 1fr))",
      "@media (max-width: 780px)": "minmax(0, 1fr)",
    },
    gap: space.md,
  },
  // Adapted option card (MIT, see THIRD_PARTY_NOTICES.md): a hairline ring instead of a border, and
  // a 2px accent ring over a faint accent fill once picked.
  card: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    minHeight: 128,
    padding: space.md,
    borderRadius: radius.medium,
    backgroundColor: {
      default: color.card,
      ":hover": "oklch(98.5% 0 0)",
      [motion.dark]: { default: "rgb(255 255 255 / 3%)", ":hover": "rgb(255 255 255 / 5%)" },
    },
    boxShadow: {
      default: "0 0 0 1px rgb(0 0 0 / 5%)",
      [motion.dark]: "0 0 0 1px rgb(255 255 255 / 5%)",
    },
    color: color.mutedForeground,
    textAlign: "start",
    cursor: "pointer",
    transitionProperty: "background-color, box-shadow",
    transitionDuration: { default: motion.base, [motion.reduced]: "0s" },
  },
  selected: {
    backgroundColor: {
      default: `color-mix(in oklab, ${color.primary} 8%, transparent)`,
      [motion.dark]: `color-mix(in oklab, ${color.primary} 15%, transparent)`,
    },
    boxShadow: `inset 0 0 0 2px ${color.primary}`,
    color: color.foreground,
  },
  disabled: { opacity: 0.64, cursor: "not-allowed" },
  cardHeader: { display: "flex", alignItems: "center", gap: space.sm, minHeight: 20 },
  cardTitle: { flexGrow: 1, color: color.foreground, fontSize: text.sm, fontWeight: 500 },
  mark: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 20,
    height: 20,
    borderRadius: radius.round,
    backgroundColor: color.primary,
    color: color.primaryForeground,
  },
  example: {
    display: "block",
    margin: 0,
    fontSize: text.sm,
    lineHeight: leading.sm,
    whiteSpace: "pre-line",
  },
});

export function Style({ settings }: { settings: SettingsValue }) {
  const name = useId();
  const cleanupId = useId();
  const action = useAction();
  const { error: saveError, run } = action;
  const cleanupSupported = supportsCleanup(settings.dictationLanguage);
  const cleanupEnabled = wantsCleanup(settings);
  const [category, setCategory] = useState<Category>("personal");
  const [openPicker, setOpenPicker] = useState<Category | null>(null);
  const installed = useInstalledApps();
  const { assignments } = settings.cleanup;

  const changeCleanup = (cleanup: NonNullable<SettingsPatch["cleanup"]>) =>
    run(() => hubApi().updateSettings({ cleanup }), "Could not save your style settings.");
  const removeAssignment = (assignment: Assignment) =>
    run(
      () => hubApi().editAssignments({ op: "unassign", assignment }),
      "Could not save your style settings.",
    );

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
        <Tabs.List {...stylex.props(segmentStyles.track)}>
          {CATEGORIES.map((value) => (
            <Tabs.Tab
              key={value}
              value={value}
              {...stylex.props(
                segmentStyles.segment,
                styles.tab,
                value === category && segmentStyles.on,
              )}
            >
              {CATEGORY_LABELS[value]}
            </Tabs.Tab>
          ))}
        </Tabs.List>
        {CATEGORIES.map((value) => (
          <Tabs.Panel key={value} value={value} {...stylex.props(styles.panel)}>
            <AppliesIn
              category={value}
              installed={installed}
              assignments={assignments}
              action={action}
              pickerOpen={openPicker === value}
              onPickerOpenChange={(open) =>
                setOpenPicker((current) => (open ? value : current === value ? null : current))
              }
              onRemove={removeAssignment}
            />
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
            : "Style applies to English dictation. Voice checks which app, and which website in a browser, you are dictating into, on this Mac only. Nothing is sent. Insights counts your words per app."}
      </p>
      {saveError && openPicker !== category && (
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
  assignments,
  action,
  pickerOpen,
  onPickerOpenChange,
  onRemove,
}: {
  category: Category;
  installed: InstalledApps;
  assignments: readonly Assignment[];
  action: ReturnType<typeof useAction>;
  pickerOpen: boolean;
  onPickerOpenChange: (open: boolean) => void;
  onRemove: (assignment: Assignment) => void;
}) {
  const addRef = useRef<HTMLButtonElement>(null);
  const { shown, overflow } = bannerApps(category, installed.apps, assignments);
  const hidden = overflow.join(", ");
  return (
    <div {...stylex.props(styles.banner)}>
      <p {...stylex.props(styles.detail)}>This style applies in {APPLIES_IN[category]}</p>
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
      {chips(category, assignments).map((chip) => (
        <AssignmentChip
          key={chip.key}
          chip={chip}
          category={category}
          onRemove={(assignment) => {
            addRef.current?.focus();
            onRemove(assignment);
          }}
        />
      ))}
      <AddToCategory
        category={category}
        assignments={assignments}
        installed={installed}
        action={action}
        open={pickerOpen}
        onOpenChange={onPickerOpenChange}
        triggerRef={addRef}
      />
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
                  {selected && (
                    <span aria-hidden="true" {...stylex.props(styles.mark)}>
                      <CheckIcon size={14} />
                    </span>
                  )}
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
