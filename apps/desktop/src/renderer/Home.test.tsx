// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import type { HubApi, Snapshot } from "../shared/api.ts";
import type { HistoryEntry, HistoryState } from "../shared/history.ts";
import { DEFAULT_STYLES } from "../shared/style.ts";
import { DEFAULT_TRANSFORMS } from "../shared/transforms.ts";
import type { ChecklistRow } from "./checklist.ts";
import { Home } from "./Home.tsx";
import { SetupChecklist } from "./SetupChecklist.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
const uninstallModel = vi.fn<HubApi["uninstallModel"]>();

beforeEach(() => {
  uninstallModel.mockReset();
  (window as { voice?: HubApi }).voice = {
    getSnapshot: vi.fn(),
    uninstallModel,
    getInsights: () => new Promise(() => {}),
    onInsights: () => () => {},
    getInstalledApps: async () => [],
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

const ready: Snapshot = {
  updates: {
    version: "0.0.1",
    installedChannel: "stable",
    channel: "stable",
    status: { kind: "disabled", reason: "Test" },
  },
  session: { kind: "idle" },
  permissions: { microphone: "granted", accessibility: "granted", systemAudio: "notDetermined" },
  speakerModel: "ready",
  loginItem: "off",
  models: { asr: { state: "ready" }, cleanup: { state: "ready" }, transform: { state: "missing" } },
  settings: {
    hotkey: "fn",
    toggleHotkey: null,
    updateChannel: "stable",
    theme: "system",
    pageAnimationMs: 200,
    microphone: null,
    lowerAudioWhileDictating: false,
    lowerAudioByPercent: 70,
    copyToClipboard: false,
    showInDock: true,
    alwaysShowPill: true,
    dictationLanguage: "en",
    cleanup: { enabled: true, styles: DEFAULT_STYLES, assignments: [] },
    diagnostics: "off",
    snippets: [],
    dictionary: [],
    zoomLevel: 0,
    transforms: DEFAULT_TRANSFORMS,
    meetingShortcut: null,
  },
  microphones: { kind: "ready", devices: [], defaultUid: null },
  microphoneTest: { kind: "off" },
  account: { kind: "signedOut" },
  meetingNotices: [],
  restartNotice: null,
};

const entry: HistoryEntry = {
  id: "one",
  at: Date.now(),
  raw: "Meet Anna on Thursday.",
  text: "Meet Anna on Thursday.",
  status: "inserted",
};
const historyOf = (entries: HistoryEntry[]): HistoryState => ({
  entries,
  retention: "memory",
  saveFailed: false,
});

const renderHome = (history: HistoryState) =>
  act(async () =>
    root.render(<Home snapshot={ready} history={history} onOpenInsights={() => {}} />),
  );
const tryIt = () => host.querySelector("textarea");
const follows = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

test("before the first dictation, Try it is a full box above the history", async () => {
  await renderHome(historyOf([]));
  const box = tryIt();
  expect(box?.labels?.[0]?.textContent).toBe("Try it");
  expect(follows(box!, host.querySelector("#history")!)).toBe(true);
  expect(host.textContent).toContain("Voice types it wherever your cursor is.");
});

test("once history has entries, Try it is one line under the headline", async () => {
  await renderHome(historyOf([entry]));
  const line = tryIt();
  expect(line?.getAttribute("aria-label")).toBe("Try it");
  expect(line?.getAttribute("rows")).toBe("1");
  expect(line?.closest("header")?.querySelector("h1")).not.toBeNull();
  expect(host.querySelectorAll("textarea")).toHaveLength(1);
});
