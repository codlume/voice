import { createRoot } from "react-dom/client";

import type {
  ModelStatus,
  Outcome,
  PillState,
  Snapshot,
  UpdateStatus,
  VoiceApi,
} from "../shared/api.ts";
import "./style.css";
import { HubShell } from "./HubShell.tsx";
import { PillCapsule } from "./PillCapsule.tsx";
import { useSnapshot } from "./useSnapshot.ts";

const base: Snapshot = {
  updates: {
    version: "1.4.2",
    installedChannel: "stable",
    channel: "stable",
    status: { kind: "idle" },
  },
  session: { kind: "idle" },
  permissions: { microphone: "notDetermined", accessibility: "notDetermined" },
  loginItem: "off",
  models: { asr: { state: "missing" }, cleanup: { state: "missing" } },
  settings: {
    hotkey: "fn",
    updateChannel: "stable",
    theme: "system",
    microphone: null,
    muteWhileDictating: false,
    showInDock: true,
    alwaysShowPill: true,
    dictationLanguage: "en",
    cleanup: { enabled: true, styling: "semi-formal" },
    diagnostics: "off",
  },
  microphones: {
    kind: "ready",
    devices: [
      { uid: "builtin", name: "MacBook Pro Microphone" },
      { uid: "usb", name: "USB Microphone" },
    ],
    defaultUid: "builtin",
  },
  microphoneTest: { kind: "off" },
  last: null,
};

const ready: Snapshot = {
  ...base,
  permissions: { microphone: "granted", accessibility: "granted" },
  models: { asr: { state: "ready" }, cleanup: { state: "ready" } },
  last: {
    raw: "um so I think we should uh push the launch to Friday because the the QA pass isn't done yet",
    text: "I think we should push the launch to Friday because the QA pass isn't done yet.",
  },
};

const done = (outcome: Outcome): PillState => ({ kind: "done", outcome });

const pillScenes: Record<string, PillState> = {
  idle: { kind: "idle" },
  listening: { kind: "listening" },
  processing: { kind: "processing" },
  inserted: done({ kind: "inserted", method: "accessibility" }),
  pasted: done({ kind: "inserted", method: "paste" }),
  empty: done({ kind: "empty" }),
  tooShort: done({ kind: "tooShort" }),
  focusChanged: done({ kind: "notInserted", reason: "focusChanged" }),
  secureInput: done({ kind: "notInserted", reason: "secureInput" }),
  noModel: done({ kind: "failed", message: "Set up the speech model in Voice first" }),
  longFailure: done({
    kind: "failed",
    message: "The speech model stopped unexpectedly while transcribing this recording",
  }),
};

const releaseNotes = [
  "feat(desktop): add keyboard shortcuts and a Shortcuts settings page by @mhadrys in #119",
  "feat(desktop): add a Show Flow Bar at all times setting by @mhadrys in #120",
  "feat(desktop): add Open at login and Show in Dock settings by @mhadrys in #118",
  "feat(desktop): add a Data and Privacy settings page by @mhadrys in #117",
  "fix(desktop): keep Voice in Cmd-Tab and the Dock by @mhadrys in #116",
  "feat(desktop): split settings into General and System by @mhadrys in #115",
  "fix(asr): keep the final transcript when the speech model restarts mid-session, so a long dictation is never lost by @mhadrys in #114",
  "fix(insertion): fall back to paste in terminals that reject accessibility writes by @mhadrys in #113",
];

const updateScenes: Record<string, UpdateStatus> = {
  checking: { kind: "checking" },
  current: { kind: "current" },
  downloading: { kind: "downloading", version: "1.5.0", notes: releaseNotes, percent: 48 },
  ready: { kind: "ready", version: "1.5.0", notes: releaseNotes },
  "ready-no-notes": { kind: "ready", version: "1.5.0", notes: [] },
  failed: { kind: "failed", message: "Could not check for updates. Try again." },
  disabled: { kind: "disabled", reason: "Updates are available in packaged builds." },
};

