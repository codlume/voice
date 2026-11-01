import * as stylex from "@stylexjs/stylex";

import type { LoginItem, Settings, Theme } from "../shared/api.ts";
import {
  DEFAULT_SETTINGS,
  LOWER_AUDIO_STEP_PERCENT,
  MAX_LOWER_AUDIO_PERCENT,
  MAX_PAGE_ANIMATION_MS,
  MIN_LOWER_AUDIO_PERCENT,
  MIN_PAGE_ANIMATION_MS,
  PAGE_ANIMATION_STEP_MS,
} from "../shared/api.ts";
import { Card } from "./Card.tsx";
import { CommitSlider } from "./CommitSlider.tsx";
import { PageAnimationPreview } from "./PageAnimationPreview.tsx";
import { pageStyles } from "./pageStyles.ts";
import { resetTo, Row, Section, Segmented, styles, update } from "./settingsParts.tsx";
import { useAction } from "./useAction.ts";
import { Switch } from "./Switch.tsx";
import { hubApi } from "./voice.ts";

const audioStyles = stylex.create({
  amount: { flexShrink: 0, width: "13rem" },
});

const motionStyles = stylex.create({
  control: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 7rem) minmax(8rem, 13rem)",
    alignItems: "center",
    gap: 16,
  },
  reducedMotionHint: {
    display: { default: "none", "@media (prefers-reduced-motion: reduce)": "block" },
  },
});

const themes = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const satisfies readonly { value: Theme; label: string }[];

const loginItemDetails: Record<LoginItem, string> = {
  on: "Start Voice when you log in to your Mac, so dictation is ready right away.",
  off: "Start Voice when you log in to your Mac, so dictation is ready right away.",
  needsApproval:
    "macOS needs your approval. Turn this on to open Login Items in System Settings, then allow Voice.",
  unavailable: "Development builds can't open at login.",
};

