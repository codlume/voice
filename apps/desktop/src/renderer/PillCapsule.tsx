import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";

import type { PillState } from "../shared/api.ts";
import { BAR_COUNT, MIN_BAR_SCALE, barScales, pillView, smoothLevel } from "./pillView.ts";
import { color, font, radius } from "./tokens.stylex.ts";

const spring = "cubic-bezier(0.34, 1.36, 0.64, 1)";
const settle = "cubic-bezier(0.32, 0.72, 0, 1)";

const fadeIn = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });
const fadeOut = stylex.keyframes({ from: { opacity: 1 }, to: { opacity: 0 } });
const pulse = stylex.keyframes({
  "0%, 100%": { opacity: 0.35, transform: "scale(0.8)" },
  "50%": { opacity: 1, transform: "scale(1)" },
});
const draw = stylex.keyframes({ from: { strokeDashoffset: 18 }, to: { strokeDashoffset: 0 } });

const styles = stylex.create({
  frame: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
    height: "100%",
    paddingBottom: 8,
  },
  capsule: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderRadius: radius.round,
    backgroundColor: color.pill,
    transitionProperty: "width, height, opacity, box-shadow",
    transitionDuration: "420ms",
    transitionTimingFunction: spring,
  },
  idle: {
    width: 36,
    height: 8,
    opacity: 0.55,
    boxShadow: "none",
    transitionDuration: "360ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
  },
  open: {
    width: 112,
    height: 32,
    opacity: 1,
    boxShadow: `inset 0 0 0 1px ${color.pillLine}, 0 2px 8px rgba(0, 0, 0, 0.28)`,
  },
  wide: { width: 296 },
  content: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    animationName: fadeIn,
    animationDuration: "180ms",
    animationDelay: "90ms",
    animationFillMode: "both",
  },
  wave: { gap: 2.5, height: 16 },
  bar: {
    width: 3,
    height: 16,
    borderRadius: 1.5,
    backgroundColor: "white",
    transitionProperty: "transform",
    transitionDuration: "120ms",
    transitionTimingFunction: "ease-out",
  },
  barScale: (scale: number) => ({ transform: `scaleY(${scale})` }),
  dots: { gap: 5 },
  dot: {
    width: 5,
    height: 5,
    borderRadius: radius.round,
    backgroundColor: "white",
    animationName: pulse,
    animationDuration: "1.1s",
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
  },
  dotDelay: (delay: number) => ({ animationDelay: `${delay}ms` }),
  // Purely visual: main still owns when the session returns to idle.
  checkFade: {
    animationName: `${fadeIn}, ${fadeOut}`,
    animationDuration: "180ms, 260ms",
    animationDelay: "0ms, 950ms",
    animationFillMode: "both, forwards",
  },
  checkStroke: {
    strokeDasharray: 18,
    animationName: draw,
    animationDuration: "280ms",
    animationDelay: "60ms",
    animationTimingFunction: settle,
    animationFillMode: "both",
  },
  message: {
    display: "block",
    maxWidth: "100%",
    paddingInline: 14,
    color: "rgba(255, 255, 255, 0.92)",
    fontFamily: font.sans,
    fontSize: 12.5,
    fontWeight: 500,
    letterSpacing: "0.01em",
    whiteSpace: "nowrap",
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
    return window.voice.onLevel((next) => {
      level = smoothLevel(level, next);
      tick += 1;
      setScales(barScales(level, tick));
    });
  }, []);
  return (
    <div {...stylex.props(styles.content, styles.wave)}>
      {scales.map((scale, i) => (
        <div key={barKeys[i]} {...stylex.props(styles.bar, styles.barScale(scale))} />
      ))}
    </div>
  );
}

function Dots() {
  return (
    <div {...stylex.props(styles.content, styles.dots)}>
      {[0, 150, 300].map((delay) => (
        <div key={delay} {...stylex.props(styles.dot, styles.dotDelay(delay))} />
      ))}
    </div>
  );
}

function Check() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-label="Inserted"
      {...stylex.props(styles.checkFade)}
    >
      <path
        d="M3.5 8.5l3 3 6-7"
        fill="none"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        {...stylex.props(styles.checkStroke)}
      />
    </svg>
  );
}

export function PillCapsule({ session }: { session: PillState }) {
  const view = pillView(session);
  return (
    <div {...stylex.props(styles.frame)}>
      <div
        data-view={view.kind}
        role="status"
        {...stylex.props(
          styles.capsule,
          view.kind === "idle" ? styles.idle : styles.open,
          view.kind === "message" && styles.wide,
        )}
      >
        {view.kind === "listening" && <Wave />}
        {view.kind === "processing" && <Dots />}
        {view.kind === "inserted" && <Check />}
        {view.kind === "message" && (
          <div {...stylex.props(styles.content, styles.message)}>{view.text}</div>
        )}
      </div>
    </div>
  );
}
