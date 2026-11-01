// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { HubApi } from "../shared/api.ts";
import type { HistoryEntry, HistoryState } from "../shared/history.ts";
import { dayKey } from "../shared/insights.ts";
import { History } from "./History.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = Date.now();
const today = dayKey(new Date(now));
const cleaned: HistoryEntry = {
  id: "cleaned",
  at: now - 60_000,
  raw: "um meet anna on thursday",
  text: "Meet Anna on Thursday.",
  status: "inserted",
};
const missed: HistoryEntry = {
  id: "missed",
  at: now - 120_000,
  raw: "Call the dentist.",
  text: "Call the dentist.",
  status: "notInserted",
};
const history: HistoryState = {
  entries: [cleaned, missed],
  retention: "forever",
  saveFailed: false,
};

let root: Root;
let host: HTMLElement;
let api: {
  copyHistoryEntry: ReturnType<typeof vi.fn>;
  deleteHistoryEntry: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  api = { copyHistoryEntry: vi.fn(async () => {}), deleteHistoryEntry: vi.fn(async () => {}) };
  (window as { voice?: HubApi }).voice = {
    getSnapshot: vi.fn(),
    ...api,
  } as Partial<HubApi> as HubApi;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (node: ReactNode) => act(() => root.render(node));
const button = (name: RegExp) => {
  const found = [...host.querySelectorAll("button")].find((b) =>
    name.test(b.getAttribute("aria-label") ?? b.textContent ?? ""),
  );
  if (!found) throw new Error(`no button matching ${name}`);
  return found;
};
const click = (element: Element) =>
  act(async () => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const status = () => host.querySelector('[role="status"]')?.textContent;

describe("History", () => {
  test("copies the cleaned text and says so", async () => {
    await render(<History history={history} today={today} />);
    await click(button(/^Copy dictation .*Meet Anna/));
    expect(api.copyHistoryEntry).toHaveBeenCalledWith("cleaned", "text");
    expect(status()).toBe("Copied");
  });

  test("offers the raw transcript only when cleanup changed it", async () => {
    await render(<History history={history} today={today} />);
    expect(() => button(/^Copy raw transcript .*dentist/)).toThrow();
    await click(button(/^Copy raw transcript .*Meet Anna/));
    expect(api.copyHistoryEntry).toHaveBeenCalledWith("cleaned", "raw");
    expect(status()).toBe("Copied raw transcript");
  });

  test("clicking a row copies its text", async () => {
    await render(<History history={history} today={today} />);
    const row = [...host.querySelectorAll("li")].find((li) => li.textContent?.includes("dentist"));
    await click(row!);
    expect(api.copyHistoryEntry).toHaveBeenCalledWith("missed", "text");
  });

  test("marks a transcript that was not inserted", async () => {
    await render(<History history={history} today={today} />);
    const rows = [...host.querySelectorAll("li")].map((li) => li.textContent ?? "");
    expect(rows.find((text) => text.includes("dentist"))).toContain("Not inserted");
    expect(rows.find((text) => text.includes("Anna"))).not.toContain("Not inserted");
  });

  test("deletes one transcript", async () => {
    await render(<History history={history} today={today} />);
    await click(button(/^Delete dictation .*dentist/));
    expect(api.deleteHistoryEntry).toHaveBeenCalledWith("missed");
  });

  test("a failed copy says so and claims nothing was copied", async () => {
    api.copyHistoryEntry.mockRejectedValueOnce(
      new Error("Error invoking remote method 'voice:copyHistoryEntry': Error: Clipboard is busy."),
    );
    await render(<History history={history} today={today} />);
    await click(button(/^Copy dictation .*Meet Anna/));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Clipboard is busy.");
    expect(status()).toBe("");
  });
});
