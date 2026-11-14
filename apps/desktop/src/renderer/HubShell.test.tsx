// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import * as NodePath from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { DEFAULT_SETTINGS, type Snapshot } from "../shared/api.ts";
import type { HistoryState } from "../shared/history.ts";
import { EMPTY_INSIGHTS } from "../shared/insights.ts";
import type { MeetingBanner, MeetingId, OpenMeetingRequest } from "../shared/meetings.ts";
import { HubShell } from "./HubShell.tsx";
import { fakeMeetingsMain } from "./testing/meetingsFake.ts";
import { sampleMeetings } from "./testing/meetingsFixtures.ts";

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

const source = (name: string) => readFileSync(NodePath.join(import.meta.dirname, name), "utf8");

let root: Root | null = null;
const fixtures = sampleMeetings();
const readyMeeting = fixtures.state.meetings.find(({ status }) => status.kind === "ready")!;
let showMeeting: ((request: OpenMeetingRequest) => void) | null = null;
// What main sends when a summary is ready, or when the user picks View summary outside the hub.
const mainShowsMeeting = (request: OpenMeetingRequest) =>
  act(async () => showMeeting?.({ ...request }));

beforeEach(() => {
  localStorage.clear();
  showMeeting = null;
  const replies: Record<string, unknown> = {
    getInsights: EMPTY_INSIGHTS,
    getInstalledApps: [],
    getAppIcons: {},
    getLastTransform: null,
  };
  const api = new Proxy<Record<string, unknown>>(
    {
      getSnapshot: vi.fn(),
      ...fakeMeetingsMain(fixtures).api,
      onOpenMeeting: (listener: (request: OpenMeetingRequest) => void) => {
        showMeeting = listener;
        return () => {};
      },
    },
    {
      get: (target, name: string) => {
        if (name in target) return target[name];
        if (name.startsWith("on")) return () => () => {};
        return async () => replies[name];
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

async function render(banner: MeetingBanner | null, change: Partial<Snapshot> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(<HubShell snapshot={{ ...snapshot(banner), ...change }} history={history} />),
  );
  return host;
}

const noticeNode = () =>
  [...document.querySelectorAll('[role="status"]')].find((node) => node.textContent === text);
const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (node) => node.getAttribute("aria-label") === name || node.textContent === name,
  );
const click = (name: string) => act(async () => button(name)?.click());
const currentPage = () =>
  document.querySelector('nav[aria-label="Voice"] [aria-current="page"]')?.textContent;
const settingsOpen = () => document.querySelector('nav[aria-label="Settings"]') !== null;
const inMeetingDetail = () => button("All meetings") !== undefined;
const field = (selector: string) =>
  document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);

async function type(selector: string, value: string) {
  const input = field(selector);
  if (input === null) throw new Error(`no field ${selector}`);
  const prototype = Object.getPrototypeOf(input) as object;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the restart notice in the Voice window", () => {
  test("takes its own row beside main, so it can never sit over a page", async () => {
    await render(notice);
    const main = document.querySelector("main");
    const card = noticeNode()?.parentElement;
    expect(main?.contains(noticeNode() ?? null)).toBe(false);
    expect(card?.parentElement).toBe(main?.parentElement);
    expect(card?.previousElementSibling).toBe(main);
  });

  test("does not float, and the shell keeps the row it sits in", () => {
    const noticeSource = source("RestartNotice.tsx");
    expect(noticeSource).not.toMatch(/position:\s*"(fixed|absolute|sticky)"/);
    expect(noticeSource).toMatch(/gridRow: "3"/);
    expect(source("HubShell.tsx")).toMatch(/gridTemplateRows: "auto 1fr auto"/);
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

describe("a meeting main asks the Voice window to show", () => {
  const request = { id: readyMeeting.id, tab: "summary" } as const;
  const dictionaryInput = 'input[aria-label="Word or phrase"]';
  const transformName = 'input[placeholder="Bulleted list"]';

  test("waits while a dictionary entry is being written, then opens once it is cancelled", async () => {
    await render(null);
    await click("Dictionary");
    await click("Add new");
    await type(dictionaryInput, "Worcestershire");
    await mainShowsMeeting(request);
    expect(field(dictionaryInput)?.value).toBe("Worcestershire");
    expect(currentPage()).toBe("Dictionary");

    await click("Cancel");
    expect(currentPage()).toContain("Meetings");
    expect(inMeetingDetail()).toBe(true);
  });

  test("waits while a transform is being written, then opens once it is saved", async () => {
    await render(null);
    await click("Transforms");
    await click("Create");
    await type(transformName, "Haiku");
    await mainShowsMeeting(request);
    expect(field(transformName)?.value).toBe("Haiku");
    expect(currentPage()).toBe("Transforms");

    await type('textarea[placeholder="Turn this text into a short bulleted list."]', "As a haiku.");
    await click("Create transform");
    expect(currentPage()).toContain("Meetings");
    expect(inMeetingDetail()).toBe(true);
  });

  test("waits while a new account name is being typed in Settings", async () => {
    const account = {
      kind: "signedIn",
      name: "Ada Lovelace",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
    } as const;
    await render(null, { account });
    await click("Settings");
    await click("Account");
    await type("#setting-first-name", "Augusta");
    await mainShowsMeeting(request);
    expect(settingsOpen()).toBe(true);
    expect(field("#setting-first-name")?.value).toBe("Augusta");
  });

  test("shows it once, so the meeting does not come back after the user leaves Meetings", async () => {
    await render(null);
    await mainShowsMeeting(request);
    expect(inMeetingDetail()).toBe(true);
    await click("All meetings");
    await click("Home");
    await click("Meetings, Beta");
    expect(currentPage()).toContain("Meetings");
    expect(inMeetingDetail()).toBe(false);

    await click("Home");
    await mainShowsMeeting(request);
    expect(currentPage()).toContain("Meetings");
    expect(inMeetingDetail()).toBe(true);
  });

  test("opens at once when nothing is being written", async () => {
    await render(null);
    await click("Dictionary");
    await mainShowsMeeting(request);
    expect(currentPage()).toContain("Meetings");
    expect(inMeetingDetail()).toBe(true);
  });
});

const expanded = () =>
  document.querySelector('[aria-controls="hub-sidebar"]')?.getAttribute("aria-expanded");
const updateReady = {
  updates: {
    version: "0.0.1",
    installedChannel: "stable",
    channel: "stable",
    status: {
      kind: "ready",
      version: "0.0.2",
      notes: {
        releases: [{ version: "0.0.2", items: ["A note about the release"] }],
        more: false,
      },
    },
  },
} satisfies Partial<Snapshot>;
const openRestartPrompt = async () => {
  const restart = [...document.querySelectorAll("button")].find((node) =>
    node.getAttribute("aria-label")?.startsWith("Restart to install"),
  );
  await act(async () => restart?.click());
  const dialog = document.querySelector('[role="alertdialog"]');
  if (dialog === null) throw new Error("the restart prompt did not open");
  return dialog;
};

describe("the sidebar", () => {
  test("stays as it was when the user clicks the restart prompt's text", async () => {
    await render(null, updateReady);
    expect(expanded()).toBe("true");
    const dialog = await openRestartPrompt();
    await act(async () => dialog.querySelector("h2")?.click());
    expect(expanded()).toBe("true");
  });

  test("stays as it was when the user clicks outside the restart prompt", async () => {
    const host = await render(null, updateReady);
    const dialog = await openRestartPrompt();
    const outside = [...document.body.querySelectorAll<HTMLElement>('[role="presentation"]')].find(
      (node) => !host.contains(node) && !node.contains(dialog),
    );
    expect(outside).toBeDefined();
    await act(async () => outside?.click());
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(expanded()).toBe("true");
  });

  test("still collapses for a click on its own empty space", async () => {
    await render(null);
    await act(async () => document.querySelector("aside")?.click());
    expect(expanded()).toBe("false");
  });
});
