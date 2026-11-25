import { Popover } from "@base-ui/react/popover";
import * as stylex from "@stylexjs/stylex";
import { CheckIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";

import type { Category } from "../shared/app-categories.ts";
import type { Assignment } from "../shared/style.ts";
import { AppIcon } from "./AppIcon.tsx";
import { Button } from "./Button.tsx";
import { transitionHidden } from "./ConfirmDialog.tsx";
import { Input, SearchField } from "./Input.tsx";
import { pageStyles } from "./pageStyles.ts";
import {
  CATEGORY_LABELS,
  pickerRows,
  rowHint,
  siteInput,
  type Chip,
  type PickerRow,
} from "./styleView.ts";
import { surfaces } from "./surfaces.ts";
import { color, leading, radius, space, text } from "./tokens.stylex.ts";
import type { useAction } from "./useAction.ts";
import type { InstalledApps } from "./useInstalledApps.ts";
import { hubApi } from "./voice.ts";

const IME_COMPOSITION_KEY_CODE = 229;
const composing = (event: KeyboardEvent) =>
  event.nativeEvent.isComposing || event.keyCode === IME_COMPOSITION_KEY_CODE;

const styles = stylex.create({
  // Adapted outline badge (MIT, see THIRD_PARTY_NOTICES.md), with the app icon in front and a small
  // remove button behind.
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.xs,
    height: 24,
    paddingInlineStart: space.xs,
    paddingInlineEnd: 3,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.input,
    borderRadius: radius.medium,
    backgroundColor: color.control,
    fontSize: text.xs,
    fontWeight: 500,
    lineHeight: leading.xs,
  },
  chipName: { maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  remove: {
    display: "grid",
    placeItems: "center",
    width: 16,
    height: 16,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.xs,
    backgroundColor: { default: "transparent", ":hover": color.accent },
    color: { default: color.mutedForeground, ":hover": color.foreground },
    cursor: "pointer",
  },
  // The "+" is the small outline icon button.
  add: {
    display: "grid",
    placeItems: "center",
    width: 24,
    height: 24,
    padding: 0,
    color: { default: color.mutedForeground, ":hover": color.foreground },
    cursor: "pointer",
  },
  positioner: { zIndex: 20 },
  popup: {
    display: "flex",
    flexDirection: "column",
    gap: space.xxs,
    width: "20rem",
    maxWidth: "var(--available-width)",
    padding: space.xxs,
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: space.xxs,
    padding: space.xxs,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    height: "12.5rem",
    marginInline: -4,
    paddingInline: 4,
    overflowY: "auto",
  },
  row: { flexShrink: 0 },
  rowName: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  hint: { flexShrink: 0, color: color.mutedForeground, fontSize: text.xs, lineHeight: leading.xs },
  here: { display: "flex", flexShrink: 0, color: color.primary },
  empty: {
    margin: 0,
    paddingBlock: space.sm,
    paddingInline: space.sm,
    color: color.mutedForeground,
  },
  siteRow: { display: "flex", gap: space.sm },
  separator: { flexShrink: 0, borderWidth: 0 },
  status: {
    minHeight: leading.xs,
    margin: 0,
    paddingInline: 2,
    color: color.mutedForeground,
    fontSize: text.xs,
    lineHeight: leading.xs,
  },
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
        <XIcon size={12} strokeWidth={2.25} />
      </button>
    </span>
  );
}

type Action = ReturnType<typeof useAction>;

type PickerProps = {
  category: Category;
  assignments: readonly Assignment[];
  installed: InstalledApps;
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
        {...stylex.props(surfaces.control, styles.add)}
      >
        <PlusIcon size={14} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          {...stylex.props(styles.positioner)}
        >
          <Popover.Popup
            initialFocus={searchRef}
            aria-label={`Add to ${CATEGORY_LABELS[picker.category]}`}
            className={({ transitionStatus }) =>
              stylex.props(
                surfaces.popup,
                surfaces.popupMotion,
                styles.popup,
                transitionHidden(transitionStatus) && surfaces.popupHidden,
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
  const rows = pickerRows(installed.apps, assignments, query);
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
        <label htmlFor={`${id}-search`} {...stylex.props(surfaces.groupLabel)}>
          Apps
        </label>
        <SearchField
          ref={searchRef}
          id={`${id}-search`}
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
                  {...stylex.props(
                    surfaces.item,
                    styles.row,
                    index === activeIndex && surfaces.itemHighlighted,
                  )}
                >
                  <AppIcon bundleId={row.bundleId} name={row.name} size={16} decorative />
                  <span {...stylex.props(styles.rowName)}>{row.name}</span>
                  {hint !== null && <span {...stylex.props(styles.hint)}>{hint}</span>}
                  {row.current === category && (
                    <span {...stylex.props(styles.here)}>
                      <CheckIcon size={16} aria-hidden />
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {rows.length === 0 && (
            <p {...stylex.props(styles.empty)}>
              {installed.failed
                ? "Could not list your apps"
                : query.trim() === ""
                  ? "No apps found"
                  : `No apps match “${query.trim()}”`}
            </p>
          )}
        </div>
      </div>

      <hr {...stylex.props(surfaces.separator, styles.separator)} />

      <div {...stylex.props(styles.section)}>
        <label htmlFor={`${id}-site`} {...stylex.props(surfaces.groupLabel)}>
          Add website
        </label>
        <div {...stylex.props(styles.siteRow)}>
          <Input
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
