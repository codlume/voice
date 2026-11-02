import { Popover } from "@base-ui/react/popover";
import * as stylex from "@stylexjs/stylex";
import { ArrowLeftIcon, ArrowRightIcon, InfoIcon, XIcon } from "lucide-react";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  useMemo,
  useRef,
  type FocusEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { findAnchor, helpFor, type ViewHelp } from "./help.ts";
import { placeHelp, roomAbove } from "./helpPlacement.ts";
import type { AppPage } from "./HubShell.tsx";
import { pageStyles } from "./pageStyles.ts";
import { shortcuts, withShortcut } from "./shortcuts.ts";
import { color, font, radius, space } from "./tokens.stylex.ts";

/** The list of the page's items, focusing the one a step returned from; or one item's step. */
export type HelpState =
  | { kind: "closed" }
  | { kind: "list"; from?: number }
  | { kind: "step"; index: number };

export const helpClosed: HelpState = { kind: "closed" };

/** Links each page's info button to the one popover the hub renders. */
const helpHandle = Popover.createHandle();

type HelpControl = {
  open: boolean;
  /** The page's info button, which the popover sits beside and returns focus to. */
  placeButton: (element: HTMLButtonElement | null, page: AppPage) => void;
};

export const HelpContext = createContext<HelpControl | null>(null);

const popupId = "view-help";
const buttonId = (page: AppPage) => `view-help-${page}`;

const styles = stylex.create({
  row: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 },
  button: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 24,
    height: 24,
    marginTop: 6,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.round,
    backgroundColor: { default: "transparent", ":hover": color.accent },
    color: { default: color.mutedForeground, ":hover": color.foreground },
    cursor: "default",
  },
  buttonOpen: { backgroundColor: color.accent, color: color.foreground },
  positioner: { zIndex: 10 },
  popup: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    width: "18rem",
    maxHeight: "calc(100vh - 16px)",
    overflowY: "auto",
    padding: space.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.medium,
    backgroundColor: color.card,
    color: color.foreground,
    boxShadow: "0 8px 24px rgb(0 0 0 / 14%)",
    fontFamily: font.sans,
    fontSize: 13,
    lineHeight: 1.45,
    WebkitFontSmoothing: "antialiased",
    outline: "none",
  },
  head: { display: "flex", alignItems: "flex-start", gap: space.sm },
  heading: { flexGrow: 1, margin: 0, fontSize: 13, fontWeight: 600 },
  close: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 22,
    height: 22,
    marginTop: -2,
    marginRight: -4,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: { default: "transparent", ":hover": color.accent },
    color: color.mutedForeground,
    cursor: "default",
  },
  muted: { margin: 0, color: color.mutedForeground },
  srOnly: {
    position: "absolute",
    width: 1,
    height: 1,
    margin: 0,
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
  list: { display: "flex", flexDirection: "column", margin: 0, padding: 0, listStyle: "none" },
  item: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    paddingBlock: 5,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: color.border,
  },
  itemTitle: { flexGrow: 1, fontWeight: 500 },
  small: {
    flexShrink: 0,
    paddingBlock: 2,
    paddingInline: 8,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.small,
    backgroundColor: { default: color.card, ":hover": color.accent },
    color: color.foreground,
    font: "inherit",
    fontSize: 12,
    cursor: "default",
  },
  footer: { display: "flex", alignItems: "center", gap: space.sm, marginTop: 2 },
  count: { flexGrow: 1, color: color.mutedForeground, fontSize: 12 },
  nav: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    paddingBlock: 3,
    paddingInline: 10,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.small,
    backgroundColor: { default: color.card, ":hover": color.accent },
    color: color.foreground,
    font: "inherit",
    fontSize: 12,
    cursor: "default",
  },
  primary: {
    borderColor: color.primary,
    backgroundColor: {
      default: color.primary,
      ":hover": `color-mix(in srgb, ${color.primary} 90%, transparent)`,
    },
    color: color.primaryForeground,
  },
  link: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: { default: color.mutedForeground, ":hover": color.foreground },
    font: "inherit",
    fontSize: 12,
    cursor: "default",
  },
});

