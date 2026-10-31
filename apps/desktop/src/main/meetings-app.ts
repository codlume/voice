import { readFileSync } from "node:fs";
import * as NodePath from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  BrowserWindow,
  nativeTheme,
  powerMonitor,
  screen,
  type MenuItemConstructorOptions,
  type WebPreferences,
} from "electron";

import { Channel, type NotepadApi } from "../shared/api.ts";
import {
  meetingToggle,
  parseMeetingId,
  meetingToggleLabels,
  type MeetingId,
  type MeetingToggle,
  type NotepadState,
} from "../shared/meetings.ts";
import { writeFileAtomic } from "./atomic-file.ts";
import type { Log } from "./diagnostics-scrub.ts";
import { registerMeetingControls } from "./hub-commands.ts";
import type { Commands } from "./ipc.ts";
import { dismiss, follow, promptFor, raise } from "./meeting-focus.ts";
import { createMeetingRecorder, type MeetingRecorder } from "./meeting-recorder.ts";
import { createMeetingSummarizer } from "./meeting-summary.ts";
import { createMeetingsStore, type MeetingsStore } from "./meetings-store.ts";
import { createNotepad, parseBounds, type NotepadOpening } from "./notepad-window.ts";
import type { HelperCommand, HelperEvent } from "./protocol.ts";
import type { AppState, Store } from "./store.ts";
import type { TransformModel } from "./transform-model.ts";

export type MeetingsAppDeps = {
  userData: string;
  store: Store;
  send: (command: HelperCommand) => boolean;
  transformModel: TransformModel;
  /** The Voice window while it exists. */
  hub: () => BrowserWindow | undefined;
  /** Brings the Voice window up on a meeting's summary; `activate: false` leaves focus where it is. */
  showMeeting: (id: MeetingId, options: { activate: boolean }) => void;
  refreshTray: () => void;
  notepadWindow: { webPreferences: WebPreferences; load: (window: BrowserWindow) => void };
  log: Log;
};

/** Meetings in the main process: the store, the recorder, the notepad, and their entry points. */
export type MeetingsApp = {
  store: MeetingsStore;
  recorder: MeetingRecorder;
  onHelperEvent(event: HelperEvent): void;
  helperExited(): void;
  /** The menu bar item that starts or stops a meeting. */
  trayItem(): MenuItemConstructorOptions;
  /** Shows the notepad for the current meeting, taking focus. */
  openNotepad(): void;
  /** Follows a change of `AppState.meeting`: brings up the notepad when a meeting asks for it. */
  focusChanged(state: AppState, previous: AppState): void;
  /** Stops summaries without writing anything, before the model they run on is disposed. */
  dispose(): void;
  settled(): Promise<void>;
};

