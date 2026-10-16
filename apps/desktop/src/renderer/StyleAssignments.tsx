import { Popover } from "@base-ui/react/popover";
import * as stylex from "@stylexjs/stylex";
import { CheckIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";

import type { InstalledApp } from "../shared/api.ts";
import type { Category } from "../shared/app-categories.ts";
import type { Assignment } from "../shared/style.ts";
import { AppIcon } from "./AppIcon.tsx";
import { Button } from "./Button.tsx";
import { pageStyles } from "./pageStyles.ts";
import {
  CATEGORY_LABELS,
  pickerRows,
  rowHint,
  siteInput,
  type Chip,
  type PickerRow,
} from "./styleView.ts";
import { color, font, radius, space } from "./tokens.stylex.ts";
import type { useAction } from "./useAction.ts";
import { hubApi } from "./voice.ts";

const IME_COMPOSITION_KEY_CODE = 229;
const composing = (event: KeyboardEvent) =>
  event.nativeEvent.isComposing || event.keyCode === IME_COMPOSITION_KEY_CODE;

const reducedMotion = "@media (prefers-reduced-motion: reduce)";

const styles = stylex.create({
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    height: 24,
    paddingInlineStart: 4,
    paddingInlineEnd: 2,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.round,
    backgroundColor: color.card,
    fontSize: 12,
  },
  chipName: { maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  remove: {
    display: "grid",
    placeItems: "center",
    width: 18,
    height: 18,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.round,
    backgroundColor: { default: "transparent", ":hover": color.accent },
    color: { default: color.mutedForeground, ":hover": color.foreground },
    cursor: "pointer",
    outline: { default: "none", ":focus-visible": `2px solid ${color["--ring"]}` },
  },
  add: {
    display: "grid",
    placeItems: "center",
    width: 24,
    height: 24,
    padding: 0,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: color.input,
    borderRadius: radius.round,
    backgroundColor: { default: "transparent", ":hover": color.accent },
    color: { default: color.mutedForeground, ":hover": color.foreground },
    cursor: "pointer",
    outline: { default: "none", ":focus-visible": `2px solid ${color["--ring"]}` },
  },
  positioner: { zIndex: 10 },
  popup: {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    width: "20rem",
    maxWidth: "var(--available-width)",
    padding: space.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.medium,
    backgroundColor: color.card,
    color: color.foreground,
    boxShadow: "0 8px 24px rgb(0 0 0 / 12%)",
    fontFamily: font.sans,
    fontSize: 13,
    WebkitFontSmoothing: "antialiased",
    opacity: 1,
    transitionProperty: "opacity",
    transitionDuration: { default: "150ms", [reducedMotion]: "0s" },
    outline: "none",
  },
  popupHidden: { opacity: 0 },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    margin: 0,
    padding: 0,
    borderWidth: 0,
  },
  label: { padding: 0, fontSize: 12, fontWeight: 600 },
  input: {
    width: "100%",
    minWidth: 0,
    paddingBlock: 6,
    paddingInline: 10,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: color.border, ":focus": color.input },
    borderRadius: radius.medium,
    backgroundColor: color.card,
    color: color.foreground,
    font: "inherit",
    fontSize: 13,
    outline: "none",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    height: "13.5rem",
    marginInline: -4,
    overflowY: "auto",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    flexShrink: 0,
    height: 30,
    paddingInline: 6,
    borderRadius: radius.small,
    cursor: "pointer",
  },
  rowActive: { backgroundColor: color.accent },
  rowName: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  hint: { flexShrink: 0, color: color.mutedForeground, fontSize: 12 },
  here: { flexShrink: 0, color: color.primary },
  empty: { margin: 0, paddingBlock: space.sm, paddingInline: 6, color: color.mutedForeground },
  siteRow: { display: "flex", gap: space.sm },
  status: { minHeight: 17, margin: 0, color: color.mutedForeground, fontSize: 12 },
  separator: { height: 1, margin: 0, borderWidth: 0, backgroundColor: color.border },
});

export function AssignmentChip({
  chip,
  category,
  onRemove,
}: {
  chip: Chip;
  category: Category;
  onRemove: (assignment: Assignment) => void;
}) {
  return (
    <span {...stylex.props(styles.chip)}>
      <AppIcon bundleId={chip.bundleId} name={chip.name} size={16} decorative />
      <span {...stylex.props(styles.chipName)}>{chip.name}</span>
      <button
        type="button"
        aria-label={`Remove ${chip.name} from ${CATEGORY_LABELS[category]}`}
        title="Remove"
        onClick={() => onRemove(chip.assignment)}
        {...stylex.props(styles.remove)}
      >
        <XIcon size={12} strokeWidth={2.5} />
      </button>
    </span>
  );
}

type Action = ReturnType<typeof useAction>;

type PickerProps = {
  category: Category;
  assignments: readonly Assignment[];
  installed: readonly InstalledApp[];
  action: Action;
};

