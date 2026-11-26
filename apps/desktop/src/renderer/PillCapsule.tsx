import * as stylex from "@stylexjs/stylex";
import { CheckIcon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type AnimationEvent,
} from "react";

import type { PillSnapshot } from "../shared/api.ts";
import { a11y } from "./a11y.ts";
import {
  BAR_COUNT,
  MIN_BAR_SCALE,
  barScales,
  flowBarView,
  smoothLevel,
  ticks,
  type MeetingLook,
  type PillView,
} from "./pillView.ts";
import { font, darkPill, motion, radius } from "./tokens.stylex.ts";
import { useNow } from "./useNow.ts";
import { pillApi } from "./voice.ts";

/** One key per look. Text changes inside a look, such as the meeting clock, keep the key. */
type LookKey = Exclude<PillView["kind"], "meeting"> | MeetingLook;

const lookKey = (view: PillView): LookKey => (view.kind === "meeting" ? view.look : view.kind);

const OPEN_HEIGHT = 32;
const lookSize: Record<LookKey, { width: number; height: number }> = {
  idle: { width: 36, height: 8 },
  listening: { width: 112, height: OPEN_HEIGHT },
  // Fits "Transforming" at the pill font with room on both sides.
  processing: { width: 124, height: OPEN_HEIGHT },
  inserted: { width: 112, height: OPEN_HEIGHT },
  message: { width: 296, height: OPEN_HEIGHT },
  allow: { width: 296, height: OPEN_HEIGHT },
  recording: { width: 112, height: OPEN_HEIGHT },
  recordingPrompt: { width: 200, height: OPEN_HEIGHT },
  paused: { width: 200, height: OPEN_HEIGHT },
  waiting: { width: 200, height: OPEN_HEIGHT },
  prompt: { width: 200, height: OPEN_HEIGHT },
};

/** Idle draws nothing, and the check fades itself out, so neither needs to fade as it leaves. */
const fadesOut = (key: LookKey) => key !== "idle" && key !== "inserted";

const fadeIn = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });
const fadeOut = stylex.keyframes({ from: { opacity: 1 }, to: { opacity: 0 } });
// A bright copy of the label, seen through a band that sweeps across it in 30 steps. The band moves
// one way and the copy the other, so the text stays put and only transforms animate: the
// compositor moves them without repainting the text.
const sweep = stylex.keyframes({
  from: { transform: "translateX(0)" },
  to: { transform: "translateX(100%)" },
});
const sweepBack = stylex.keyframes({
  from: { transform: "translateX(0)" },
  to: { transform: "translateX(-100%)" },
});
const SHINE = "4.5rem";
const draw = stylex.keyframes({ from: { strokeDashoffset: 23 }, to: { strokeDashoffset: 0 } });

