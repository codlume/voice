import type { BrowserWindowConstructorOptions, Rectangle, WebPreferences } from "electron";

import type { MeetingId } from "../shared/meetings.ts";

const SIZE = { width: 360, height: 520 };
const MINIMUM = { width: 300, height: 320 };
const MARGIN = 20;
// The smallest visible strip of a saved window that still counts as on screen.
const VISIBLE = 48;

export function parseBounds(raw: unknown): Rectangle | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { x, y, width, height } = raw as Record<string, unknown>;
  const values = [x, y, width, height];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  const bounds = { x, y, width, height } as Rectangle;
  return bounds.width >= MINIMUM.width && bounds.height >= MINIMUM.height ? bounds : null;
}

const overlaps = (a: Rectangle, b: Rectangle) =>
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) >= VISIBLE &&
  Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) >= VISIBLE;

/** Where the user left it, unless that display is gone; else the top right of the main display. */
export function notepadBounds(
  saved: Rectangle | null,
  workAreas: readonly Rectangle[],
  primary: Rectangle,
): Rectangle {
  if (saved && workAreas.some((area) => overlaps(saved, area))) return saved;
  const width = Math.min(SIZE.width, primary.width - 2 * MARGIN);
  const height = Math.min(SIZE.height, primary.height - 2 * MARGIN);
  return { x: primary.x + primary.width - width - MARGIN, y: primary.y + MARGIN, width, height };
}

export function notepadWindowOptions(
  bounds: Rectangle,
  webPreferences: WebPreferences,
  dark: boolean,
): BrowserWindowConstructorOptions {
  return {
    ...bounds,
    minWidth: MINIMUM.width,
    minHeight: MINIMUM.height,
    // A panel floats over full-screen apps and joins every Space, like the Flow Bar.
    type: "panel",
    // Shown with showInactive once painted; a shown window would take focus.
    show: false,
    title: "Meeting notepad",
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 14, y: 14 },
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Repeats color.background as hex, like the hub, so the first frame does not flash.
    backgroundColor: dark ? "#0a0a0a" : "#fdfdfd",
    webPreferences,
  };
}

export type NotepadWindow = {
  isDestroyed(): boolean;
  showInactive(): void;
  /** Shows the window and makes it key. */
  show(): void;
  close(): void;
  getBounds(): Rectangle;
  setAlwaysOnTop(flag: boolean, level: "floating"): void;
  once(event: "ready-to-show", listener: () => void): unknown;
  on(event: "moved" | "resized" | "close" | "closed", listener: () => void): unknown;
  readonly webContents: { send(channel: string, value: unknown): void };
};

export type NotepadDeps = {
  /** Makes the window and loads its page; the controller shows it. */
  create: (options: BrowserWindowConstructorOptions) => NotepadWindow;
  webPreferences: WebPreferences;
  dark: () => boolean;
  workAreas: () => { all: readonly Rectangle[]; primary: Rectangle };
  saved: Rectangle | null;
  save: (bounds: Rectangle) => void;
};

/**
 * `inactive` leaves focus where the user is typing: a meeting that starts or asks a question
 * brings the notepad up beside their app. `focused` answers a click on the notepad's own button.
 */
export type NotepadOpening = "inactive" | "focused";

export type Notepad = {
  /** Shows the notepad for `id`, making the window if it is closed. */
  open(id: MeetingId, opening: NotepadOpening): void;
  /** The meeting the open notepad shows; null while it is closed. */
  meetingId(): MeetingId | null;
  send(channel: string, value: unknown): void;
  close(): void;
};

/** One floating notepad. Closing it only closes the window; the meeting keeps recording. */
export function createNotepad(deps: NotepadDeps): Notepad {
  let window: NotepadWindow | null = null;
  let id: MeetingId | null = null;
  let saved = deps.saved;
  const open = () => (window && !window.isDestroyed() ? window : null);

  function remember(target: NotepadWindow) {
    if (target.isDestroyed()) return;
    saved = target.getBounds();
    deps.save(saved);
  }

  return {
    open(next, opening) {
      id = next;
      const show = (target: NotepadWindow) =>
        opening === "focused" ? target.show() : target.showInactive();
      const current = open();
      if (current) {
        show(current);
        return;
      }
      const { all, primary } = deps.workAreas();
      const created = deps.create(
        notepadWindowOptions(notepadBounds(saved, all, primary), deps.webPreferences, deps.dark()),
      );
      window = created;
      created.setAlwaysOnTop(true, "floating");
      created.once("ready-to-show", () => {
        if (!created.isDestroyed()) show(created);
      });
      created.on("moved", () => remember(created));
      created.on("resized", () => remember(created));
      created.on("close", () => remember(created));
      created.on("closed", () => {
        if (window !== created) return;
        window = null;
        id = null;
      });
    },
    meetingId: () => (open() ? id : null),
    send(channel, value) {
      open()?.webContents.send(channel, value);
    },
    close() {
      open()?.close();
    },
  };
}
