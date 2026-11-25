import { Field } from "@base-ui/react/field";
import * as stylex from "@stylexjs/stylex";
import { MicIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import type { MicrophoneTest, PermissionState } from "../shared/api.ts";
import { Button } from "./Button.tsx";
import {
  HEARD_LEVEL,
  QUIET_AFTER_MS,
  microphoneTestAction,
  microphoneTestStatus,
  type MicrophoneTestAction,
} from "./microphoneTestView.ts";
import { smoothLevel } from "./pillView.ts";
import { SettingTitle } from "./SettingTitle.tsx";
import { styles as settingsStyles } from "./settingsParts.tsx";
import { color, icon, motion, radius, space } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";
import { hubApi } from "./voice.ts";

// The microphone row keeps the settings row's padding and text, with a test strip that opens below.
const styles = stylex.create({
  row: { paddingBlock: space.md, paddingInline: space.base },
  line: { display: "flex", alignItems: "center", gap: space.xl },
  text: { flexGrow: 1, minWidth: 0 },
  error: { color: color.errorForeground },
  controls: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    flexShrink: 0,
    maxWidth: "48%",
  },
  glyph: { display: "block", flexShrink: 0, color: color.mutedForeground },
  glyphLive: { color: color.primary },
  expander: {
    display: "grid",
    gridTemplateRows: "0fr",
    transitionProperty: "grid-template-rows",
    transitionDuration: { default: motion.slow, [motion.reduced]: "0s" },
    transitionTimingFunction: motion.easeOut,
  },
  open: { gridTemplateRows: "1fr" },
  clip: { minHeight: 0, overflow: "hidden" },
  body: { display: "flex", flexDirection: "column", gap: space.xs, paddingTop: space.xs },
  track: {
    maxWidth: 360,
    height: 6,
    overflow: "hidden",
    borderRadius: radius.round,
    backgroundColor: color.input,
  },
  fill: {
    height: "100%",
    borderRadius: radius.round,
    backgroundColor: color.primary,
    transitionProperty: "width",
    transitionDuration: { default: "90ms", [motion.reduced]: "0s" },
    transitionTimingFunction: "linear",
  },
});

const accessibleLabels: Record<MicrophoneTestAction["kind"], string> = {
  start: "Test microphone",
  requestAccess: "Test microphone",
  stop: "Stop microphone test",
};

function useLevel(episode: number | null) {
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState(false);
  const [quiet, setQuiet] = useState(false);

  useEffect(() => {
    if (episode === null) return;
    let smoothed = 0;
    const quietTimer = setTimeout(() => setQuiet(true), QUIET_AFTER_MS);
    const unsubscribe = hubApi().onLevel((next) => {
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
  detail,
  test,
  permission,
  canTest,
  onReset,
  disabled = false,
  children,
}: {
  detail: string;
  test: MicrophoneTest;
  permission: PermissionState;
  canTest: boolean;
  onReset: (() => void) | undefined;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [accessRequested, setAccessRequested] = useState(false);
  const { level, heard, quiet } = useLevel(test.kind === "listening" ? test.episode : null);
  const running = test.kind === "starting" || test.kind === "listening";
  const { error, run: runAction } = useAction();

  useEffect(
    () => () => {
      void hubApi().stopMicrophoneTest();
    },
    [],
  );

  const action = microphoneTestAction(test, permission, canTest);
  const status = microphoneTestStatus(test, permission, { heard, quiet, accessRequested });

  function run() {
    if (action.kind === "stop") {
      void runAction(() => hubApi().stopMicrophoneTest(), "Could not stop the microphone test.");
    } else if (action.kind === "requestAccess") {
      setAccessRequested(true);
      void runAction(
        () => hubApi().requestPermission("microphone"),
        "Could not request microphone access.",
      );
    } else {
      void runAction(() => hubApi().startMicrophoneTest(), "Could not start the microphone test.");
    }
  }

  return (
    <Field.Root {...stylex.props(styles.row)}>
      <div {...stylex.props(styles.line)}>
        <div {...stylex.props(styles.text)}>
          <SettingTitle title="Microphone" onReset={onReset} disabled={disabled} />
          <p {...stylex.props(settingsStyles.rowDetail)}>{detail}</p>
        </div>
        <div {...stylex.props(styles.controls)}>
          <Button
            variant="secondary"
            aria-label={accessibleLabels[action.kind]}
            disabled={action.kind === "start" && action.disabled}
            onClick={run}
          >
            <MicIcon size={icon.md} {...stylex.props(styles.glyph, running && styles.glyphLive)} />
            {action.label}
          </Button>
          {children}
        </div>
      </div>
      <div {...stylex.props(styles.expander, (status !== null || error !== "") && styles.open)}>
        <div {...stylex.props(styles.clip)}>
          <div {...stylex.props(styles.body)}>
            {running && (
              <div aria-hidden="true" {...stylex.props(styles.track)}>
                <div {...stylex.props(styles.fill)} style={{ width: `${level * 100}%` }} />
              </div>
            )}
            <p
              role="status"
              aria-live="polite"
              {...stylex.props(settingsStyles.rowDetail, status?.failed && styles.error)}
            >
              {status?.text}
            </p>
            {error && (
              <p role="alert" {...stylex.props(settingsStyles.rowDetail, styles.error)}>
                {error}
              </p>
            )}
          </div>
        </div>
      </div>
    </Field.Root>
  );
}