const styles = stylex.create({
  frame: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
    height: "100%",
    paddingBottom: 20,
  },
  capsule: {
    position: "relative",
    overflow: "hidden",
    borderRadius: radius.round,
    backgroundColor: darkPill.surface,
    transitionProperty: "width, height, opacity, box-shadow",
    transitionDuration: { default: motion.slow, [motion.reduced]: "0s" },
    transitionTimingFunction: motion.drawer,
  },
  size: (width: number, height: number) => ({ width, height }),
  // The hairline alone, so the resting handle still reads over a dark app.
  idle: { opacity: 0.55, boxShadow: `inset 0 0 0 1px ${darkPill.line}` },
  open: {
    opacity: 1,
    boxShadow: `inset 0 0 0 1px ${darkPill.line}, ${darkPill.elevation}`,
  },
  hidden: { opacity: 0 },
  status: { display: "flex", width: "100%", height: "100%" },
  enter: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    height: "100%",
    minWidth: 0,
    animationName: fadeIn,
    animationDuration: motion.base,
    animationDelay: "50ms",
    animationFillMode: "both",
  },
  // The leaving look keeps its own size, centred, so its text does not reflow as the capsule
  // changes width.
  leave: {
    position: "absolute",
    top: "50%",
    left: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transform: "translate(-50%, -50%)",
    animationName: fadeOut,
    animationDuration: motion.fast,
    animationFillMode: "forwards",
  },
  button: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    width: "100%",
    height: "100%",
    minWidth: 0,
    paddingBlock: 0,
    paddingInline: 14,
    borderWidth: 0,
    borderRadius: radius.round,
    backgroundColor: { default: "transparent", ":hover": darkPill.hover },
    cursor: "pointer",
  },
  ellipsis: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
  light: { flexShrink: 0, width: 7, height: 7, borderRadius: radius.round },
  recordingLight: { backgroundColor: darkPill.recording },
  promptLight: { backgroundColor: darkPill.attention },
  pauseGlyph: { flexShrink: 0, display: "flex", gap: 2 },
  pauseBar: { width: 2.5, height: 9, borderRadius: 1, backgroundColor: darkPill.glyph },
  row: { display: "flex", alignItems: "center" },
  wave: { gap: 2.5, height: 16 },
  bar: {
    width: 3,
    height: 16,
    borderRadius: 1.5,
    backgroundColor: darkPill.glyph,
    transitionProperty: "transform",
    transitionDuration: "120ms",
    transitionTimingFunction: "ease-out",
  },
  barScale: (scale: number) => ({ transform: `scaleY(${scale})` }),
  shimmer: {
    position: "relative",
    display: "inline-block",
    color: { default: darkPill.muted, [motion.reduced]: darkPill.text },
  },
  shine: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: `-${SHINE}`,
    display: { default: "block", [motion.reduced]: "none" },
    width: `calc(100% + 2 * ${SHINE})`,
    maskImage: `linear-gradient(to right, transparent 0, black calc(${SHINE} / 2), transparent ${SHINE}, transparent 100%)`,
    maskRepeat: "no-repeat",
    animationName: sweep,
  },
  shineCounter: { display: "block", width: "100%", animationName: sweepBack },
  shineText: {
    display: "block",
    width: `calc(100% - 2 * ${SHINE})`,
    marginInlineStart: SHINE,
    color: darkPill.glyph,
    "::after": { content: "attr(data-text)" },
  },
  looping: {
    animationDuration: "2.2s",
    animationTimingFunction: "steps(30)",
    animationIterationCount: "infinite",
  },
  paused: { animationPlayState: "paused" },
  check: {
    gap: 6,
    animationName: fadeOut,
    animationDuration: "260ms",
    animationDelay: "950ms",
    animationFillMode: "forwards",
  },
  checkStroke: {
    stroke: darkPill.glyph,
    strokeDasharray: 23,
    animationName: { default: draw, [motion.reduced]: "none" },
    animationDuration: "280ms",
    animationDelay: "60ms",
    animationTimingFunction: motion.drawer,
    animationFillMode: "both",
  },
  text: {
    color: darkPill.text,
    fontFamily: font.sans,
    fontSize: 12.5,
    fontWeight: 500,
    fontVariantNumeric: "tabular-nums",
    letterSpacing: "0.01em",
    whiteSpace: "nowrap",
  },
  message: {
    display: "block",
    maxWidth: "100%",
    paddingInline: 14,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
});

const resting = Array.from({ length: BAR_COUNT }, () => MIN_BAR_SCALE);
const barKeys = Array.from({ length: BAR_COUNT }, (_, i) => `bar-${i}`);

function Wave() {
  const [scales, setScales] = useState(resting);
  useEffect(() => {
    let level = 0;
    let tick = 0;
    return pillApi().onLevel((next) => {
      level = smoothLevel(level, next);
      tick += 1;
      setScales(barScales(level, tick));
    });
  }, []);
  return (
    <div {...stylex.props(styles.row, styles.wave)}>
      <span {...stylex.props(a11y.visuallyHidden)}>Listening</span>
      {scales.map((scale, i) => (
        <div key={barKeys[i]} {...stylex.props(styles.bar, styles.barScale(scale))} />
      ))}
    </div>
  );
}

const onVisibility = (change: () => void) => {
  document.addEventListener("visibilitychange", change);
  return () => document.removeEventListener("visibilitychange", change);
};
const pageVisible = () => document.visibilityState === "visible";

function Shimmer({ text }: { text: string }) {
  const paused = !useSyncExternalStore(onVisibility, pageVisible) && styles.paused;
  return (
    <span {...stylex.props(styles.text, styles.shimmer)}>
      {text}
      <span aria-hidden="true" {...stylex.props(styles.shine, styles.looping, paused)}>
        <span {...stylex.props(styles.shineCounter, styles.looping, paused)}>
          {/* Drawn from the attribute, so the label is read and counted once. */}
          <span data-text={text} {...stylex.props(styles.shineText)} />
        </span>
      </span>
    </span>
  );
}