const scrolls = (element: Element) => {
  const { overflowX, overflowY } = getComputedStyle(element);
  return overflowX !== "visible" || overflowY !== "visible";
};

const scroller = (element: Element) => {
  for (let at = element.parentElement; at; at = at.parentElement) if (scrolls(at)) return at;
  return null;
};

/** Whether a container would cut off the ring drawn outside the control. */
function clipped(element: Element): boolean {
  const ring = element.getBoundingClientRect();
  const reach = 5;
  for (let at = element.parentElement; at; at = at.parentElement) {
    if (!scrolls(at)) continue;
    const box = at.getBoundingClientRect();
    if (
      ring.left - reach < box.left ||
      ring.top - reach < box.top ||
      ring.right + reach > box.right ||
      ring.bottom + reach > box.bottom
    ) {
      return true;
    }
  }
  return false;
}

/**
 * While help is open, Base UI puts a focus guard just before the info button and treats any focus
 * on it as Shift+Tab out of the popover, sending focus back to the sidebar. Tab from the page
 * itself (focus on main after a page switch or a click) lands there too; send it to the button.
 */
function tabIntoButton(event: FocusEvent<HTMLDivElement>) {
  const guard = event.target;
  const button = guard.nextElementSibling;
  if (!guard.hasAttribute("data-base-ui-focus-guard") || !(button instanceof HTMLElement)) return;
  const from = event.relatedTarget;
  const fromHelp =
    from === button || (from instanceof Node && document.getElementById(popupId)?.contains(from));
  if (fromHelp) return;
  event.stopPropagation();
  button.focus();
}

/** A page's title, with the info button when the page has help. */
export function HelpTitle({
  page,
  style,
  children,
}: {
  page: AppPage;
  style?: stylex.StyleXStyles;
  children: ReactNode;
}) {
  const control = use(HelpContext);
  const help = helpFor(page);
  const expanded = control?.open ?? false;
  const placeButton = control?.placeButton;
  const ref = useCallback(
    (element: HTMLButtonElement | null) => placeButton?.(element, page),
    [placeButton, page],
  );
  return (
    <div onFocusCapture={tabIntoButton} {...stylex.props(styles.row, style)}>
      <h1 {...stylex.props(pageStyles.headline)}>{children}</h1>
      {control && help && (
        <Popover.Trigger
          ref={ref}
          id={buttonId(page)}
          handle={helpHandle}
          aria-label={`How ${help.name} works`}
          aria-keyshortcuts="Meta+/"
          title={withShortcut(`How ${help.name} works`, shortcuts.help)}
          {...stylex.props(styles.button, expanded && styles.buttonOpen)}
        >
          <InfoIcon size={16} aria-hidden="true" />
        </Popover.Trigger>
      )}
    </div>
  );
}

