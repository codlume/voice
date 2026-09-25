import { createRoot } from "react-dom/client";

import type { Outcome, PillState, Snapshot, VoiceApi } from "../shared/api.ts";
import "./style.css";
import { HubShell } from "./HubShell.tsx";
import { PillCapsule } from "./PillCapsule.tsx";
import { useSnapshot } from "./useSnapshot.ts";

const base: Snapshot = {
  session: { kind: "idle" },
  permissions: { microphone: "notDetermined", accessibility: "notDetermined" },
  models: { asr: { state: "missing" }, cleanup: { state: "missing" } },
  settings: {
    hotkey: "fn",
    cleanup: { enabled: true, styling: "semi-formal", structure: "prose", context: "general" },
  },
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
  empty: done({ kind: "empty" }),
  tooShort: done({ kind: "tooShort" }),
  focusChanged: done({ kind: "notInserted", reason: "focusChanged" }),
  secureInput: done({ kind: "notInserted", reason: "secureInput" }),
  noModel: done({ kind: "failed", message: "Set up the speech model in Voice first" }),
  longFailure: done({
    kind: "failed",
    message: "The speech model stopped unexpectedly while transcribing this recording",
  }),
  cancelled: done({ kind: "cancelled" }),
};

const hubScenes: Record<string, Snapshot> = {
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
          cleanup: { ...snapshot.settings.cleanup, ...patch.cleanup },
        },
      });
    },
    requestPermission: async (kind) => {
      set({ ...snapshot, permissions: { ...snapshot.permissions, [kind]: "granted" } });
    },
    setupModels: async () => {
      let progress = 0;
      const timer = setInterval(() => {
        progress = Math.min(1, progress + 0.07);
        const model =
          progress < 1 ? { state: "downloading" as const, progress } : { state: "ready" as const };
        set({ ...snapshot, models: { asr: model, cleanup: model } });
        if (progress >= 1) clearInterval(timer);
      }, 200);
    },
    copyLast: async (which) => {
      console.info("copyLast", which);
    },
  };
}

function PillPreview() {
  const snapshot = useSnapshot();
  return snapshot ? <PillCapsule session={snapshot.session} /> : null;
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
            <PillCapsule session={session} />
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