function Check({ pasted }: { pasted: boolean }) {
  return (
    <div {...stylex.props(styles.row, styles.check)}>
      <CheckIcon
        size={16}
        strokeWidth={3}
        role="img"
        aria-label={pasted ? "Pasted" : "Inserted"}
        {...stylex.props(styles.checkStroke)}
      />
      {pasted && <span {...stylex.props(styles.text)}>Pasted</span>}
    </div>
  );
}

function MeetingGlyph({ look }: { look: MeetingLook }) {
  if (look === "paused") {
    return (
      <span aria-hidden="true" {...stylex.props(styles.pauseGlyph)}>
        <span {...stylex.props(styles.pauseBar)} />
        <span {...stylex.props(styles.pauseBar)} />
      </span>
    );
  }
  if (look === "waiting") return null;
  return (
    <span
      aria-hidden="true"
      {...stylex.props(
        styles.light,
        look === "prompt" ? styles.promptLight : styles.recordingLight,
      )}
    />
  );
}

function MeetingButton({ look, text }: { look: MeetingLook; text: string }) {
  return (
    <button
      type="button"
      aria-label={`${text}. Open the meeting notepad`}
      onPointerEnter={() => void pillApi().setPillClickable(true)}
      onPointerLeave={() => void pillApi().setPillClickable(false)}
      onClick={() => void pillApi().openNotepad()}
      {...stylex.props(styles.text, styles.button)}
    >
      <MeetingGlyph look={look} />
      <span {...stylex.props(styles.ellipsis)}>{text}</span>
    </button>
  );
}

function AllowButton({ permission, text }: Extract<PillView, { kind: "allow" }>) {
  return (
    <button
      type="button"
      onPointerEnter={() => void pillApi().setPillClickable(true)}
      onPointerLeave={() => void pillApi().setPillClickable(false)}
      onClick={() => void pillApi().allowPermission(permission)}
      {...stylex.props(styles.text, styles.button)}
    >
      <span {...stylex.props(styles.ellipsis)}>{text}</span>
    </button>
  );
}

function Content({ view }: { view: PillView }) {
  switch (view.kind) {
    case "idle":
      return null;
    case "listening":
      return <Wave />;
    case "processing":
      return <Shimmer text={view.text} />;
    case "inserted":
      return <Check pasted={view.method === "paste"} />;
    case "message":
      return <div {...stylex.props(styles.text, styles.message)}>{view.text}</div>;
    case "meeting":
      return <MeetingButton look={view.look} text={view.text} />;
    case "allow":
      return <AllowButton {...view} />;
  }
}

type Shown = { key: LookKey; view: PillView };

/**
 * The look that just left, kept until its fade-out ends. `flowBarView` builds a new view on every
 * render, so looks are compared by key.
 */
function useLeaving(view: PillView) {
  const key = lookKey(view);
  const shown = useRef<Shown>({ key, view });
  const [leaving, setLeaving] = useState<Shown | null>(null);
  // Runs before the ref below catches up, so `shown` still holds the old look's last frame.
  useLayoutEffect(() => {
    const previous = shown.current;
    if (previous.key !== key) setLeaving(fadesOut(previous.key) ? previous : null);
  }, [key]);
  useLayoutEffect(() => {
    shown.current = { key, view };
  });
  const onLeft = (event: AnimationEvent) => {
    if (event.target === event.currentTarget) setLeaving(null);
  };
  return { leaving, onLeft };
}

export function PillCapsule(snapshot: PillSnapshot) {
  const now = useNow(ticks(snapshot));
  const view = flowBarView(snapshot, now);
  const key = lookKey(view);
  const size = lookSize[key];
  const { leaving, onLeft } = useLeaving(view);
  return (
    <div {...stylex.props(styles.frame)}>
      <div
        {...stylex.props(
          styles.capsule,
          styles.size(size.width, size.height),
          view.kind === "idle"
            ? [styles.idle, !snapshot.alwaysShowPill && styles.hidden]
            : styles.open,
        )}
      >
        {leaving && (
          <div
            key={leaving.key}
            aria-hidden="true"
            inert
            onAnimationEnd={onLeft}
            {...stylex.props(
              styles.leave,
              styles.size(lookSize[leaving.key].width, lookSize[leaving.key].height),
            )}
          >
            <Content view={leaving.view} />
          </div>
        )}
        <div
          role="status"
          data-view={view.kind}
          data-look={view.kind === "meeting" ? view.look : undefined}
          {...stylex.props(styles.status)}
        >
          {view.kind !== "idle" && (
            <div key={key} {...stylex.props(styles.enter)}>
              <Content view={view} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
