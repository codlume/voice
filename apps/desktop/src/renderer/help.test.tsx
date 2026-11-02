// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { DEFAULT_SETTINGS, type HubApi, type Snapshot } from "../shared/api.ts";
import { EMPTY_INSIGHTS } from "../shared/insights.ts";
import { viewHelp } from "./help.ts";
import { Insights } from "./Insights.tsx";
import { Meetings } from "./Meetings.tsx";
import { fakeMeetingsMain } from "./testing/meetingsFake.ts";
import { sampleMeetings } from "./testing/meetingsFixtures.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

const snapshot: Snapshot = {
  microphones: { kind: "loading" },
  microphoneTest: { kind: "off" },
  updates: {
    version: "0.0.1",
    installedChannel: "stable",
    channel: "stable",
    status: { kind: "idle" },
  },
  session: { kind: "idle" },
  permissions: { microphone: "granted", accessibility: "granted", systemAudio: "granted" },
  speakerModel: "ready",
  loginItem: "off",
  models: {
    asr: { state: "ready" },
    cleanup: { state: "ready" },
    transform: { state: "installed" },
  },
  settings: DEFAULT_SETTINGS,
  account: { kind: "signedOut" },
  meetingNotices: [],
};

(window as { voice?: HubApi }).voice = {
  getSnapshot: () => Promise.reject(new Error("not needed")),
  ...fakeMeetingsMain(sampleMeetings()).api,
  watchMeetingPermissions: async () => {},
  getInsights: async () => EMPTY_INSIGHTS,
  onInsights: () => () => {},
  getInstalledApps: async () => [],
} as Partial<HubApi> as HubApi;

// Each view as it looks with content, so every control its help points at can render.
const views: Record<"meetings" | "insights", ReactNode> = {
  meetings: (
    <Meetings snapshot={snapshot} settings={{ open: false, setOpen: () => {} }} sidebar={null} />
  ),
  insights: <Insights assignments={[]} />,
};

describe("help anchors", () => {
  test.each(Object.entries(views))("every %s help item points at a control", async (page, view) => {
    const help = viewHelp[page as keyof typeof views];
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(view));
    await act(async () => {});
    const missing = help.items
      .map(({ anchor }) => anchor)
      .filter((anchor) => !document.querySelector(`[data-help="${anchor}"]`));
    expect(missing).toEqual([]);
  });
});
