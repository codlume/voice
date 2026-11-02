import * as stylex from "@stylexjs/stylex";
import { XIcon } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

import { findAnchor, viewHelp, type HelpAnchor } from "./help.ts";
import type { AppPage } from "./HubShell.tsx";
import { color, font, radius, space } from "./tokens.stylex.ts";
import { titlebar } from "./titlebar.ts";

const reducedMotion = "@media (prefers-reduced-motion: reduce)";
const easing = "cubic-bezier(0.2, 0, 0, 1)";
const RING_GAP = 4;

const slideIn = stylex.keyframes({ from: { opacity: 0, transform: "translateX(12px)" } });

const styles = stylex.create({
  panel: {
    // Above the spotlight's dimming, which is drawn on a fixed layer below it.
    position: "relative",
    zIndex: 3,
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    minWidth: 0,
    overflowY: "auto",
    marginRight: 8,
    marginBottom: 8,
    padding: space.lg,
    backgroundColor: color.background,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.large,
    animationName: { default: slideIn, [reducedMotion]: "none" },
    animationDuration: "var(--page-animation)",
    animationTimingFunction: easing,
  },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  title: {
    margin: 0,
    fontFamily: font.serif,
    fontSize: 20,
    fontWeight: 500,
    outline: "none",
  },
  intro: { margin: 0, color: color.mutedForeground, fontSize: 13.5 },
  items: { display: "flex", flexDirection: "column", gap: 2, margin: 0, padding: 0 },
  itemRow: { listStyle: "none" },
  item: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    width: "100%",
    paddingBlock: space.sm,
    paddingInline: space.md,
    borderWidth: 0,
    borderRadius: radius.medium,
    backgroundColor: {
      default: "transparent",
      ":hover": color.accent,
      ":focus-visible": color.accent,
    },
    color: color.foreground,
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
  },
  itemActive: { backgroundColor: color.accent },
  itemTitle: { fontWeight: 500 },
  itemBody: { color: color.mutedForeground, fontSize: 13 },
  itemMissing: { color: color.mutedForeground, fontSize: 12, fontStyle: "italic" },
  footer: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    marginTop: "auto",
    color: color.mutedForeground,
    fontSize: 12,
  },
  live: {
    position: "absolute",
    width: 1,
    height: 1,
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
  ring: {
    position: "fixed",
    top: 0,
    left: 0,
    zIndex: 2,
    pointerEvents: "none",
    boxShadow: `0 0 0 2px ${color["--ring"]}, 0 0 0 6px color-mix(in oklch, ${color["--ring"]} 22%, transparent)`,
    opacity: 0,
    transitionProperty: "opacity, transform",
    transitionDuration: { default: "140ms", [reducedMotion]: "0s" },
    transitionTimingFunction: easing,
    willChange: "transform",
  },
  spotlight: {
    boxShadow: `0 0 0 2px ${color["--ring"]}, 0 0 0 100vmax rgb(0 0 0 / 55%)`,
  },
});

type Look = "outline" | "spotlight";
const lookKey = "voice.helpHighlight";

const prefersReducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Draws one ring over the anchored control on a fixed layer, so the control's own layout and
 * styles never change. It follows scrolling and resizing only while something is highlighted.
 */
function useHighlight(
  ring: RefObject<HTMLDivElement | null>,
  anchor: HelpAnchor | null,
  onMissing: (missing: boolean) => void,
) {
  useLayoutEffect(() => {
    const element = ring.current;
    if (!element) return;
    const found = anchor && findAnchor(anchor);
    // A control can stay in the DOM while the layout hides it, as the narrow Meetings overview does.
    const target = found && found.getClientRects().length > 0 ? found : null;
    onMissing(anchor !== null && !target);
    if (!target) {
      element.style.opacity = "0";
      return;
    }
    const scroller = target.closest("main");
    const radius = parseFloat(getComputedStyle(target).borderTopLeftRadius) || 0;
    element.style.borderRadius = `${radius + RING_GAP}px`;
    let frame = 0;
    const place = (animate: boolean) => {
      const box = target.getBoundingClientRect();
      const clip = scroller?.getBoundingClientRect();
      const top = Math.max(box.top, clip?.top ?? -Infinity);
      const bottom = Math.min(box.bottom, clip?.bottom ?? Infinity);
      element.style.transitionDuration = animate ? "" : "0s, 0s";
      element.style.opacity = bottom > top ? "1" : "0";
      element.style.transform = `translate(${box.left - RING_GAP}px, ${top - RING_GAP}px)`;
      element.style.width = `${box.width + 2 * RING_GAP}px`;
      element.style.height = `${Math.max(0, bottom - top) + 2 * RING_GAP}px`;
    };
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => place(false));
    };
    // From hidden, appear in place instead of gliding from the last control.
    place(element.style.opacity === "1");
    target.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: prefersReducedMotion() ? "instant" : "smooth",
    });
    const resize = new ResizeObserver(follow);
    resize.observe(target);
    addEventListener("scroll", follow, { capture: true, passive: true });
    addEventListener("resize", follow);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      removeEventListener("scroll", follow, { capture: true });
      removeEventListener("resize", follow);
    };
    // onMissing is a state setter.
    // eslint-disable-next-line react/exhaustive-effect-dependencies
  }, [ring, anchor]);
}