export function createMeetingsApp(deps: MeetingsAppDeps): MeetingsApp {
  const { store, log } = deps;
  const dir = NodePath.join(deps.userData, "meetings");
  const toHub = (channel: (typeof Channel)[keyof typeof Channel], payload: unknown) => {
    const hub = deps.hub();
    if (hub && !hub.isDestroyed()) hub.webContents.send(channel, payload);
  };

  // The tray names what its meeting item does, so it is rebuilt when that changes.
  let trayMeeting: MeetingToggle["kind"] = "start";
  const meetings = createMeetingsStore({
    dir,
    log,
    onChange: (change) => {
      toHub(Channel.meetings, change);
      store.update((s) => ({ ...s, meeting: follow(s.meeting, meetings.state().meetings) }));
      syncNotepad();
      const next = meetingToggle(meetings.state().meetings).kind;
      if (next === trayMeeting) return;
      trayMeeting = next;
      deps.refreshTray();
    },
  });
  const recorder = createMeetingRecorder({
    store: meetings,
    summarizer: createMeetingSummarizer({ store: meetings, model: deps.transformModel, log }),
    dir,
    send: deps.send,
    capture: () => ({
      language: store.state.settings.dictationLanguage,
      microphone: store.state.settings.microphone,
    }),
    onTranscript: (id, entries) => {
      toHub(Channel.meetingTranscript, { id, entries });
      if (notepad.meetingId() === id) notepad.send(Channel.meetingTranscript, { id, entries });
    },
    onPartial: (partial) => {
      toHub(Channel.meetingPartial, partial);
      if (notepad.meetingId() === partial.id) notepad.send(Channel.meetingPartial, partial);
    },
    onNotice: (id, notice) => {
      log(`meetings: ${id} notice ${notice.kind}`);
      store.update((s) => ({ ...s, meeting: raise(s.meeting, id, notice, Date.now()) }));
      if (notice.kind === "summaryReady" && notice.open) deps.showMeeting(id, { activate: false });
    },
    log,
  });

  const boundsFile = NodePath.join(deps.userData, "notepad.json");
  const notepad = createNotepad({
    create: (options) => {
      const window = new BrowserWindow(options);
      const commands: Commands<NotepadApi> = window.webContents.ipc;
      registerMeetingControls(commands, { meetings, meetingRecorder: recorder, log });
      commands.handle(Channel.getNotepad, notepadState);
      commands.handle(Channel.viewMeetingSummary, (_event, raw: unknown) => {
        const id = parseMeetingId(raw);
        if (id && meetings.get(id)) deps.showMeeting(id, { activate: true });
      });
      commands.handle(Channel.dismissMeetingPrompt, () => {
        // Dismissing "Still in a meeting?" answers it: the meeting goes on.
        const { raised } = store.state.meeting;
        if (raised?.prompt.kind === "silence") recorder.keepRecording(raised.id);
        store.update((s) => ({ ...s, meeting: dismiss(s.meeting) }));
      });
      deps.notepadWindow.load(window);
      return window;
    },
    webPreferences: deps.notepadWindow.webPreferences,
    dark: () => nativeTheme.shouldUseDarkColors,
    workAreas: () => ({
      all: screen.getAllDisplays().map(({ workArea }) => workArea),
      primary: screen.getPrimaryDisplay().workArea,
    }),
    saved: readBounds(boundsFile),
    save: (bounds) => {
      writeFileAtomic(boundsFile, JSON.stringify(bounds), { mode: 0o600 }).catch((error: unknown) =>
        log(`notepad: saving its place failed (${String(error)})`),
      );
    },
  });

  function notepadState(): NotepadState | null {
    const id = notepad.meetingId();
    const meeting = id && meetings.get(id);
    return meeting ? { meeting, prompt: promptFor(meeting, store.state.meeting) } : null;
  }
  let sentNotepad: NotepadState | null = null;
  function syncNotepad() {
    if (notepad.meetingId() === null) return;
    const next = notepadState();
    // A discarded meeting leaves nothing to show.
    if (next === null) {
      notepad.close();
      return;
    }
    if (isDeepStrictEqual(next, sentNotepad)) return;
    sentNotepad = next;
    notepad.send(Channel.notepad, next);
  }
  function openNotepad(
    opening: NotepadOpening,
    id: MeetingId | null = store.state.meeting.current?.id ?? null,
  ) {
    const target = id ?? notepad.meetingId();
    if (!target) return;
    notepad.open(target, opening);
    sentNotepad = null;
    syncNotepad();
  }

  function toggle(from: "shortcut" | "tray") {
    recorder.toggle().then(
      (result) => {
        if (result.kind === "refused") log(`meetings: ${from} toggle refused (${result.message})`);
      },
      (error) => log(`meetings: ${from} toggle failed (${String(error)})`),
    );
  }

  // A launch only ever finishes what a crash or quit left; it never records.
  recorder.recover().catch((error) => log(`meetings: recovery failed (${String(error)})`));
  // Audio a failed final pass kept is still on disk after a relaunch, and so is its notice.
  void meetings.loaded().then(() => {
    for (const { id, finalPassFailed } of meetings.state().meetings) {
      if (!finalPassFailed) continue;
      const notice = { kind: "finalPassFailed" } as const;
      store.update((s) => ({ ...s, meeting: raise(s.meeting, id, notice, Date.now()) }));
    }
  });
  // The expiry timer counts awake time only, so a window that ended during sleep ends on wake.
  powerMonitor.on("resume", () => {
    meetings.expire().catch((error) => log(`meetings: expiry failed (${String(error)})`));
  });

  return {
    store: meetings,
    recorder,
    onHelperEvent(event) {
      // A press the helper caught before it heard the shortcut was turned off changes nothing.
      if (event.type === "meeting.shortcut" && store.state.settings.meetingShortcut !== null) {
        toggle("shortcut");
      }
      if (event.type === "meeting.models.status") {
        const speakerModel = event.state;
        store.update((s) => (s.speakerModel === speakerModel ? s : { ...s, speakerModel }));
      }
      recorder.onHelperEvent(event);
    },
    helperExited: recorder.helperExited,
    trayItem: () => ({
      id: "meeting",
      label: meetingToggleLabels[trayMeeting],
      enabled: trayMeeting !== "wait",
      click: () => toggle("tray"),
    }),
    openNotepad: () => openNotepad("focused"),
    // A new meeting brings up the notepad, and so does a question the user has to answer.
    focusChanged(state, previous) {
      const { current } = state.meeting;
      const started = current && current.id !== previous.meeting.current?.id;
      const prompt = current && promptFor(current, state.meeting);
      const before =
        previous.meeting.current && promptFor(previous.meeting.current, previous.meeting);
      const asks = prompt && prompt.kind !== "notice" && prompt.kind !== before?.kind;
      if (current && (asks || (started && current.status.kind === "starting"))) {
        openNotepad("inactive", current.id);
      } else {
        syncNotepad();
      }
    },
    dispose: recorder.dispose,
    settled: () => recorder.settled().then(meetings.settled),
  };
}

function readBounds(file: string) {
  try {
    return parseBounds(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}
