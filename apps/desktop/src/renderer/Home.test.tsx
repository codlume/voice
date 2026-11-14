// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { HubApi } from "../shared/api.ts";
import type { ChecklistRow } from "./checklist.ts";
import { SetupChecklist } from "./Home.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
const uninstallModel = vi.fn<HubApi["uninstallModel"]>();

beforeEach(() => {
  uninstallModel.mockReset();
  (window as { voice?: HubApi }).voice = {
    getSnapshot: vi.fn(),
    uninstallModel,
  } as Partial<HubApi> as HubApi;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const downloading: ChecklistRow = {
  id: "cleanup",
  title: "Cleanup model",
  subtitle: "Tidies punctuation.",
  status: { kind: "busy", text: "Downloading 40%", progress: 0.4 },
  actions: [{ label: "Cancel", command: { type: "uninstallModel", id: "cleanup" } }],
};

test("a setup action that main refuses tells the user why", async () => {
  uninstallModel.mockRejectedValueOnce(
    new Error(
      "Error invoking remote method 'voice:uninstallModel': Error: Wait for the cleanup model to finish loading.",
    ),
  );
  await act(async () => root.render(<SetupChecklist title="Set up Voice" rows={[downloading]} />));
  const cancel = host.querySelector<HTMLButtonElement>('button[aria-label="Cancel Cleanup model"]');
  await act(async () => cancel?.click());
  expect(uninstallModel).toHaveBeenCalledWith("cleanup");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "Wait for the cleanup model to finish loading.",
  );
});