export function AddToCategory({
  triggerRef,
  open,
  onOpenChange,
  ...picker
}: PickerProps & {
  triggerRef: RefObject<HTMLButtonElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger
        ref={triggerRef}
        aria-label={`Add an app or website to ${CATEGORY_LABELS[picker.category]}`}
        title="Add an app or website"
        {...stylex.props(styles.add)}
      >
        <PlusIcon size={14} strokeWidth={2.25} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          {...stylex.props(styles.positioner)}
        >
          <Popover.Popup
            initialFocus={searchRef}
            aria-label={`Add to ${CATEGORY_LABELS[picker.category]}`}
            className={({ transitionStatus }) =>
              stylex.props(
                styles.popup,
                (transitionStatus === "starting" || transitionStatus === "ending") &&
                  styles.popupHidden,
              ).className
            }
          >
            <Picker {...picker} searchRef={searchRef} onDone={() => onOpenChange(false)} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Picker({
  category,
  assignments,
  installed,
  action: { error, pending, run },
  searchRef,
  onDone,
}: PickerProps & {
  searchRef: RefObject<HTMLInputElement | null>;
  onDone: () => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [site, setSite] = useState("");
  const rows = pickerRows(category, installed, assignments, query);
  const activeIndex = Math.min(active, rows.length - 1);
  const optionId = (index: number) => `${id}-option-${index}`;
  const website = siteInput(site, category, assignments);

  useEffect(() => {
    document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [id, activeIndex]);

  async function save(assignment: Assignment) {
    const saved = await run(
      () => hubApi().editAssignments({ op: "place", assignment }),
      "Could not save your style settings.",
    );
    if (saved) onDone();
  }

  const pick = (row: PickerRow) =>
    void save({ kind: "app", bundleId: row.bundleId, name: row.name, category });

  function addSite() {
    if (website.kind === "add" && !pending) {
      void save({ kind: "site", host: website.host, category });
    }
  }

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (composing(event)) return;
    const move = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (move !== undefined) {
      event.preventDefault();
      setActive(Math.max(0, Math.min(rows.length - 1, activeIndex + move)));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[activeIndex];
      if (row && !pending) pick(row);
    }
  }

  return (
    <>
      <div {...stylex.props(styles.section)}>
        <label htmlFor={`${id}-search`} {...stylex.props(styles.label)}>
          Apps
        </label>
        <input
          ref={searchRef}
          id={`${id}-search`}
          type="search"
          role="combobox"
          placeholder="Search installed apps"
          autoComplete="off"
          spellCheck={false}
          aria-expanded
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onSearchKey}
          {...stylex.props(styles.input)}
        />
        <div {...stylex.props(styles.list)}>
          <div id={`${id}-list`} role="listbox" aria-label="Installed apps">
            {rows.map((row, index) => {
              const hint = rowHint(row, category);
              return (
                <div
                  key={row.bundleId}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === activeIndex}
                  aria-description={
                    row.current === category ? `Already in ${CATEGORY_LABELS[category]}` : undefined
                  }
                  onMouseMove={() => setActive(index)}
                  onClick={() => !pending && pick(row)}
                  {...stylex.props(styles.row, index === activeIndex && styles.rowActive)}
                >
                  <AppIcon bundleId={row.bundleId} name={row.name} size={20} decorative />
                  <span {...stylex.props(styles.rowName)}>{row.name}</span>
                  {hint !== null && <span {...stylex.props(styles.hint)}>{hint}</span>}
                  {row.current === category && (
                    <span {...stylex.props(styles.here)}>
                      <CheckIcon size={14} strokeWidth={2.5} aria-hidden />
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {rows.length === 0 && (
            <p {...stylex.props(styles.empty)}>
              {query.trim() === "" ? "No apps found" : `No apps match “${query.trim()}”`}
            </p>
          )}
        </div>
      </div>

      <hr {...stylex.props(styles.separator)} />

      <div {...stylex.props(styles.section)}>
        <label htmlFor={`${id}-site`} {...stylex.props(styles.label)}>
          Add website
        </label>
        <div {...stylex.props(styles.siteRow)}>
          <input
            id={`${id}-site`}
            placeholder="slack.com or a link"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${id}-site-status`}
            aria-invalid={website.kind === "invalid"}
            value={site}
            onChange={(event) => setSite(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || composing(event)) return;
              event.preventDefault();
              addSite();
            }}
            {...stylex.props(styles.input)}
          />
          <Button
            variant="secondary"
            disabled={website.kind !== "add" || pending}
            onClick={addSite}
          >
            Add
          </Button>
        </div>
        <p id={`${id}-site-status`} aria-live="polite" {...stylex.props(styles.status)}>
          {website.kind === "empty" ? "" : website.message}
        </p>
      </div>

      {error && (
        <p role="alert" {...stylex.props(pageStyles.error)}>
          {error}
        </p>
      )}
    </>
  );
}
