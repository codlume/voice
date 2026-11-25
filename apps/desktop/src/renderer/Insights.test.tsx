// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";

import type { HubApi } from "../shared/api.ts";
import { parseBundleId } from "../shared/app-categories.ts";
import { dayKey, EMPTY_INSIGHTS, type Insights as InsightsData } from "../shared/insights.ts";
import { Insights } from "./Insights.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

const mail = parseBundleId("com.apple.mail")!;
const counted: InsightsData = {
  ...EMPTY_INSIGHTS,
  days: { [dayKey(new Date())]: 120 },
  recent: [{ words: 120, ms: 40_000 }],
  categories: { ...EMPTY_INSIGHTS.categories, email: { words: 120, sessions: 3 } },
  apps: { [mail]: 120 },
};

async function show(insights: InsightsData) {
  (window as { voice?: HubApi }).voice = {
    getSnapshot: () => new Promise(() => {}),
    getInsights: async () => insights,
    onInsights: () => () => {},
    getInstalledApps: async () => [],
  } as Partial<HubApi> as HubApi;
  await act(async () => root.render(<Insights assignments={[]} />));
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

test("before the first dictation the page points to Home", async () => {
  await show(EMPTY_INSIGHTS);
  expect(host.textContent).toContain(
    "Dictate in any app, or in Try it on Home, to start counting.",
  );
  expect(host.textContent).toContain("Dictate to see how fast you speak.");
  expect(host.textContent).toContain("Dictate into an app to see where your words go.");
});

test("once something is counted the Home pointer goes away", async () => {
  await show(counted);
  expect(host.textContent).not.toContain("Try it on Home");
  expect(host.textContent).toContain("WPM");
});

test("an info button opens its explanation on click", async () => {
  await show(counted);
  const info = host.querySelector<HTMLButtonElement>('button[aria-label="About Pace"]');
  expect(info?.getAttribute("aria-description")).toMatch(/^Your pace over your last 1 dictation/);
  await act(async () => info?.click());
  const popup = document.body.querySelector('[role="dialog"]');
  expect(popup?.textContent).toContain("Pace");
  expect(popup?.textContent).toContain("The average typist does");
});

test("usage bars show each category's share without extra announcements", async () => {
  await show(counted);
  const email = [...host.querySelectorAll("li")].find((row) =>
    row.textContent?.startsWith("Email"),
  );
  expect(email?.textContent).toContain("100%");
  expect(email?.textContent).toContain("3 dictations");
  const bars = [...host.querySelectorAll('[role="progressbar"]')];
  expect(bars).toHaveLength(4);
  expect(bars.every((bar) => bar.closest('[aria-hidden="true"]'))).toBe(true);
});