const hubScenes: Record<string, Snapshot> = {
  "microphone-test-failed": {
    ...ready,
    microphoneTest: {
      kind: "failed",
      message: "The microphone test stopped while Voice reconnected. Test again.",
    },
  },
  "microphone-denied": { ...ready, permissions: { ...ready.permissions, microphone: "denied" } },
  "microphone-selected": {
    ...ready,
    settings: { ...ready.settings, microphone: { uid: "usb", name: "USB Microphone" } },
  },
  "microphone-unavailable": {
    ...ready,
    settings: {
      ...ready.settings,
      microphone: { uid: "missing", name: "Studio microphone with a very long device name" },
    },
  },
  "microphone-empty": { ...ready, microphones: { kind: "ready", devices: [], defaultUid: null } },
  "microphone-error": {
    ...ready,
    microphones: {
      kind: "unavailable",
      message: "Could not list microphones. Reopen Voice to try again.",
    },
  },
  fresh: base,
  progress: {
    ...base,
    permissions: { microphone: "granted", accessibility: "denied" },
    models: {
      asr: { state: "downloading", progress: 0.42 },
      cleanup: { state: "failed", message: "Download interrupted. Check your connection." },
    },
  },
  ready,
  "cleanup-off": {
    ...ready,
    models: { asr: { state: "ready" }, cleanup: { state: "installed" } },
    settings: { ...ready.settings, cleanup: { ...ready.settings.cleanup, enabled: false } },
  },
  ...Object.fromEntries(
    Object.entries(updateScenes).map(([name, status]) => [
      name,
      {
        ...ready,
        updates: { ...ready.updates, status },
      },
    ]),
  ),
  "ready-dictating": {
    ...ready,
    session: { kind: "listening" },
    updates: { ...ready.updates, status: { kind: "ready", version: "1.5.0", notes: releaseNotes } },
  },
  nightly: {
    ...ready,
    settings: { ...ready.settings, updateChannel: "nightly" },
    updates: { ...ready.updates, channel: "nightly", status: { kind: "current" } },
  },
};

const cycle: [PillState, number][] = [
  [{ kind: "idle" }, 1200],
  [{ kind: "listening" }, 2600],
  [{ kind: "processing" }, 900],
  [done({ kind: "inserted", method: "accessibility" }), 1300],
  [{ kind: "idle" }, 1500],
  [{ kind: "listening" }, 1800],
  [{ kind: "processing" }, 700],
  [done({ kind: "notInserted", reason: "focusChanged" }), 2500],
];

function fakeVoice(initial: Snapshot, loop: boolean): VoiceApi {
  let snapshot = initial;
  const listeners = new Set<(snapshot: Snapshot) => void>();
  const set = (next: Snapshot) => {
    snapshot = next;
    for (const listener of listeners) listener(snapshot);
  };

  if (loop) {
    let step = 0;
    const advance = () => {
      const [session, ms] = cycle[step % cycle.length]!;
      set({ ...snapshot, session });
      step += 1;
      setTimeout(advance, ms);
    };
    advance();
  }

  return {
    diagnosticsStartedAtLaunch: false,
    checkForUpdates: async () => {
      set({ ...snapshot, updates: { ...snapshot.updates, status: { kind: "checking" } } });
      setTimeout(
        () => set({ ...snapshot, updates: { ...snapshot.updates, status: { kind: "current" } } }),
        500,
      );
    },
    restartForUpdate: async () => {
      if (snapshot.updates.status.kind !== "ready") throw new Error("No update is ready.");
      set({
        ...snapshot,
        updates: {
          ...snapshot.updates,
          status: { kind: "installing", version: snapshot.updates.status.version },
        },
      });
    },
    openRelease: async () => {
      console.info("openRelease");
    },
    getSnapshot: async () => snapshot,
    onSnapshot: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onLevel: (listener) => {
      const start = performance.now();
      const timer = setInterval(() => {
        const t = (performance.now() - start) / 1000;
        const phrase = 0.5 + 0.5 * Math.sin(t * 1.3);
        const syllable = Math.abs(Math.sin(t * 7.1));
        listener(0.08 + 0.8 * phrase * syllable);
      }, 100);
      return () => clearInterval(timer);
    },
    updateSettings: async (patch) => {
      set({
        ...snapshot,
        settings: {
          hotkey: patch.hotkey ?? snapshot.settings.hotkey,
          updateChannel: patch.updateChannel ?? snapshot.settings.updateChannel,
          dictationLanguage: patch.dictationLanguage ?? snapshot.settings.dictationLanguage,
          theme: patch.theme ?? snapshot.settings.theme,
          microphone:
            patch.microphone === undefined ? snapshot.settings.microphone : patch.microphone,
          muteWhileDictating: patch.muteWhileDictating ?? snapshot.settings.muteWhileDictating,
          showInDock: patch.showInDock ?? snapshot.settings.showInDock,
          alwaysShowPill: patch.alwaysShowPill ?? snapshot.settings.alwaysShowPill,
          cleanup: { ...snapshot.settings.cleanup, ...patch.cleanup },
          diagnostics: patch.diagnostics ?? snapshot.settings.diagnostics,
        },
        updates: patch.updateChannel
          ? {
              ...snapshot.updates,
              channel: patch.updateChannel,
              status: { kind: "idle" },
            }
          : snapshot.updates,
      });
    },
    requestPermission: async (kind) => {
      // macOS never prompts again once access is denied.
      if (snapshot.permissions[kind] === "denied") return;
      set({ ...snapshot, permissions: { ...snapshot.permissions, [kind]: "granted" } });
    },
    setOpenAtLogin: async (on) => {
      set({ ...snapshot, loginItem: on ? "on" : "off" });
    },
    startMicrophoneTest: async () => {
      set({ ...snapshot, microphoneTest: { kind: "starting" } });
      setTimeout(() => {
        if (snapshot.microphoneTest.kind === "starting")
          set({ ...snapshot, microphoneTest: { kind: "listening", episode: 1 } });
      }, 300);
    },
    stopMicrophoneTest: async () => {
      set({ ...snapshot, microphoneTest: { kind: "off" } });
    },
    installModel: async (id) => {
      let progress = 0;
      const timer = setInterval(() => {
        progress = Math.min(1, progress + 0.07);
        const model: ModelStatus =
          progress < 1 ? { state: "downloading", progress } : { state: "ready" };
        set({ ...snapshot, models: { ...snapshot.models, [id]: model } });
        if (progress >= 1) clearInterval(timer);
      }, 200);
    },
    uninstallModel: async (id) => {
      set({ ...snapshot, models: { ...snapshot.models, [id]: { state: "missing" } } });
    },
    copyLast: async (which) => {
      console.info("copyLast", which);
    },
  };
}

