import * as stylex from "@stylexjs/stylex";
import { useEffect, useState, type ReactNode } from "react";

import type { MicrophoneTest, PermissionState } from "../shared/api.ts";
import {
  HEARD_LEVEL,
  QUIET_AFTER_MS,
  microphoneTestAction,
  microphoneTestStatus,
  type MicrophoneTestAction,
} from "./microphoneTestView.ts";
import { smoothLevel } from "./pillView.ts";
import { color, radius, space } from "./tokens.stylex.ts";

const reduceMotion = "@media (prefers-reduced-motion: reduce)";

const styles = stylex.create({
  row: { paddingBlock: 14, paddingInline: space.lg },
  line: { display: "flex", alignItems: "center", gap: space.lg },
  text: { flexGrow: 1, minWidth: 0 },
  title: { display: "block", fontWeight: 500 },
  detail: { margin: 0, color: color.mutedForeground, fontSize: 12.5 },
  error: { color: color.errorForeground },
  controls: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    flexShrink: 0,
    maxWidth: "48%",
  },
  button: {
    display: "inline-flex",
    alignItems: "center",
    flexShrink: 0,
    gap: 6,
    paddingBlock: 6,
    paddingInline: 10,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.medium,
    backgroundColor: { default: color.card, ":hover:not(:disabled)": color.accent },
    color: color.foreground,
    font: "inherit",
    fontSize: 13,
    lineHeight: 1.45,
    cursor: { default: "pointer", ":disabled": "default" },
    opacity: { default: 1, ":disabled": 0.45 },
  },
  glyph: { display: "block", flexShrink: 0, color: color.mutedForeground },
  glyphLive: { color: color.primary },
  expander: {
    display: "grid",
    gridTemplateRows: "0fr",
    transitionProperty: "grid-template-rows",
    transitionDuration: { default: "160ms", [reduceMotion]: "0s" },
    transitionTimingFunction: "ease-out",
  },
  open: { gridTemplateRows: "1fr" },
  clip: { minHeight: 0, overflow: "hidden" },
  body: { display: "flex", flexDirection: "column", gap: 6, paddingTop: 4 },
  track: {
    maxWidth: 360,
    height: 6,
    marginTop: 6,
    overflow: "hidden",
    borderRadius: radius.round,
    backgroundColor: color.input,
  },
  fill: {
    height: "100%",
    borderRadius: radius.round,
    backgroundColor: color.primary,
    transitionProperty: "width",
    transitionDuration: { default: "90ms", [reduceMotion]: "0s" },
    transitionTimingFunction: "linear",
  },
});

const accessibleLabels: Record<MicrophoneTestAction["kind"], string> = {
  start: "Test microphone",
  requestAccess: "Test microphone",
  stop: "Stop microphone test",
};

// Null while no test is listening. Each episode is one audio source, so a restart (microphone
// change, device reset) re-runs the effect and forgets what the previous source was heard.
function useLevel(episode: number | null) {
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState(false);
  const [quiet, setQuiet] = useState(false);

  // Only a listening test subscribes, so an idle Settings page runs no timers and repaints nothing.
  useEffect(() => {
    if (episode === null) return;
    let smoothed = 0;
    const quietTimer = setTimeout(() => setQuiet(true), QUIET_AFTER_MS);
    const unsubscribe = window.voice.onLevel((next) => {
      smoothed = smoothLevel(smoothed, next);
      setLevel(smoothed);
      if (next > HEARD_LEVEL) {
        clearTimeout(quietTimer);
        setHeard(true);
      }
    });
    return () => {
      clearTimeout(quietTimer);
      unsubscribe();
      setLevel(0);
      setHeard(false);
      setQuiet(false);
    };
  }, [episode]);

  return { level, heard, quiet };
}

export function MicrophoneRow({
  selectId,
  detail,
  test,
  permission,
  canTest,
  children,
}: {
  selectId: string;
  detail: string;
  test: MicrophoneTest;
  permission: PermissionState;
  canTest: boolean;
  children: ReactNode;
}) {
  const [accessRequested, setAccessRequested] = useState(false);
  const { level, heard, quiet } = useLevel(test.kind === "listening" ? test.episode : null);
  const running = test.kind === "starting" || test.kind === "listening";

  useEffect(
    () => () => {
      void window.voice.stopMicrophoneTest();
    },
    [],
  );

  const action = microphoneTestAction(test, permission, canTest);
  const status = microphoneTestStatus(test, permission, { heard, quiet, accessRequested });

  function run() {
    if (action.kind === "stop") void window.voice.stopMicrophoneTest();
    else if (action.kind === "requestAccess") {
      setAccessRequested(true);
      void window.voice.requestPermission("microphone");
    } else void window.voice.startMicrophoneTest();
  }

  return (
    <div {...stylex.props(styles.row)}>
      <div {...stylex.props(styles.line)}>
        <div {...stylex.props(styles.text)}>
          <label htmlFor={selectId} {...stylex.props(styles.title)}>
            Microphone
          </label>
          <p {...stylex.props(styles.detail)}>{detail}</p>
        </div>
        <div {...stylex.props(styles.controls)}>
          <button
            type="button"
            aria-label={accessibleLabels[action.kind]}
            disabled={action.kind === "start" && action.disabled}
            onClick={run}
            {...stylex.props(styles.button)}
          >
            <svg
              aria-hidden="true"
              width="14"
              height="14"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              {...stylex.props(styles.glyph, running && styles.glyphLive)}
            >
              <rect x="7" y="2.5" width="6" height="10" rx="3" />
              <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" />
            </svg>
            {action.label}
          </button>
          {children}
        </div>
      </div>
      <div {...stylex.props(styles.expander, status && styles.open)}>
        <div {...stylex.props(styles.clip)}>
          <div {...stylex.props(styles.body)}>
            {running && (
              <div aria-hidden="true" data-level={level.toFixed(2)} {...stylex.props(styles.track)}>
                <div {...stylex.props(styles.fill)} style={{ width: `${level * 100}%` }} />
              </div>
            )}
            <p
              role="status"
              aria-live="polite"
              {...stylex.props(styles.detail, status?.failed && styles.error)}
            >
              {status?.text}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
