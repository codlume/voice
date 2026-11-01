import * as stylex from "@stylexjs/stylex";

import type {
  MicrophoneCatalog,
  MicrophoneTest,
  PermissionState,
  Settings,
  UpdateChannel,
  UpdatesSnapshot,
} from "../shared/api.ts";
import { DEFAULT_SETTINGS } from "../shared/api.ts";
import { dictationLanguages, type DictationLanguage } from "../shared/dictation-language.ts";
import { Card } from "./Card.tsx";
import { MicrophoneRow } from "./MicrophoneRow.tsx";
import { pageStyles } from "./pageStyles.ts";
import { Select } from "./Select.tsx";
import { resetTo, Row, Section, styles, update } from "./settingsParts.tsx";
import { useAction } from "./useAction.ts";
import { Switch } from "./Switch.tsx";
import { updateStatusText } from "./updateStatus.ts";
import { hubApi } from "./voice.ts";

const updateChannels = [
  { value: "stable", label: "Stable" },
  { value: "nightly", label: "Nightly" },
] as const satisfies readonly { value: UpdateChannel; label: string }[];

export function GeneralSettings({
  settings,
  microphones,
  microphoneTest,
  microphonePermission,
  updates,
}: {
  settings: Settings;
  microphones: MicrophoneCatalog;
  microphoneTest: MicrophoneTest;
  microphonePermission: PermissionState;
  updates: UpdatesSnapshot;
}) {
  const microphoneAction = useAction();
  const devices = microphones.kind === "ready" ? microphones.devices : [];
  const selected = settings.microphone;
  const missing = selected !== null && !devices.some((device) => device.uid === selected.uid);
  const microphoneOptions = [
    { value: "", label: "System default" },
    ...devices.map((device) => ({ value: device.uid, label: device.name })),
    ...(missing
      ? [
          {
            value: selected.uid,
            label: `${selected.name} (${microphones.kind === "ready" ? "unavailable" : "saved"})`,
          },
        ]
      : []),
  ];
  const defaultName =
    microphones.kind === "ready"
      ? devices.find((device) => device.uid === microphones.defaultUid)?.name
      : undefined;
  let microphoneDetail = "Changes apply to your next dictation.";
  if (microphones.kind === "loading") {
    microphoneDetail = "Looking for microphones…";
  } else if (microphones.kind === "unavailable") {
    microphoneDetail = microphones.message;
  } else if (missing) {
    microphoneDetail = "Reconnect this microphone or choose another before dictating.";
  } else if (devices.length === 0) {
    microphoneDetail = "No microphones found. Connect a microphone to dictate.";
  } else if (selected === null && defaultName) {
    microphoneDetail = `Currently ${defaultName}. Changes apply to your next dictation.`;
  }

  // The empty uid is the "System default" option, which saves no microphone.
  const microphoneUid = selected?.uid ?? "";

  function changeMicrophone(uid: string) {
    const microphone = uid === "" ? null : devices.find((device) => device.uid === uid);
    if (microphone === undefined) return;
    void microphoneAction.run(
      () => hubApi().updateSettings({ microphone }),
      "Could not save microphone.",
    );
  }

  const languageAction = useAction();

  function changeLanguage(dictationLanguage: DictationLanguage) {
    void languageAction.run(
      () => hubApi().updateSettings({ dictationLanguage }),
      "Could not save dictation language.",
    );
  }

  const clipboardAction = useAction();
  const changeClipboard = (copyToClipboard: boolean) =>
    update(clipboardAction, { copyToClipboard });

  const channelAction = useAction();

  function changeChannel(channel: UpdateChannel) {
    void channelAction.run(
      () => hubApi().updateSettings({ updateChannel: channel }),
      "Could not change update channel.",
    );
  }

  return (
    <div {...stylex.props(styles.page)}>
      <h1 {...stylex.props(pageStyles.headline)}>General</h1>

      <Section label="Input">
        <Card>
          <MicrophoneRow
            detail={microphoneDetail}
            test={microphoneTest}
            permission={microphonePermission}
            canTest={microphones.kind === "ready" && devices.length > 0 && !missing}
            onReset={resetTo(microphoneUid, "", changeMicrophone)}
            disabled={microphoneAction.pending}
          >
            <Select
              id="setting-microphone"
              value={microphoneUid}
              options={microphoneOptions}
              disabled={microphoneAction.pending}
              grouped
              onChange={changeMicrophone}
            />
          </MicrophoneRow>
        </Card>
        {microphoneAction.error && (
          <p role="alert" {...stylex.props(pageStyles.error)}>
            {microphoneAction.error}
          </p>
        )}
      </Section>

      <Section label="Dictation language">
        <Card>
          <Row
            title="Spoken language"
            detail="Your choice guides speech recognition for your next dictation. Choose Auto-detect for multiple languages. Text cleanup is available for English only."
            onReset={resetTo(
              settings.dictationLanguage,
              DEFAULT_SETTINGS.dictationLanguage,
              changeLanguage,
            )}
          >
            <Select
              id="setting-dictation-language"
              value={settings.dictationLanguage}
              options={dictationLanguages}
              onChange={changeLanguage}
            />
          </Row>
        </Card>
        {languageAction.error && (
          <p role="alert" {...stylex.props(pageStyles.error)}>
            {languageAction.error}
          </p>
        )}
      </Section>

      <Section label="After dictation">
        <Card>
          <Row
            nativeLabel
            title="Copy transcript to clipboard"
            detail="Keeps each transcript on your clipboard too, replacing what you copied before."
            onReset={resetTo(
              settings.copyToClipboard,
              DEFAULT_SETTINGS.copyToClipboard,
              changeClipboard,
            )}
          >
            <Switch
              id="setting-copy-to-clipboard"
              checked={settings.copyToClipboard}
              onChange={changeClipboard}
            />
          </Row>
        </Card>
        {clipboardAction.error && (
          <p role="alert" {...stylex.props(pageStyles.error)}>
            {clipboardAction.error}
          </p>
        )}
      </Section>

      <Section label="About">
        <Card>
          <Row
            title="Update channel"
            detail="Stable gets regular releases. Nightly gets early builds."
            disabled={updates.status.kind === "installing"}
            // The default is the installed build's channel, not DEFAULT_SETTINGS.updateChannel.
            onReset={resetTo(updates.channel, updates.installedChannel, changeChannel)}
          >
            <Select
              id="setting-update-channel"
              value={updates.channel}
              options={updateChannels}
              disabled={updates.status.kind === "installing"}
              onChange={changeChannel}
            />
          </Row>
          <div {...stylex.props(styles.row)}>
            <div {...stylex.props(styles.rowText)}>
              <span {...stylex.props(styles.rowTitle)}>Installed version</span>
              <p {...stylex.props(styles.rowDetail)}>
                {updates.version} · {updates.installedChannel === "nightly" ? "Nightly" : "Stable"}
              </p>
            </div>
          </div>
          <div {...stylex.props(styles.row)}>
            <div {...stylex.props(styles.rowText)}>
              <span {...stylex.props(styles.rowTitle)}>Update status</span>
              <p role="status" aria-live="polite" {...stylex.props(styles.rowDetail)}>
                {updateStatusText(updates.status)}
              </p>
              {channelAction.error && (
                <p role="alert" {...stylex.props(pageStyles.error)}>
                  {channelAction.error}
                </p>
              )}
            </div>
          </div>
        </Card>
      </Section>
    </div>
  );
}
