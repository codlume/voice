import { Dialog } from "@base-ui/react/dialog";
import * as stylex from "@stylexjs/stylex";
import { XIcon } from "lucide-react";
import { useState } from "react";

import {
  DEFAULT_MEETINGS_SETTINGS,
  maxLengths,
  meetingRetentions,
  type Meeting,
  type MeetingRetention,
  type MeetingsSettings,
  type MeetingsSettingsPatch,
} from "../shared/meetings.ts";
import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import { ConfirmDialog, DialogBackdrop, dialogStyles, transitionHidden } from "./ConfirmDialog.tsx";
import { expiredBy, maxLengthLabels, retentionLabels, retentionSentence } from "./meetingsView.ts";
import { pageStyles } from "./pageStyles.ts";
import { Select } from "./Select.tsx";
import { resetTo, Row } from "./settingsParts.tsx";
import { Switch } from "./Switch.tsx";
import { color, space } from "./tokens.stylex.ts";
import { useAction } from "./useAction.ts";
import { hubApi } from "./voice.ts";

const centered = "translate(-50%, -50%)";

const styles = stylex.create({
  popup: {
    position: "fixed",
    top: "50%",
    left: "50%",
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    width: "min(600px, calc(100vw - 32px))",
    maxHeight: "calc(100vh - 64px)",
    overflowY: "auto",
    padding: space.lg,
    backgroundColor: color.background,
    transform: centered,
  },
  popupHidden: { transform: `${centered} scale(0.96)` },
  head: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  title: { margin: 0, fontSize: 15, fontWeight: 600 },
});

const maxLengthOptions = maxLengths.map((value) => ({ value, label: maxLengthLabels[value] }));
const retentionOptions = meetingRetentions.map((value) => ({
  value,
  label: retentionLabels[value],
}));

// Outside the component so the purity lint sees the clock read happens on a change, not a render.
const expiringNow = (meetings: readonly Meeting[], to: MeetingRetention) =>
  expiredBy(meetings, to, Date.now());

const shorteningDescription = (drops: number) =>
  `${drops === 1 ? "1 older meeting is deleted with its transcript" : `${drops} older meetings are deleted with their transcripts`}, summaries and your thoughts. This cannot be undone.`;

type Shortening = { open: boolean; to: MeetingRetention; drops: number };

/** The Meetings page's gear: limits, prompts, how long meetings stay, and automatic folders. */
export function MeetingsSettingsDialog({
  open,
  onOpenChange,
  settings,
  meetings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: MeetingsSettings;
  meetings: readonly Meeting[];
}) {
  const action = useAction();
  const [shortening, setShortening] = useState<Shortening | null>(null);
  const save = (patch: MeetingsSettingsPatch): void => {
    void action.run(
      () => hubApi().updateMeetingsSettings(patch),
      "Could not save the meeting settings.",
    );
  };
  const changeRetention = (to: MeetingRetention) => {
    const drops = expiringNow(meetings, to);
    if (drops > 0) setShortening({ open: true, to, drops });
    else save({ retention: to });
  };
  const change =
    <K extends keyof MeetingsSettings>(key: K) =>
    (value: MeetingsSettings[K]) =>
      save({ [key]: value });
  const reset = <K extends keyof MeetingsSettings>(
    key: K,
    apply: (value: MeetingsSettings[K]) => void = change(key),
  ) => resetTo(settings[key], DEFAULT_MEETINGS_SETTINGS[key], apply);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <DialogBackdrop />
        <Dialog.Popup
          className={({ transitionStatus }) =>
            stylex.props(
              dialogStyles.surface,
              styles.popup,
              transitionHidden(transitionStatus) && [
                dialogStyles.surfaceHidden,
                styles.popupHidden,
              ],
            ).className
          }
        >
          <div {...stylex.props(styles.head)}>
            <Dialog.Title {...stylex.props(styles.title)}>Meeting settings</Dialog.Title>
            <Dialog.Close render={<Button variant="icon" aria-label="Close meeting settings" />}>
              <XIcon size={16} />
            </Dialog.Close>
          </div>
          <Card>
            <Row
              title="Maximum length"
              detail="Recording stops at this length. You get a warning 5 minutes before."
              onReset={reset("maxLength")}
            >
              <Select
                id="meetings-max-length"
                value={settings.maxLength}
                options={maxLengthOptions}
                onChange={change("maxLength")}
              />
            </Row>
            <Row
              title="Ask after 10 minutes of silence"
              detail="Checks whether the meeting is over when nobody has spoken for 10 minutes."
              nativeLabel
              onReset={reset("silencePrompt")}
            >
              <Switch
                id="meetings-silence-prompt"
                checked={settings.silencePrompt}
                onChange={change("silencePrompt")}
              />
            </Row>
            <Row
              title="Open summary when ready"
              detail="Shows the meeting here as soon as its summary is written."
              nativeLabel
              onReset={reset("openSummaryWhenReady")}
            >
              <Switch
                id="meetings-open-summary"
                checked={settings.openSummaryWhenReady}
                onChange={change("openSummaryWhenReady")}
              />
            </Row>
            <Row
              title="Keep meetings"
              detail={retentionSentence(settings.retention)}
              onReset={reset("retention", changeRetention)}
            >
              <Select
                id="meetings-retention"
                value={settings.retention}
                options={retentionOptions}
                onChange={changeRetention}
              />
            </Row>
            <Row
              title="Automatic folders"
              detail="Adds a meeting to every automatic folder whose word is in its title."
              nativeLabel
              onReset={reset("autoFolders")}
            >
              <Switch
                id="meetings-auto-folders"
                checked={settings.autoFolders}
                onChange={change("autoFolders")}
              />
            </Row>
          </Card>
          {action.error && (
            <p role="alert" {...stylex.props(pageStyles.error)}>
              {action.error}
            </p>
          )}
          {shortening && (
            <ConfirmDialog
              open={shortening.open}
              onOpenChange={(next) => setShortening({ ...shortening, open: next })}
              title={`Keep meetings for ${retentionLabels[shortening.to]}?`}
              description={shorteningDescription(shortening.drops)}
              actions={[
                {
                  label: "Delete older",
                  variant: "destructive",
                  onClick: () => save({ retention: shortening.to }),
                },
              ]}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
