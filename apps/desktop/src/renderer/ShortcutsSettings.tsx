import * as stylex from "@stylexjs/stylex";

import type { Hotkey, ModelStatus, Settings } from "../shared/api.ts";
import { DEFAULT_SETTINGS, hotkeys } from "../shared/api.ts";
import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import { dictatesWithFn, dictationKeys, hotkeyLabel } from "./hotkeys.ts";
import { Keys } from "./Keycap.tsx";
import { pageStyles } from "./pageStyles.ts";
import { Select } from "./Select.tsx";
import { GlobeHint, resetTo, Row, Section, styles, update } from "./settingsParts.tsx";
import { MEETING_SHORTCUT_TITLE, shortcutKeys } from "./shortcutCapture.ts";
import { ShortcutPicker } from "./ShortcutPicker.tsx";
import { jumpShortcuts, shortcuts } from "./shortcuts.ts";
import { shortcutsHint } from "./transformsView.ts";
import { useAction } from "./useAction.ts";
import { useKeyboardLayout } from "./useKeyboardLayout.ts";

const hotkeyOptions = hotkeys.map((value) => ({ value, label: hotkeyLabel(value) }));
const TOGGLE_OFF = "off";
type ToggleChoice = Hotkey | typeof TOGGLE_OFF;

function ShortcutRow({
  title,
  detail,
  keys,
}: {
  title: string;
  detail?: string | undefined;
  keys: readonly string[] | null;
}) {
  return (
    <div {...stylex.props(styles.row)}>
      <div {...stylex.props(styles.rowText)}>
        <span {...stylex.props(styles.rowTitle)}>{title}</span>
        {detail && <p {...stylex.props(styles.rowDetail)}>{detail}</p>}
      </div>
      <Keys keys={keys} />
    </div>
  );
}

export function ShortcutsSettings({
  settings,
  transformModel,
  onOpenTransforms,
}: {
  settings: Settings;
  transformModel: ModelStatus;
  onOpenTransforms: () => void;
}) {
  const hotkeyAction = useAction();
  const meetingAction = useAction();
  const layout = useKeyboardLayout();
  const transforms = settings.transforms;
  const changeHotkey = (hotkey: Hotkey) => update(hotkeyAction, { hotkey });
  const toggleChoice: ToggleChoice = settings.toggleHotkey ?? TOGGLE_OFF;
  const changeToggle = (choice: ToggleChoice) =>
    update(hotkeyAction, { toggleHotkey: choice === TOGGLE_OFF ? null : choice });
  const toggleOptions: readonly { value: ToggleChoice; label: string }[] = [
    { value: TOGGLE_OFF, label: "Off" },
    ...hotkeyOptions.filter((option) => option.value !== settings.hotkey),
  ];
  return (
    <div {...stylex.props(styles.page)}>
      <h1 {...stylex.props(pageStyles.headline)}>Shortcuts</h1>

      <Section label="Dictation">
        <Card>
          <Row
            title="Hold to talk"
            detail="Hold the key while you speak."
            onReset={resetTo(settings.hotkey, DEFAULT_SETTINGS.hotkey, changeHotkey)}
          >
            <Select
              id="setting-hotkey"
              value={settings.hotkey}
              options={hotkeyOptions}
              onChange={changeHotkey}
            />
          </Row>
          <Row
            title="Toggle dictation"
            detail="Tap once to start, tap again to stop and insert."
            onReset={resetTo(toggleChoice, TOGGLE_OFF, changeToggle)}
          >
            <Select
              id="setting-toggle-hotkey"
              value={toggleChoice}
              options={toggleOptions}
              onChange={changeToggle}
            />
          </Row>
          <ShortcutRow
            title="Cancel dictation"
            detail="Press while dictating to stop without inserting."
            keys={["Esc"]}
          />
        </Card>
        {hotkeyAction.error && (
          <p role="alert" {...stylex.props(pageStyles.error)}>
            {hotkeyAction.error}
          </p>
        )}
        {dictatesWithFn(settings) && <GlobeHint />}
      </Section>

      <Section label="Meetings">
        <Card>
          <div {...stylex.props(styles.row)}>
            <div {...stylex.props(styles.rowText)}>
              <ShortcutPicker
                label={MEETING_SHORTCUT_TITLE}
                value={settings.meetingShortcut}
                others={transforms.items}
                layout={layout}
                dictationKeys={dictationKeys(settings)}
                invalid={false}
                onChange={(meetingShortcut) => update(meetingAction, { meetingShortcut })}
              />
            </div>
          </div>
        </Card>
        <p {...stylex.props(styles.hint)}>
          Press it in any app to start a meeting, and again to stop it.
        </p>
        {meetingAction.error && (
          <p role="alert" {...stylex.props(pageStyles.error)}>
            {meetingAction.error}
          </p>
        )}
      </Section>

      <Section label="Transforms">
        {transforms.items.length > 0 && (
          <Card style={!transforms.enabled && styles.disabled}>
            {transforms.items.map((transform) => (
              <ShortcutRow
                key={transform.id}
                title={transform.name}
                keys={transform.shortcut && shortcutKeys(transform.shortcut, layout)}
              />
            ))}
          </Card>
        )}
        <p {...stylex.props(styles.hint)}>
          {shortcutsHint(transforms, transformModel)}{" "}
          <Button variant="text" onClick={onOpenTransforms}>
            <span {...stylex.props(styles.link)}>Open Transforms</span>
          </Button>
        </p>
      </Section>

      <Section label="Voice window">
        <Card>
          <ShortcutRow title="Toggle sidebar" keys={shortcuts.toggleSidebar.keys} />
          <ShortcutRow title="Open Settings" keys={shortcuts.openSettings.keys} />
          <ShortcutRow title="Close Settings" detail="Or ⌘, again." keys={["Esc"]} />
          <ShortcutRow
            title="Search history"
            detail="On Home."
            keys={shortcuts.searchHistory.keys}
          />
          <ShortcutRow
            title="Go to sidebar item"
            detail="Jump to an item in the sidebar, or in Settings while it is open, top to bottom."
            keys={["⌘", `1–${jumpShortcuts.length}`]}
          />
          <ShortcutRow title="Zoom in" keys={["⌘", "+"]} />
          <ShortcutRow title="Zoom out" keys={["⌘", "-"]} />
          <ShortcutRow title="Actual size" keys={["⌘", "0"]} />
        </Card>
      </Section>
    </div>
  );
}
