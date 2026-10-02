import type { DiagnosticLog } from "./diagnostics-scrub.ts";

const DOCK_SHOW_SETTLE_MS = 1000;

// Electron ignores dock.hide() within a second of dock.show(), so changes run one at a time,
// each applies the latest setting, and a show holds the queue for that second.
export function createDockSync(deps: {
  dock: Pick<Electron.Dock, "show" | "hide"> | undefined;
  showInDock: () => boolean;
  wait: (ms: number) => Promise<void>;
  // Leaving the Dock deactivates Voice, which would drop the open hub behind other apps.
  afterChange: () => void;
  log: (message: string, entry?: DiagnosticLog) => void;
}): () => Promise<void> {
  const { dock, showInDock, wait, afterChange, log } = deps;
  let change: Promise<void> = Promise.resolve();
  return () => {
    change = change
      .then(async () => {
        if (showInDock()) {
          await dock?.show();
          await wait(DOCK_SHOW_SETTLE_MS);
        } else {
          dock?.hide();
        }
        afterChange();
      })
      .catch((error: unknown) =>
        log(`dock: ${error instanceof Error ? error.message : String(error)}`, {
          message: "dock update failed",
          level: "warn",
        }),
      );
    return change;
  };
}
