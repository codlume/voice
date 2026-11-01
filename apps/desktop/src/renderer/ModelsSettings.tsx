import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import type { ModelStatus, PillState, Settings, Snapshot } from "../shared/api.ts";
import { models, type Model, type ModelId } from "../shared/models.ts";
import { Button } from "./Button.tsx";
import { Card } from "./Card.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { activityOf, modelView, type Activity, type ModelAction } from "./modelView.ts";
import { pageStyles } from "./pageStyles.ts";
import { Section, styles } from "./settingsParts.tsx";
import { useAction } from "./useAction.ts";
import { hubApi } from "./voice.ts";

const modelActions = {
  Install: (id) => hubApi().installModel(id),
  Retry: (id) => hubApi().installModel(id),
  Uninstall: (id) => hubApi().uninstallModel(id),
  Cancel: (id) => hubApi().uninstallModel(id),
} satisfies Record<ModelAction, (id: ModelId) => Promise<void>>;

function ModelSection({
  model,
  status,
  cleanupEnabled,
  activity,
}: {
  model: Model;
  status: ModelStatus;
  cleanupEnabled: boolean;
  activity: Activity;
}) {
  const { pending, error, run: runAction } = useAction();
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  const view = modelView(model, status, { cleanupEnabled, activity });
  const canUninstall = view.actions.some(
    ({ label, disabled }) => label === "Uninstall" && !disabled,
  );
  // Dictation, a transform or a download can withdraw Uninstall while the dialog is open.
  if (confirmingUninstall && !canUninstall) setConfirmingUninstall(false);

  const run = (action: ModelAction) =>
    runAction(
      () => modelActions[action](model.id),
      `Could not ${action.toLowerCase()} ${model.name}.`,
    );

  return (
    <Section label={model.purpose}>
      <Card>
        <div {...stylex.props(styles.row)}>
          <div {...stylex.props(styles.rowText)}>
            <span {...stylex.props(styles.rowTitle)}>{model.name}</span>
            <p {...stylex.props(styles.rowDetail)}>
              {model.vendor} · {model.size}
            </p>
            <p
              role="status"
              aria-live="polite"
              {...stylex.props(styles.rowDetail, status.state === "failed" && pageStyles.error)}
            >
              {view.text}
            </p>
          </div>
          {view.actions.length > 0 && (
            <div {...stylex.props(styles.actions)}>
              {view.actions.map(({ label, disabled }) => (
                <Button
                  key={label}
                  variant={label === "Install" || label === "Retry" ? "primary" : "secondary"}
                  aria-label={`${label} ${model.name}`}
                  disabled={pending || disabled}
                  onClick={() =>
                    label === "Uninstall" ? setConfirmingUninstall(true) : void run(label)
                  }
                >
                  {label}
                </Button>
              ))}
            </div>
          )}
        </div>
      </Card>
      {error && (
        <p role="alert" {...stylex.props(pageStyles.error)}>
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirmingUninstall}
        onOpenChange={setConfirmingUninstall}
        title={`Uninstall the ${model.kind.toLowerCase()}?`}
        description={`${model.lostUntilReinstalled} until you install it again, which is about a ${model.size} download.`}
        actions={[
          { label: "Uninstall", variant: "destructive", onClick: () => void run("Uninstall") },
        ]}
      />
    </Section>
  );
}

export function ModelsSettings({
  models: statuses,
  settings,
  session,
}: {
  models: Snapshot["models"];
  settings: Settings;
  session: PillState;
}) {
  const activity = activityOf(session);
  return (
    <div {...stylex.props(styles.page)}>
      <h1 {...stylex.props(pageStyles.headline)}>Models</h1>
      {models.map((model) => (
        <ModelSection
          key={model.id}
          model={model}
          status={statuses[model.id]}
          cleanupEnabled={settings.cleanup.enabled}
          activity={activity}
        />
      ))}
    </div>
  );
}