const focusable = "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

function goTo(anchor: HelpAnchor) {
  const target = findAnchor(anchor);
  const control = target?.matches(focusable)
    ? target
    : target?.querySelector<HTMLElement>(focusable);
  control?.focus();
}

export function HelpPanel({
  id,
  page,
  label,
  headingRef,
  onClose,
}: {
  id: string;
  page: AppPage;
  label: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onClose: () => void;
}) {
  const help = viewHelp[page];
  const headingId = useId();
  const [hovered, setHovered] = useState<HelpAnchor | null>(null);
  const [focused, setFocused] = useState<HelpAnchor | null>(null);
  const [missing, setMissing] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [look, setLook] = useState<Look>(() =>
    localStorage.getItem(lookKey) === "spotlight" ? "spotlight" : "outline",
  );
  const active = hovered ?? focused;
  const ring = useRef<HTMLDivElement>(null);
  useHighlight(ring, active, setMissing);

  // A new page has its own items, so nothing it lists can still be highlighted.
  const [shownPage, setShownPage] = useState(page);
  if (shownPage !== page) {
    setShownPage(page);
    setHovered(null);
    setFocused(null);
  }

  useEffect(() => {
    if (!focused) return;
    const shown = (findAnchor(focused)?.getClientRects().length ?? 0) > 0;
    setAnnouncement(shown ? "Highlighted in the page." : "Not on the page right now.");
  }, [focused]);

  return (
    <aside
      id={id}
      aria-labelledby={headingId}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose();
      }}
      {...stylex.props(styles.panel)}
    >
      <div {...stylex.props(styles.header)}>
        <h2 id={headingId} ref={headingRef} tabIndex={-1} {...stylex.props(styles.title)}>
          {label} help
        </h2>
        <button
          type="button"
          aria-label="Close help"
          title="Close help (Esc)"
          onClick={onClose}
          {...stylex.props(titlebar.button)}
        >
          <XIcon size={16} />
        </button>
      </div>
      <p {...stylex.props(styles.intro)}>
        {help ? help.intro : `Help for ${label} is not written yet.`}
      </p>
      {help && (
        <ul {...stylex.props(styles.items)} onPointerLeave={() => setHovered(null)}>
          {help.items.map((item) => (
            <HelpRow
              key={item.anchor}
              item={item}
              active={active === item.anchor}
              missing={active === item.anchor && missing}
              onHover={() => setHovered(item.anchor)}
              onFocus={() => setFocused(item.anchor)}
              onBlur={() => setFocused(null)}
            />
          ))}
        </ul>
      )}
      <div {...stylex.props(styles.footer)}>
        <label>
          Highlight{" "}
          <select
            value={look}
            onChange={(event) => {
              const next = event.target.value === "spotlight" ? "spotlight" : "outline";
              setLook(next);
              localStorage.setItem(lookKey, next);
            }}
          >
            <option value="outline">Outline</option>
            <option value="spotlight">Spotlight</option>
          </select>
        </label>
      </div>
      <div aria-live="polite" {...stylex.props(styles.live)}>
        {announcement}
      </div>
      {createPortal(
        <div
          ref={ring}
          aria-hidden="true"
          data-help-ring
          {...stylex.props(styles.ring, look === "spotlight" && styles.spotlight)}
        />,
        document.body,
      )}
    </aside>
  );
}

function HelpRow({
  item,
  active,
  missing,
  onHover,
  onFocus,
  onBlur,
}: {
  item: { anchor: HelpAnchor; title: string; body: string };
  active: boolean;
  missing: boolean;
  onHover: () => void;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const bodyId = useId();
  return (
    <li {...stylex.props(styles.itemRow)}>
      <button
        type="button"
        aria-describedby={bodyId}
        data-help-item={item.anchor}
        onPointerEnter={onHover}
        onFocus={onFocus}
        onBlur={onBlur}
        onClick={() => goTo(item.anchor)}
        {...stylex.props(styles.item, active && styles.itemActive)}
      >
        <span {...stylex.props(styles.itemTitle)}>{item.title}</span>
        <span id={bodyId} {...stylex.props(styles.itemBody)}>
          {item.body}
        </span>
        {missing && <span {...stylex.props(styles.itemMissing)}>Not on the page right now.</span>}
      </button>
    </li>
  );
}