export function SystemSettings({
  settings,
  loginItem,
}: {
  settings: Settings;
  loginItem: LoginItem;
}) {
  const loginAction = useAction();
  const audioAction = useAction();
  const appearanceAction = useAction();
  const motionAction = useAction();
  const changeLowerAudio = (lowerAudioWhileDictating: boolean) =>
    update(audioAction, { lowerAudioWhileDictating });
  const changeLowerAudioBy = (lowerAudioByPercent: number) =>
    update(audioAction, { lowerAudioByPercent });
  const changeTheme = (theme: Theme) => update(appearanceAction, { theme });
  const changePageAnimation = (pageAnimationMs: number) =>
    update(motionAction, { pageAnimationMs });
  const changeDock = (showInDock: boolean) => update(appearanceAction, { showInDock });
  const changePill = (alwaysShowPill: boolean) => update(appearanceAction, { alwaysShowPill });
  return (
    <div {...stylex.props(styles.page)}>
      <h1 {...stylex.props(pageStyles.headline)}>System</h1>

      <Section label="Startup">
        <Card>
          <Row
            nativeLabel
            title="Open at login"
            detail={loginItemDetails[loginItem]}
            disabled={loginItem === "unavailable"}
            // Mirrors macOS Login Items rather than a stored setting, so it has no default.
            onReset={undefined}
          >
            <Switch
              id="setting-open-at-login"
              checked={loginItem === "on"}
              disabled={loginItem === "unavailable"}
              onChange={(on) =>
                void loginAction.run(
                  () => hubApi().setOpenAtLogin(on),
                  "Could not change open at login.",
                )
              }
            />
          </Row>
        </Card>
        {loginAction.error && (
          <p role="alert" {...stylex.props(pageStyles.error)}>
            {loginAction.error}
          </p>
        )}
      </Section>

      <Section label="Audio">
        <Card>
          <Row
            nativeLabel
            title="Lower audio while dictating"
            detail="Turns down supported output devices while recording, then restores their volume."
            onReset={resetTo(
              settings.lowerAudioWhileDictating,
              DEFAULT_SETTINGS.lowerAudioWhileDictating,
              changeLowerAudio,
            )}
          >
            <Switch
              id="setting-lower-audio-while-dictating"
              checked={settings.lowerAudioWhileDictating}
              onChange={changeLowerAudio}
            />
          </Row>
          <Row
            title="Reduce volume by"
            detail="100% mutes. Outputs without a volume control are muted."
            disabled={!settings.lowerAudioWhileDictating}
            onReset={resetTo(
              settings.lowerAudioByPercent,
              DEFAULT_SETTINGS.lowerAudioByPercent,
              changeLowerAudioBy,
            )}
          >
            <div {...stylex.props(audioStyles.amount)}>
              <CommitSlider
                saved={settings.lowerAudioByPercent}
                onCommit={changeLowerAudioBy}
                min={MIN_LOWER_AUDIO_PERCENT}
                max={MAX_LOWER_AUDIO_PERCENT}
                step={LOWER_AUDIO_STEP_PERCENT}
                readout={(percent) => `${percent}%`}
                label="Reduce volume by"
                valueText={(percent) => `${percent} percent`}
                disabled={!settings.lowerAudioWhileDictating}
              />
            </div>
          </Row>
        </Card>
        {audioAction.error && (
          <p role="alert" {...stylex.props(pageStyles.error)}>
            {audioAction.error}
          </p>
        )}
      </Section>

      <Section label="Appearance">
        <Card>
          <Row
            title="Theme"
            detail="Match your Mac, or pick light or dark."
            onReset={resetTo(settings.theme, DEFAULT_SETTINGS.theme, changeTheme)}
          >
            <Segmented options={themes} value={settings.theme} onChange={changeTheme} />
          </Row>
          <Row
            nativeLabel
            title="Show in Dock"
            detail="When off, Voice stays out of the Dock and Cmd-Tab. Open it from the menu bar."
            onReset={resetTo(settings.showInDock, DEFAULT_SETTINGS.showInDock, changeDock)}
          >
            <Switch id="setting-show-in-dock" checked={settings.showInDock} onChange={changeDock} />
          </Row>
          <Row
            nativeLabel
            title="Show Flow Bar at all times"
            detail="When off, the Flow Bar appears only while you dictate."
            onReset={resetTo(settings.alwaysShowPill, DEFAULT_SETTINGS.alwaysShowPill, changePill)}
          >
            <Switch
              id="setting-always-show-pill"
              checked={settings.alwaysShowPill}
              onChange={changePill}
            />
          </Row>
        </Card>
        {appearanceAction.error && (
          <p role="alert" {...stylex.props(pageStyles.error)}>
            {appearanceAction.error}
          </p>
        )}
      </Section>

      <Section label="Motion">
        <Card>
          <Row
            title="Page animations"
            detail="Set how fast pages and the sidebar move."
            onReset={resetTo(
              settings.pageAnimationMs,
              DEFAULT_SETTINGS.pageAnimationMs,
              changePageAnimation,
            )}
          >
            <div {...stylex.props(motionStyles.control)}>
              <PageAnimationPreview />
              <CommitSlider
                saved={settings.pageAnimationMs}
                onCommit={changePageAnimation}
                min={MIN_PAGE_ANIMATION_MS}
                max={MAX_PAGE_ANIMATION_MS}
                step={PAGE_ANIMATION_STEP_MS}
                readout={(ms) => `${ms} ms`}
                label="Page animation duration"
                valueText={(ms) => `${ms} milliseconds`}
              />
            </div>
          </Row>
        </Card>
        <p {...stylex.props(styles.hint, motionStyles.reducedMotionHint)}>
          Reduce motion is on in your system settings, so pages change without animation.
        </p>
        {motionAction.error && (
          <p role="alert" {...stylex.props(pageStyles.error)}>
            {motionAction.error}
          </p>
        )}
      </Section>
    </div>
  );
}
