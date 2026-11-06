// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import type { MeetingBanner, MeetingId } from "../shared/meetings.ts";
import { RestartNotice } from "./RestartNotice.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const notice: MeetingBanner = {
  key: 7,
  id: "00000000-0000-4000-8000-000000000001" as MeetingId,
  text: "A meeting is in progress, so Voice did not restart.",
  actions: [],
  dismissable: true,
};

let root: Root | null = null;

async function render(banner: MeetingBanner | null) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<RestartNotice notice={banner} />));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});

describe("restart notice", () => {
  test("shows nothing without a notice", async () => {
    expect((await render(null)).textContent).toBe("");
  });

  test("states the notice as plain status text, not as a failure", async () => {
    const host = await render(notice);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(notice.text);
    expect(host.textContent).not.toContain("Update failed");
  });

  test("stays when focus moves away", async () => {
    const host = await render(notice);
    const button = host.querySelector("button");
    await act(async () => {
      button?.focus();
      button?.blur();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    });
    expect(host.textContent).toContain(notice.text);
  });

  test("Dismiss hands the notice back to main", async () => {
    const dismissMeetingNotice = vi.fn(async () => {});
    (window as unknown as { voice: unknown }).voice = {
      getSnapshot: vi.fn(),
      dismissMeetingNotice,
    };
    const host = await render(notice);
    await act(async () => host.querySelector("button")?.click());
    expect(dismissMeetingNotice).toHaveBeenCalledWith(notice.key);
  });
});