function PillPreview() {
  const snapshot = useSnapshot();
  return snapshot ? (
    <PillCapsule session={snapshot.session} alwaysShowPill={snapshot.settings.alwaysShowPill} />
  ) : null;
}

function HubPreview() {
  const snapshot = useSnapshot();
  return snapshot ? <HubShell snapshot={snapshot} /> : null;
}

function Gallery() {
  const snapshot = useSnapshot();
  const box = { width: 320, height: 48, background: "#d9dde3", borderRadius: 8 };
  const scenes: [string, PillState][] = [
    ["cycle", snapshot?.session ?? { kind: "idle" }],
    ...Object.entries(pillScenes),
  ];
  return (
    <div style={{ padding: 32, fontFamily: "system-ui", display: "grid", gap: 16 }}>
      <h1 style={{ margin: 0, fontSize: 18 }}>Voice preview</h1>
      <p style={{ margin: 0 }}>
        Hub:{" "}
        {Object.keys(hubScenes).map((name) => (
          <a key={name} href={`?hub=${name}`} style={{ marginRight: 12 }}>
            {name}
          </a>
        ))}
      </p>
      {scenes.map(([name, session]) => (
        <figure key={name} style={{ margin: 0 }}>
          <figcaption style={{ fontSize: 12, marginBottom: 4 }}>
            <a href={`?pill=${name}`}>{name}</a>
          </figcaption>
          <div style={box}>
            <PillCapsule session={session} alwaysShowPill />
          </div>
        </figure>
      ))}
    </div>
  );
}

const params = new URLSearchParams(location.search);
const pill = params.get("pill");
const hub = params.get("hub");
const root = createRoot(document.getElementById("root")!);

if (pill) {
  const session = pillScenes[pill] ?? { kind: "idle" };
  window.voice = fakeVoice({ ...ready, session }, pill === "cycle");
  if (params.get("backdrop") !== "none") document.body.style.background = "#d9dde3";
  root.render(<PillPreview />);
} else if (hub) {
  window.voice = fakeVoice(hubScenes[hub] ?? base, false);
  root.render(<HubPreview />);
} else {
  window.voice = fakeVoice(ready, true);
  root.render(<Gallery />);
}
