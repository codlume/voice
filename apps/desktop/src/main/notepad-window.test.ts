import type { BrowserWindowConstructorOptions, Rectangle } from "electron";
import { describe, expect, test } from "vite-plus/test";

import type { MeetingId } from "../shared/meetings.ts";
import {
  createNotepad,
  notepadBounds,
  parseBounds,
  type NotepadDeps,
  type NotepadWindow,
} from "./notepad-window.ts";

const first = "00000000-0000-4000-8000-000000000001" as MeetingId;
const second = "00000000-0000-4000-8000-000000000002" as MeetingId;
const display = { x: 0, y: 0, width: 1440, height: 875 };

function fakeWindow(options: BrowserWindowConstructorOptions) {
  const calls: string[] = [];
  const handlers = new Map<string, () => void>();
  let destroyed = false;
  let bounds: Rectangle = {
    x: options.x ?? 0,
    y: options.y ?? 0,
    width: options.width ?? 0,
    height: options.height ?? 0,
  };
  const window: NotepadWindow & { focus(): void; blur(): void } = {
    isDestroyed: () => destroyed,
    showInactive: () => calls.push("showInactive"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
    blur: () => calls.push("blur"),
    close: () => {
      handlers.get("close")?.();
      destroyed = true;
      handlers.get("closed")?.();
    },
    getBounds: () => bounds,
    setAlwaysOnTop: (flag, level) => calls.push(`alwaysOnTop ${flag} ${level}`),
    once: (event, listener) => handlers.set(event, listener),
    on: (event, listener) => handlers.set(event, listener),
    webContents: { send: (channel) => calls.push(`send ${channel}`) },
  };
  return {
    window,
    calls,
    options,
    emit: (event: string) => handlers.get(event)?.(),
    moveTo: (next: Rectangle) => {
      bounds = next;
      handlers.get("moved")?.();
    },
  };
}

function harness(saved: Rectangle | null = null) {
  const made: ReturnType<typeof fakeWindow>[] = [];
  const stored: Rectangle[] = [];
  const deps: NotepadDeps = {
    create: (options) => {
      const fake = fakeWindow(options);
      made.push(fake);
      return fake.window;
    },
    webPreferences: { preload: "notepad-preload.cjs" },
    dark: () => false,
    workAreas: () => ({ all: [display], primary: display }),
    saved,
    save: (bounds) => stored.push(bounds),
  };
  return { notepad: createNotepad(deps), made, stored };
}

describe("the notepad window", () => {
  test("appears without taking focus from the app the user is typing in", () => {
    const { notepad, made } = harness();
    notepad.open(first, "inactive");
    const [fake] = made;
    // A non-activating panel, made hidden and shown inactive once painted.
    expect(fake?.options).toMatchObject({ type: "panel", show: false });
    expect(fake?.calls).toEqual(["alwaysOnTop true floating"]);
    fake?.emit("ready-to-show");
    notepad.open(first, "inactive");
    expect(fake?.calls).toEqual(["alwaysOnTop true floating", "showInactive", "showInactive"]);
  });

  test("takes focus only when the user asked for the notepad", () => {
    const { notepad, made } = harness();
    notepad.open(first, "focused");
    made[0]?.emit("ready-to-show");
    notepad.open(first, "inactive");
    expect(made[0]?.calls).toEqual(["alwaysOnTop true floating", "show", "showInactive"]);
  });

  test("keeps one window, which follows the meeting it was last opened for", () => {
    const { notepad, made } = harness();
    notepad.open(first, "inactive");
    notepad.open(second, "inactive");
    expect(made).toHaveLength(1);
    expect(notepad.meetingId()).toBe(second);
  });

  test("closing it forgets the meeting, and opening again makes a new window", () => {
    const { notepad, made } = harness();
    notepad.open(first, "inactive");
    notepad.close();
    expect(notepad.meetingId()).toBeNull();
    notepad.send("voice:notepad", null);
    expect(made[0]?.calls).not.toContain("send voice:notepad");
    notepad.open(first, "inactive");
    expect(made).toHaveLength(2);
  });

  test("opens where the user last moved it", () => {
    const { notepad, made, stored } = harness();
    notepad.open(first, "inactive");
    const moved = { x: 100, y: 200, width: 380, height: 500 };
    made[0]?.moveTo(moved);
    expect(stored).toEqual([moved]);
    notepad.close();
    notepad.open(first, "inactive");
    expect(made[1]?.options).toMatchObject(moved);
  });
});

describe("notepadBounds", () => {
  test("starts at the top right of the main display", () => {
    expect(notepadBounds(null, [display], display)).toEqual({
      x: 1440 - 360 - 20,
      y: 20,
      width: 360,
      height: 520,
    });
  });

  test("keeps a saved place on a connected display and drops one on a display that is gone", () => {
    const saved = { x: 100, y: 100, width: 360, height: 520 };
    expect(notepadBounds(saved, [display], display)).toEqual(saved);
    const elsewhere = { x: 3000, y: 100, width: 360, height: 520 };
    expect(notepadBounds(elsewhere, [display], display).x).toBe(1060);
  });

  test("reads only whole, usable bounds from disk", () => {
    expect(parseBounds({ x: 1, y: 2, width: 360, height: 520 })).toEqual({
      x: 1,
      y: 2,
      width: 360,
      height: 520,
    });
    expect(parseBounds({ x: 1, y: 2, width: 10, height: 520 })).toBeNull();
    expect(parseBounds({ x: "1", y: 2, width: 360, height: 520 })).toBeNull();
    expect(parseBounds(null)).toBeNull();
  });
});
