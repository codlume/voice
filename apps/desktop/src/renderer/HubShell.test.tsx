// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import * as NodePath from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { DEFAULT_SETTINGS, type Snapshot } from "../shared/api.ts";
import type { HistoryState } from "../shared/history.ts";
import { EMPTY_INSIGHTS } from "../shared/insights.ts";
import {
  DEFAULT_MEETINGS_SETTINGS,
  type MeetingBanner,
  type MeetingId,
} from "../shared/meetings.ts";
import { HubShell } from "./HubShell.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const text = "A meeting is in progress, so Voice did not restart.";
const notice: MeetingBanner = {
  key: 3,
  id: "00000000-0000-4000-8000-000000000001" as MeetingId,
  text,
  actions: [],
  dismissable: true,
};
const history: HistoryState = { entries: [], retention: "memory", saveFailed: false };

const snapshot = (restartNotice: MeetingBanner | null): Snapshot => ({
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
  restartNotice,
});

let root: Root | null = null;

beforeEach(() => {
  const replies: Record<string, unknown> = {
    getInsights: EMPTY_INSIGHTS,
    getInstalledApps: [],
    getAppIcons: {},
  };
  const api = new Proxy(
    { getSnapshot: vi.fn() },
    {
      get: (target, name: string) => {
        if (name in target) return target[name as keyof typeof target];
        if (name.startsWith("on")) return () => () => {};
        return async () =>
          replies[name] ?? { meetings: [], folders: [], settings: DEFAULT_MEETINGS_SETTINGS };
      },
    },
  );
  (window as unknown as { voice: unknown }).voice = api;
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function render(banner: MeetingBanner | null) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<HubShell snapshot={snapshot(banner)} history={history} />));
  return host;
}

const noticeNode = () =>
  [...document.querySelectorAll('[role="status"]')].find((node) => node.textContent === text);
const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (node) => node.getAttribute("aria-label") === name || node.textContent === name,
  );

describe("the restart notice in the Voice window", () => {
  test("takes its own row beside main, so it can never sit over a page", async () => {
    await render(notice);
    const main = document.querySelector("main");
    const card = noticeNode()?.parentElement;
    expect(main?.contains(noticeNode() ?? null)).toBe(false);
    expect(card?.parentElement).toBe(main?.parentElement);
    expect(card?.previousElementSibling).toBe(main);
  });

  test("does not float, because a floating bar hides what scrolls under it", () => {
    const source = readFileSync(NodePath.join(import.meta.dirname, "RestartNotice.tsx"), "utf8");
    expect(source).not.toMatch(/position:\s*"(fixed|absolute|sticky)"/);
    expect(source).toMatch(/gridRow: "3"/);
  });

  test("stays on every page and with the sidebar collapsed", async () => {
    await render(notice);
    for (const page of ["Meetings, Beta", "Insights", "Style", "Transforms", "Snippets"]) {
      await act(async () => button(page)?.click());
      expect(noticeNode()).toBeDefined();
    }
    await act(async () => button("Collapse sidebar")?.click());
    expect(noticeNode()).toBeDefined();
  });

  test("leaves no row behind without a notice", async () => {
    await render(null);
    expect(noticeNode()).toBeUndefined();
    expect(document.querySelector("main")?.nextElementSibling).toBeNull();
  });
});
