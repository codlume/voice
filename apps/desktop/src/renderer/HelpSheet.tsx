import { Dialog } from "@base-ui/react/dialog";
import * as stylex from "@stylexjs/stylex";
import { CircleHelpIcon, XIcon } from "lucide-react";
import { createContext, use, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { TITLEBAR_HEIGHT } from "../shared/titlebar.ts";
import { Button } from "./Button.tsx";
import { transitionHidden } from "./ConfirmDialog.tsx";
import type { AppPage } from "./HubShell.tsx";
import { shotLayouts } from "./help/shots.ts";
import { pageStyles } from "./pageStyles.ts";
import { helpTopics } from "./help/topics.ts";
import type { HelpShot } from "./help/types.ts";
import { matches, shortcuts, useShortcuts, withShortcut } from "./shortcuts.ts";
import { titlebar } from "./titlebar.ts";
import { color, font, radius, space } from "./tokens.stylex.ts";

const reducedMotion = "@media (prefers-reduced-motion: reduce)";
const easing = "cubic-bezier(0.2, 0, 0, 1)";
const dark = "@media (prefers-color-scheme: dark)";
const edge = 8;

const styles = stylex.create({
  backdrop: {
    position: "fixed",
    inset: 0,
    backgroundColor: { default: "rgb(0 0 0 / 8%)", [dark]: "rgb(0 0 0 / 30%)" },
    transitionProperty: "opacity",
    transitionDuration: { default: "var(--page-animation)", [reducedMotion]: "0s" },
  },
  backdropHidden: { opacity: 0 },
  sheet: {
    position: "fixed",
    right: edge,
    bottom: edge,
    width: "min(400px, calc(100vw - 32px))",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    backgroundColor: color.card,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.large,
    boxShadow: "0 12px 32px -8px rgb(0 0 0 / 25%)",
    color: color.foreground,
    fontFamily: font.sans,
    fontSize: 14,
    lineHeight: 1.5,
    WebkitFontSmoothing: "antialiased",
    outline: "none",
    transform: "translateX(0)",
    // Transform and opacity only, so the slide runs on the compositor.
    transitionProperty: { default: "transform, opacity", [reducedMotion]: "opacity" },
    transitionDuration: "var(--page-animation)",
    transitionTimingFunction: easing,
  },
  sheetHidden: {
    transform: { default: `translateX(calc(100% + ${edge}px))`, [reducedMotion]: "none" },
    opacity: { default: 1, [reducedMotion]: 0 },
  },
  header: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.sm,
    paddingTop: space.lg,
    paddingInline: space.lg,
    paddingBottom: space.md,
  },
  heading: { flexGrow: 1, minWidth: 0 },
  eyebrow: { margin: 0, fontSize: 12, color: color.mutedForeground },
  title: { margin: 0, fontFamily: font.serif, fontSize: 24, fontWeight: 400, lineHeight: 1.2 },
  summary: { marginTop: space.sm, marginBottom: 0, color: color.mutedForeground },
  scroller: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
    paddingInline: space.lg,
    paddingBottom: space.lg,
    outline: "none",
  },
  section: { paddingTop: space.md },
  sectionHeading: { margin: 0, fontSize: 14, fontWeight: 600 },
  body: { marginTop: 4, marginBottom: 0 },
  figure: { marginTop: space.md, marginBottom: 0, marginInline: 0 },
  frame: {
    position: "relative",
    overflow: "hidden",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.medium,
  },
  image: { display: "block", width: "100%", height: "auto" },
  marker: (x: number, y: number) => ({ left: `${x * 100}%`, top: `${y * 100}%` }),
  pin: {
    position: "absolute",
    display: "grid",
    placeItems: "center",
    width: 20,
    height: 20,
    marginLeft: -10,
    marginTop: -10,
    borderRadius: radius.round,
    backgroundColor: color.primary,
    color: color.primaryForeground,
    fontSize: 11,
    fontWeight: 600,
    boxShadow: "0 0 0 2px white",
  },
  legend: {
    display: "grid",
    gap: 4,
    marginTop: space.sm,
    marginBottom: 0,
    paddingLeft: 0,
    listStyle: "none",
    fontSize: 13,
    color: color.mutedForeground,
  },
  legendItem: { display: "flex", alignItems: "center", gap: space.sm },
  legendPin: { position: "static", margin: 0, boxShadow: "none", flexShrink: 0 },
});

