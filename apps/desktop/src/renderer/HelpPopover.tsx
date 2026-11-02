import { Popover } from "@base-ui/react/popover";
import * as stylex from "@stylexjs/stylex";
import { ArrowLeftIcon, ArrowRightIcon, InfoIcon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { findAnchor, viewHelp, type ViewHelp } from "./help.ts";
import type { AppPage } from "./HubShell.tsx";
import { pageStyles } from "./pageStyles.ts";
import { color, font, radius, space } from "./tokens.stylex.ts";

const reducedMotion = "@media (prefers-reduced-motion: reduce)";
const easing = "cubic-bezier(0.2, 0, 0, 1)";
const ringPadding = 4;

type Item = ViewHelp["items"][number];

/** Overview lists the view's items, focusing the one a step returned from; a step spotlights `items[index]`. */
type Tour = { kind: "overview"; from?: number } | { kind: "step"; index: number };

// Prototype switch: the step card stays on the info icon, or moves beside the spotlighted control.
const followTarget = () => localStorage.getItem("voice.helpAnchor") !== "icon";

const fadeIn = stylex.keyframes({ from: { opacity: 0 } });

const styles = stylex.create({
  row: { display: "flex", alignItems: "center", gap: 6 },
  trigger: {
    display: "grid",
    placeItems: "center",
    width: 24,
    height: 24,
    marginTop: 6,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.round,
    backgroundColor: { default: "transparent", ":hover": color.accent },
    color: { default: color.mutedForeground, ":hover": color.foreground },
    cursor: "default",
    outline: { default: "none", ":focus-visible": `2px solid ${color["--ring"]}` },
  },
  triggerOpen: { backgroundColor: color.accent, color: color.foreground },
  positioner: { zIndex: 10 },
  popup: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    width: "18rem",
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
    lineHeight: 1.45,
    WebkitFontSmoothing: "antialiased",
    outline: "none",
    opacity: 1,
    transitionProperty: "opacity",
    transitionDuration: { default: "120ms", [reducedMotion]: "0s" },
    transitionTimingFunction: easing,
  },
  popupHidden: { opacity: 0 },
  overview: { margin: 0, color: color.mutedForeground },
  list: { display: "flex", flexDirection: "column", margin: 0, padding: 0, listStyle: "none" },
  item: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    paddingBlock: 6,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: color.border,
  },
  itemTitle: { flexGrow: 1, fontWeight: 500 },
  showMe: {
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
    cursor: "pointer",
    outline: { default: "none", ":focus-visible": `2px solid ${color["--ring"]}` },
  },
  stepTitle: { margin: 0, paddingRight: 20, fontSize: 13, fontWeight: 600 },
  close: {
    position: "absolute",
    top: 8,
    right: 8,
    display: "grid",
    placeItems: "center",
    width: 22,
    height: 22,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: { default: "transparent", ":hover": color.accent },
    color: color.mutedForeground,
    cursor: "pointer",
    outline: { default: "none", ":focus-visible": `2px solid ${color["--ring"]}` },
  },
  stepBody: { margin: 0, color: color.mutedForeground },
  srOnly: {
    position: "absolute",
    width: 1,
    height: 1,
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
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
    cursor: "pointer",
    outline: { default: "none", ":focus-visible": `2px solid ${color["--ring"]}` },
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
    cursor: "pointer",
    textDecoration: { default: "none", ":focus-visible": "underline" },
    outline: "none",
  },
  spotlight: {
    position: "fixed",
    top: 0,
    left: 0,
    zIndex: 9,
    borderRadius: radius.medium,
    boxShadow: `0 0 0 2px ${color.primary}, 0 0 0 100vmax rgb(0 0 0 / 35%)`,
    pointerEvents: "none",
    willChange: "transform",
    animationName: fadeIn,
    animationDuration: { default: "140ms", [reducedMotion]: "0s" },
    transitionProperty: "transform, width, height",
    transitionDuration: { default: "180ms", [reducedMotion]: "0s" },
    transitionTimingFunction: easing,
  },
});

/** A view's title with the info icon that opens its help. */
export function HelpTitle({
  page,
  style,
  children,
}: {
  page: AppPage;
  style?: stylex.StyleXStyles;
  children: ReactNode;
}) {
  return (
    <div {...stylex.props(styles.row, style)}>
      <h1 {...stylex.props(pageStyles.headline)}>{children}</h1>
      <HelpPopover page={page} />
    </div>
  );
}

