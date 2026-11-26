// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { PillApi, PillSnapshot, PillState } from "../shared/api.ts";
import { PillCapsule } from "./PillCapsule.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  (window as { voice?: PillApi }).voice = {
    getPillSnapshot: vi.fn(),
    onLevel: () => () => {},
    setPillClickable: async () => {},
    openNotepad: async () => {},
    allowPermission: vi.fn(async () => {}),
  } as Partial<PillApi> as PillApi;
  host = document.createElement("div");
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
});

const spoken = (session: PillState) => {
  act(() => root.render(<PillCapsule session={session} alwaysShowPill meeting={null} />));
  return host.querySelector("[role=status]")?.textContent;
};

describe("Flow Bar status for a screen reader", () => {
  test("says Listening only while capture is active", () => {
    expect(spoken({ kind: "idle" })).toBe("");
    expect(spoken({ kind: "listening" })).toBe("Listening");
    expect(spoken({ kind: "processing", overdue: false })).not.toContain("Listening");
  });

  test("names the work in progress", () => {
    expect(spoken({ kind: "processing", overdue: false })).toBe("Transcribing");
    expect(spoken({ kind: "transforming", loading: false })).toBe("Transforming");
  });

  test("announces only the new look while the old one fades out", () => {
    spoken({ kind: "listening" });
    expect(spoken({ kind: "processing", overdue: false })).toBe("Transcribing");
    const hidden = [...host.querySelectorAll("[aria-hidden=true]")].map((node) => node.textContent);
    expect(hidden).toContain("Listening");
  });
});

const show = (snapshot: PillSnapshot) => {
  act(() => root.render(<PillCapsule {...snapshot} />));
  return host.querySelector("[role=status]")?.textContent;
};
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("the Flow Bar meeting clock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("is right on the first frame after a dictation mid-meeting", () => {
    const since = Date.now();
    const during = (session: PillState): PillSnapshot => ({
      session,
      alwaysShowPill: true,
      meeting: { status: { kind: "recording", since }, closedMs: 0, prompt: null },
    });
    show(during({ kind: "idle" }));
    wait(60_000);
    show(during({ kind: "listening" }));
    wait(30_000);
    expect(show(during({ kind: "idle" }))).toBe("01:30");
  });

  test("counts down from the right time on its first frame", () => {
    show({ session: { kind: "idle" }, alwaysShowPill: true, meeting: null });
    wait(3 * 3_600_000);
    const prompt = { kind: "maxLengthSoon", endsAt: Date.now() + 5 * 60_000 } as const;
    expect(
      show({
        session: { kind: "idle" },
        alwaysShowPill: true,
        meeting: { status: { kind: "paused" }, closedMs: 0, prompt },
      }),
    ).toBe("Recording ends in 5 min");
  });
});

describe("Flow Bar when the microphone is refused", () => {
  test("names the fix, and a click asks main to allow the microphone", () => {
    const session: PillState = {
      kind: "done",
      outcome: { kind: "permissionMissing", permission: "microphone" },
    };
    expect(spoken(session)).toBe("Microphone is off. Click to allow");
    const button = host.querySelector<HTMLButtonElement>("[role=status] button");
    act(() => button?.click());
    const voice = (window as { voice?: PillApi }).voice;
    expect(voice?.allowPermission).toHaveBeenCalledWith("microphone");
  });
});