/** The help for the page on screen, beside its info button; one per hub. */
export function HelpPopover({
  page,
  state,
  onChange,
  button,
}: {
  page: AppPage;
  state: HelpState;
  onChange: (state: HelpState) => void;
  button: HTMLButtonElement | null;
}) {
  const written = helpFor(page);
  const open = state.kind !== "closed" && written !== null && button !== null;
  // Only items whose control is on the page now: Search, the list and the overview need meetings,
  // and Insights draws its cards once its numbers load. Read after the page commits, so a page
  // switch never reads the old page, and again whenever the page changes while help is open.
  const [onScreen, setOnScreen] = useState<readonly string[]>([]);
  useLayoutEffect(() => {
    if (!open) return;
    const scan = () => {
      const present = written.items.flatMap(({ anchor }) => (findAnchor(anchor) ? [anchor] : []));
      setOnScreen((shown) => (shown.join() === present.join() ? shown : present));
    };
    scan();
    let frame = 0;
    const changes = new MutationObserver(() => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        scan();
      });
    });
    changes.observe(document.querySelector("main") ?? document.body, {
      childList: true,
      subtree: true,
    });
    return () => {
      changes.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [open, written]);
  const help = written && {
    ...written,
    items: written.items.filter(({ anchor }) => onScreen.includes(anchor)),
  };
  const step = open && help && state.kind === "step" ? help.items[state.index] : undefined;
  const target = step ? findAnchor(step.anchor) : null;
  const focusFirst = useRef<HTMLButtonElement>(null);
  const tryTarget = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!target) return;
    target.setAttribute("data-help-active", "");
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
    const shown = document.getElementById(popupId);
    if (shown && button) {
      const size = { width: shown.offsetWidth, height: shown.offsetHeight };
      const view = { width: document.documentElement.clientWidth, height: innerHeight };
      const box = target.getBoundingClientRect();
      if (!placeHelp({ view, button: button.getBoundingClientRect(), target: box, size }).clear) {
        scroller(target)?.scrollBy({ top: roomAbove({ target: box, size }) });
      }
    }
    if (clipped(target)) target.setAttribute("data-help-active", "inset");
    return () => target.removeAttribute("data-help-active");
  }, [target, button]);

  const moved = state.kind === "step" ? state.index : state.kind;
  useEffect(() => {
    if (open) focusFirst.current?.focus({ preventScroll: true });
    // moved is not read here: focus follows each move between the list and a step.
    // eslint-disable-next-line react/exhaustive-effect-dependencies
  }, [open, moved]);

  // A point beside the info button, or beside the control when the button's side would cover it.
  const anchor = useMemo(
    () =>
      button && {
        contextElement: button,
        getBoundingClientRect: () => {
          const shown = document.getElementById(popupId);
          const size = shown
            ? { width: shown.offsetWidth, height: shown.offsetHeight }
            : { width: 288, height: 240 };
          const at = placeHelp({
            view: { width: document.documentElement.clientWidth, height: innerHeight },
            button: button.getBoundingClientRect(),
            target: target?.getBoundingClientRect() ?? null,
            size,
          });
          return new DOMRect(at.x, at.y, 0, 0);
        },
      },
    [button, target],
  );

  if (!help) return null;
  const go = (index: number) => {
    if (index >= 0 && index < help.items.length) onChange({ kind: "step", index });
  };

  return (
    <Popover.Root
      handle={helpHandle}
      open={open}
      triggerId={buttonId(page)}
      onOpenChange={(next, details) => {
        // Help stays up while the user works the page and moves between pages; it closes on purpose.
        if (details.reason === "outside-press" || details.reason === "focus-out") return;
        // Escape belongs to whatever has focus; on the page it might clear a search instead.
        const focused = document.activeElement;
        const inHelp =
          focused === button || document.getElementById(popupId)?.contains(focused) === true;
        if (details.reason === "escape-key" && !inHelp) return;
        onChange(next ? { kind: "list" } : helpClosed);
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          anchor={anchor}
          side="bottom"
          align="start"
          sideOffset={0}
          collisionAvoidance={{ side: "none", align: "none", fallbackAxisSide: "none" }}
          {...stylex.props(styles.positioner)}
        >
          <Popover.Popup
            id={popupId}
            data-app-modal=""
            aria-labelledby={`${popupId}-heading`}
            aria-describedby={`${popupId}-text`}
            initialFocus={focusFirst}
            finalFocus={() => {
              const next = tryTarget.current ?? button;
              tryTarget.current = null;
              return next;
            }}
            onKeyDown={(event) => {
              if (state.kind !== "step") return;
              if (event.key === "ArrowRight") go(state.index + 1);
              else if (event.key === "ArrowLeft") go(state.index - 1);
              else return;
              event.preventDefault();
            }}
            {...stylex.props(styles.popup)}
          >
            {/* Focus stays on Next while the steps change, so the step is read out from here. */}
            <p role="status" {...stylex.props(styles.srOnly)}>
              {step &&
                state.kind === "step" &&
                `${step.title}, ${state.index + 1} of ${help.items.length}. ${step.body}`}
            </p>
            {state.kind === "step" && step ? (
              <Step
                help={help}
                index={state.index}
                focusRef={focusFirst}
                onGo={go}
                onList={() => onChange({ kind: "list", from: state.index })}
                onTry={() => {
                  tryTarget.current = target;
                  onChange(helpClosed);
                }}
                onDone={() => onChange(helpClosed)}
              />
            ) : (
              <List
                help={help}
                from={state.kind === "list" ? state.from : undefined}
                focusRef={focusFirst}
                onShow={go}
              />
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Head({ children }: { children: ReactNode }) {
  return (
    <div {...stylex.props(styles.head)}>
      <h2 id={`${popupId}-heading`} {...stylex.props(styles.heading)}>
        {children}
      </h2>
      <Popover.Close aria-label="Close help" {...stylex.props(styles.close)}>
        <XIcon size={14} aria-hidden="true" />
      </Popover.Close>
    </div>
  );
}

function List({
  help,
  from,
  focusRef,
  onShow,
}: {
  help: ViewHelp;
  from: number | undefined;
  focusRef: RefObject<HTMLButtonElement | null>;
  onShow: (index: number) => void;
}) {
  const focused = from ?? 0;
  return (
    <>
      <Head>How {help.name} works</Head>
      <p id={`${popupId}-text`} {...stylex.props(styles.muted)}>
        {help.overview}
      </p>
      <ul {...stylex.props(styles.list)}>
        {help.items.map((item, index) => (
          <li key={item.anchor} {...stylex.props(styles.item)}>
            <span {...stylex.props(styles.itemTitle)}>{item.title}</span>
            <button
              ref={index === focused ? focusRef : undefined}
              type="button"
              aria-label={`Show me ${item.title}`}
              // VoiceOver reads the button help opens on, not the dialog's description.
              aria-describedby={index === focused ? `${popupId}-text` : undefined}
              onClick={() => onShow(index)}
              {...stylex.props(styles.small)}
            >
              Show me
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function Step({
  help,
  index,
  focusRef,
  onGo,
  onList,
  onTry,
  onDone,
}: {
  help: ViewHelp;
  index: number;
  focusRef: RefObject<HTMLButtonElement | null>;
  onGo: (index: number) => void;
  onList: () => void;
  onTry: () => void;
  onDone: () => void;
}) {
  const item = help.items[index]!;
  const last = index === help.items.length - 1;
  return (
    <>
      <Head>{item.title}</Head>
      <p id={`${popupId}-text`} {...stylex.props(styles.muted)}>
        {item.body}
      </p>
      <div {...stylex.props(styles.footer)}>
        <button type="button" onClick={onList} {...stylex.props(styles.link)}>
          All tips
        </button>
        <span {...stylex.props(styles.count)}>
          {index + 1} of {help.items.length}
        </span>
        <button type="button" onClick={onTry} {...stylex.props(styles.link)}>
          Try it
        </button>
        {index > 0 && (
          <button
            type="button"
            aria-label="Back"
            onClick={() => onGo(index - 1)}
            {...stylex.props(styles.nav)}
          >
            <ArrowLeftIcon size={13} aria-hidden="true" />
          </button>
        )}
        <button
          ref={focusRef}
          type="button"
          onClick={last ? onDone : () => onGo(index + 1)}
          {...stylex.props(styles.nav, styles.primary)}
        >
          {last ? "Done" : "Next"}
          {!last && <ArrowRightIcon size={13} aria-hidden="true" />}
        </button>
      </div>
    </>
  );
}