function Shot({ shot }: { shot: HelpShot }) {
  const layout = shotLayouts[shot.file];
  if (!layout) return null;
  return (
    <figure {...stylex.props(styles.figure)}>
      <div {...stylex.props(styles.frame)}>
        <img
          src={new URL(`./help/shots/${shot.file}.png`, import.meta.url).href}
          alt={shot.alt}
          width={layout.width}
          height={layout.height}
          decoding="async"
          {...stylex.props(styles.image)}
        />
        {layout.callouts.map(({ x, y }, index) => (
          <span
            key={shot.callouts[index]?.label}
            aria-hidden="true"
            {...stylex.props(styles.pin, styles.marker(x, y))}
          >
            {index + 1}
          </span>
        ))}
      </div>
      <ol {...stylex.props(styles.legend)}>
        {shot.callouts.map(({ label }, index) => (
          <li key={label} {...stylex.props(styles.legendItem)}>
            <span aria-hidden="true" {...stylex.props(styles.pin, styles.legendPin)}>
              {index + 1}
            </span>
            {label}
          </li>
        ))}
      </ol>
    </figure>
  );
}

/** The Page animations setting, which HubShell provides. */
export const PageAnimationMs = createContext(200);

/** The page's help button and the sheet it opens. ⌘/ toggles it from anywhere on the page. */
export function HelpButton({ page }: { page: AppPage }) {
  const [open, setOpen] = useState(false);
  // The portal leaves the shell, which sets the Page animations duration, so the sheet sets it again.
  const animationMs = use(PageAnimationMs);
  const returnFocus = useRef<HTMLElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const topic = helpTopics[page];
  const label = `${topic.title} help`;

  function show(startedAt: number) {
    performance.clearMarks("help:open");
    performance.mark("help:open", { startTime: startedAt });
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  }

  // Inline, not StyleX: Base UI's className callback drops the style half of a dynamic StyleX
  // style. StyleX also reads imported constants such as TITLEBAR_HEIGHT only from .stylex files.
  const animation = { "--page-animation": `${animationMs}ms` } as CSSProperties;

  useShortcuts([{ shortcut: shortcuts.openHelp, run: () => show(performance.now()) }]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => {
        if (isOpen) {
          performance.clearMarks("help:shown");
          performance.mark("help:shown");
        } else {
          returnFocus.current?.focus({ preventScroll: true });
        }
      }}
    >
      <Button
        variant="icon"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={withShortcut(label, shortcuts.openHelp)}
        onClick={(event) => show(event.timeStamp)}
      >
        <CircleHelpIcon size={17} />
      </Button>
      <Dialog.Portal>
        <Dialog.Backdrop
          style={animation}
          className={({ transitionStatus }) =>
            stylex.props(
              styles.backdrop,
              transitionHidden(transitionStatus) && styles.backdropHidden,
            ).className
          }
        />
        <Dialog.Popup
          initialFocus={scrollerRef}
          // Base UI swaps a non-tabbable return target, such as main, for its first tabbable
          // child, so onOpenChangeComplete returns focus itself.
          finalFocus={false}
          style={{ ...animation, top: TITLEBAR_HEIGHT }}
          onKeyDown={(event) => {
            if (matches(shortcuts.openHelp, event.nativeEvent)) {
              event.preventDefault();
              setOpen(false);
            }
          }}
          className={({ transitionStatus }) =>
            stylex.props(styles.sheet, transitionHidden(transitionStatus) && styles.sheetHidden)
              .className
          }
        >
          <div {...stylex.props(styles.header)}>
            <div {...stylex.props(styles.heading)}>
              <p {...stylex.props(styles.eyebrow)}>Help</p>
              <Dialog.Title {...stylex.props(styles.title)}>{topic.title}</Dialog.Title>
              <Dialog.Description {...stylex.props(styles.summary)}>
                {topic.summary}
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Close help"
              title="Close help"
              {...stylex.props(titlebar.button)}
            >
              <XIcon size={18} />
            </Dialog.Close>
          </div>
          <div ref={scrollerRef} tabIndex={-1} {...stylex.props(styles.scroller)}>
            {topic.sections.map((section) => (
              <section key={section.heading} {...stylex.props(styles.section)}>
                <h3 {...stylex.props(styles.sectionHeading)}>{section.heading}</h3>
                <p {...stylex.props(styles.body)}>{section.body}</p>
                {section.shot && <Shot shot={section.shot} />}
              </section>
            ))}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const titleStyles = stylex.create({
  row: { display: "flex", alignItems: "center", gap: space.sm },
  grow: { flexGrow: 1 },
});

/** A page's headline with its help button at the end of the row. */
export function PageTitle({ page, children }: { page: AppPage; children: ReactNode }) {
  return (
    <div {...stylex.props(titleStyles.row)}>
      <h1 {...stylex.props(pageStyles.headline, titleStyles.grow)}>{children}</h1>
      <HelpButton page={page} />
    </div>
  );
}
