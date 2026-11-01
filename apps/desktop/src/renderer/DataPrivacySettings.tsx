import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import type { DiagnosticsConsent, Settings } from "../shared/api.ts";
import { DEFAULT_SETTINGS } from "../shared/api.ts";
import {
  historyRetentions,
  type HistoryEntry,
  type HistoryRetention,
  type HistoryState,
} from "../shared/history.ts";
import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { retentionLoss, type RetentionLoss } from "./historyView.ts";
import { retentionSentence } from "./meetingsView.ts";
import { pageStyles } from "./pageStyles.ts";
import { Select } from "./Select.tsx";
import { resetTo, Row, Section, styles, update } from "./settingsParts.tsx";
import { useAction } from "./useAction.ts";
import { useMeetings } from "./useMeetings.ts";
import { Switch } from "./Switch.tsx";
import { hubApi } from "./voice.ts";

const retentionLabels: Record<HistoryRetention, string> = {
  memory: "Until I quit Voice",
  day: "24 hours",
  month: "30 days",
  forever: "Forever",
};
const retentionOptions = historyRetentions.map((value) => ({
  value,
  label: retentionLabels[value],
}));
// Outside the component so the purity lint sees the clock read happens on a click, not a render.
const lossNow = (entries: readonly HistoryEntry[], from: HistoryRetention, to: HistoryRetention) =>
  retentionLoss(entries, from, to, Date.now());
const lossQuestion = (to: HistoryRetention, { kind, count }: RetentionLoss) =>
  kind === "older"
    ? {
        title: `Keep history for ${retentionLabels[to]}?`,
        description: `${count === 1 ? "1 older transcript is" : `${count} older transcripts are`} deleted from your history. This cannot be undone.`,
        confirm: "Delete older",
      }
    : {
        title: "Keep history only until you quit Voice?",
        description: `${count === 1 ? "1 saved transcript is" : `${count} saved transcripts are`} deleted from this Mac now. Home shows them until you quit Voice. This cannot be undone.`,
        confirm: "Delete from this Mac",
      };

export function DataPrivacySettings({
  settings,
  history,
  onOpenMeetingSettings,
}: {
  settings: Settings;
  history: HistoryState;
  onOpenMeetingSettings: () => void;
}) {
  const meetings = useMeetings();
  const diagnosticsAction = useAction();
  const changeDiagnostics = (diagnostics: DiagnosticsConsent) =>
    update(diagnosticsAction, { diagnostics });
  const clearAction = useAction();
  const [confirmingClear, setConfirmingClear] = useState(false);
  return (
    <div {...stylex.props(styles.page)}>
      <h1 {...stylex.props(pageStyles.headline)}>Data and Privacy</h1>

      <Section label="Diagnostics">
        <Card>
          <Row
            nativeLabel
            title="Share crash reports"
            detail="Sends crashes, dictation timings, and app events, such as a helper restart or a failed cleanup. Never sends your words, audio, clipboard, or the app you dictate into. Turning this on takes effect the next time Voice opens. Turning it off stops sending right away."
            onReset={resetTo(settings.diagnostics, DEFAULT_SETTINGS.diagnostics, changeDiagnostics)}
          >
            <Switch
              id="setting-diagnostics"
              checked={settings.diagnostics === "on"}
              onChange={(on) => changeDiagnostics(on ? "on" : "off")}
            />
          </Row>
        </Card>
        {diagnosticsAction.error && (
          <p role="alert" {...stylex.props(pageStyles.error)}>
            {diagnosticsAction.error}
          </p>
        )}
      </Section>

      <HistorySection history={history} />

      <Section label="Meetings">
        <Card>
          <Row
            title="Keep meetings"
            detail={
              meetings ? retentionSentence(meetings.settings.retention) : "Reading your meetings…"
            }
            onReset={undefined}
          >
            <Button variant="secondary" onClick={onOpenMeetingSettings}>
              Meeting settings…
            </Button>
          </Row>
        </Card>
      </Section>

      <Section label="Insights">
        <Card>
          <Row
            title="Clear insights"
            detail="Deletes your word counts, pace, fixes, streaks, and app usage from this Mac. Your dictionary and snippets stay."
            onReset={undefined}
          >
            <Button
              variant="secondary"
              aria-label="Clear insights"
              onClick={() => setConfirmingClear(true)}
            >
              Clear…
            </Button>
          </Row>
        </Card>
        {clearAction.error && (
          <p role="alert" {...stylex.props(pageStyles.error)}>
            {clearAction.error}
          </p>
        )}
        <ConfirmDialog
          open={confirmingClear}
          onOpenChange={setConfirmingClear}
          title="Clear insights?"
          description="Your words, pace, fixes, streaks, and app usage start again from zero. This cannot be undone."
          actions={[
            {
              label: "Clear",
              variant: "destructive",
              onClick: () =>
                void clearAction.run(() => hubApi().clearInsights(), "Could not clear insights."),
            },
          ]}
        />
      </Section>
    </div>
  );
}

// A change that would lose saved entries asks first. The dialog keeps what it asked while it
// fades out, so it stays mounted with `open: false` rather than losing its content.
type Asking = { open: boolean; to: HistoryRetention } & ReturnType<typeof lossQuestion>;

function HistorySection({ history: { entries, retention } }: { history: HistoryState }) {
  const action = useAction();
  const apply = (to: HistoryRetention) =>
    void action.run(
      () => hubApi().setHistoryRetention(to),
      "Could not change where your history is kept.",
    );
  const [asking, setAsking] = useState<Asking | null>(null);
  const change = (to: HistoryRetention) => {
    const loss = lossNow(entries, retention, to);
    if (loss) setAsking({ open: true, to, ...lossQuestion(to, loss) });
    else apply(to);
  };
  const [confirmingClear, setConfirmingClear] = useState(false);
  return (
    <Section label="History">
      <Card>
        <Row
          title="Keep history"
          detail="Your transcripts on Home. Saved history stays on this Mac. Audio is never saved."
          disabled={action.pending}
          onReset={resetTo(retention, "memory", change)}
        >
          <Select
            id="setting-history-retention"
            value={retention}
            options={retentionOptions}
            disabled={action.pending}
            onChange={change}
          />
        </Row>
        <Row
          title="Clear history"
          detail="Deletes every transcript in your history, in memory and on this Mac."
          onReset={undefined}
        >
          <Button
            variant="secondary"
            aria-label="Clear history"
            onClick={() => setConfirmingClear(true)}
          >
            Clear…
          </Button>
        </Row>
      </Card>
      {action.error && (
        <p role="alert" {...stylex.props(pageStyles.error)}>
          {action.error}
        </p>
      )}
      {asking && (
        <ConfirmDialog
          open={asking.open}
          onOpenChange={(open) => setAsking({ ...asking, open })}
          title={asking.title}
          description={asking.description}
          actions={[
            { label: asking.confirm, variant: "destructive", onClick: () => apply(asking.to) },
          ]}
        />
      )}
      <ConfirmDialog
        open={confirmingClear}
        onOpenChange={setConfirmingClear}
        title="Clear history?"
        description="Every transcript in your history is deleted. This cannot be undone."
        actions={[
          {
            label: "Clear",
            variant: "destructive",
            onClick: () =>
              void action.run(() => hubApi().clearHistory(), "Could not clear history."),
          },
        ]}
      />
    </Section>
  );
}