function HelpPopover({ page }: { page: AppPage }) {
  const help: ViewHelp = viewHelp[page];
  const label = help.name;
  const [open, setOpen] = useState(false);
  const [tour, setTour] = useState<Tour>({ kind: "overview" });
  // Only items whose control is on screen right now; search and the overview come and go.
  const [items, setItems] = useState<readonly Item[]>([]);
  const finalFocus = useRef<HTMLElement | null>(null);
  const stepFocus = useRef<HTMLButtonElement>(null);
  const overviewFocus = useRef<HTMLButtonElement>(null);

  const step = tour.kind === "step" ? items[tour.index] : undefined;
  const target = step ? findAnchor(step.anchor) : null;

  function onOpenChange(next: boolean) {
    if (next) {
      setItems(help.items.filter((item) => findAnchor(item.anchor)));
      setTour({ kind: "overview" });
      finalFocus.current = null;
    }
    setOpen(next);
  }

  useEffect(() => {
    if (tour.kind === "step") stepFocus.current?.focus({ preventScroll: true });
    else if (tour.from !== undefined) overviewFocus.current?.focus({ preventScroll: true });
  }, [tour]);

  const go = (index: number) => {
    if (index < 0 || index >= items.length) return;
    setTour({ kind: "step", index });
  };

  const tryIt = () => {
    finalFocus.current = target;
    setOpen(false);
  };

  return (
    // While a step shows, Tab cycles the step card; Try it hands focus to the control.
    <Popover.Root
      open={open}
      onOpenChange={onOpenChange}
      modal={tour.kind === "step" ? "trap-focus" : false}
    >
      <Popover.Trigger
        aria-label={`How ${label} works`}
        title={`How ${label} works`}
        {...stylex.props(styles.trigger, open && styles.triggerOpen)}
      >
        <InfoIcon size={16} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="bottom"
          align="start"
          sideOffset={target && followTarget() ? ringPadding + 8 : 6}
          collisionPadding={12}
          anchor={target && followTarget() ? target : undefined}
          {...stylex.props(styles.positioner)}
        >
          <Popover.Popup
            aria-label={`How ${label} works`}
            finalFocus={() => finalFocus.current ?? true}
            onKeyDown={(event) => {
              if (tour.kind !== "step") return;
              if (event.key === "ArrowRight") go(tour.index + 1);
              else if (event.key === "ArrowLeft") go(tour.index - 1);
              else return;
              event.preventDefault();
            }}
            className={({ transitionStatus }) =>
              stylex.props(
                styles.popup,
                (transitionStatus === "starting" || transitionStatus === "ending") &&
                  styles.popupHidden,
              ).className
            }
          >
            {tour.kind === "overview" || !step ? (
              <>
                <p {...stylex.props(styles.overview)}>{help.overview}</p>
                {items.length > 0 && (
                  <ul {...stylex.props(styles.list)}>
                    {items.map((item, index) => (
                      <li key={item.anchor} {...stylex.props(styles.item)}>
                        <span {...stylex.props(styles.itemTitle)}>{item.title}</span>
                        <button
                          type="button"
                          ref={
                            tour.kind === "overview" && index === tour.from
                              ? overviewFocus
                              : undefined
                          }
                          aria-label={`Show me ${item.title}`}
                          onClick={() => go(index)}
                          {...stylex.props(styles.showMe)}
                        >
                          Show me
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <>
                <Popover.Close aria-label="Close help" {...stylex.props(styles.close)}>
                  <XIcon size={14} aria-hidden="true" />
                </Popover.Close>
                <div role="status" aria-live="polite" aria-atomic="true">
                  <p {...stylex.props(styles.stepTitle)}>{step.title}</p>
                  <p {...stylex.props(styles.stepBody)}>{step.body}</p>
                  <span
                    {...stylex.props(styles.srOnly)}
                  >{`Step ${tour.index + 1} of ${items.length}`}</span>
                </div>
                <div {...stylex.props(styles.footer)}>
                  <button
                    type="button"
                    onClick={() => setTour({ kind: "overview", from: tour.index })}
                    {...stylex.props(styles.link)}
                  >
                    All tips
                  </button>
                  <span aria-hidden="true" {...stylex.props(styles.count)}>
                    {tour.index + 1} of {items.length}
                  </span>
                  <button type="button" onClick={tryIt} {...stylex.props(styles.link)}>
                    Try it
                  </button>
                  {tour.index > 0 && (
                    <button
                      type="button"
                      aria-label="Back"
                      onClick={() => go(tour.index - 1)}
                      {...stylex.props(styles.nav)}
                    >
                      <ArrowLeftIcon size={13} aria-hidden="true" />
                    </button>
                  )}
                  {tour.index < items.length - 1 ? (
                    <button
                      ref={stepFocus}
                      type="button"
                      onClick={() => go(tour.index + 1)}
                      {...stylex.props(styles.nav, styles.primary)}
                    >
                      Next
                      <ArrowRightIcon size={13} aria-hidden="true" />
                    </button>
                  ) : (
                    <button
                      ref={stepFocus}
                      type="button"
                      onClick={() => setOpen(false)}
                      {...stylex.props(styles.nav, styles.primary)}
                    >
                      Done
                    </button>
                  )}
                </div>
              </>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
      {open && target && <Spotlight target={target} />}
    </Popover.Root>
  );
}

/** A ring around the control with the rest of the window dimmed; it never takes the pointer. */
function Spotlight({ target }: { target: HTMLElement }) {
  const ring = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
    let frame = 0;
    const place = () => {
      frame = 0;
      const el = ring.current;
      if (!el) return;
      const box = target.getBoundingClientRect();
      el.style.width = `${box.width + 2 * ringPadding}px`;
      el.style.height = `${box.height + 2 * ringPadding}px`;
      el.style.transform = `translate(${box.left - ringPadding}px, ${box.top - ringPadding}px)`;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };
    const el = ring.current;
    // Base UI measures the popover in this same commit, so the new ring already has a style and
    // would glide in from the corner. Only moves between steps should animate.
    if (el && !el.style.transform) {
      el.style.transition = "none";
      place();
      void el.offsetWidth;
      el.style.transition = "";
    } else {
      place();
    }
    const resize = new ResizeObserver(schedule);
    resize.observe(target);
    addEventListener("scroll", schedule, { capture: true, passive: true });
    addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      removeEventListener("scroll", schedule, { capture: true });
      removeEventListener("resize", schedule);
    };
  }, [target]);
  return createPortal(
    <div ref={ring} aria-hidden="true" {...stylex.props(styles.spotlight)} />,
    document.body,
  );
}
