import { createRoot } from "react-dom/client";

import {
  DEFAULT_SETTINGS,
  fullName,
  toPillSnapshot,
  type ModelStatus,
  type Outcome,
  type PillState,
  type Snapshot,
  type HubApi,
  type PillApi,
  type UpdateStatus,
} from "../shared/api.ts";
import type { HistoryEntry, HistoryState, HistoryStatus } from "../shared/history.ts";
import { EMPTY_INSIGHTS, dayKey, type DayKey, type Insights } from "../shared/insights.ts";
import type { ModelId } from "../shared/models.ts";
import "./style.css";
import { HubShell } from "./HubShell.tsx";
import { PillCapsule } from "./PillCapsule.tsx";
import { useHistory } from "./useHistory.ts";
import { usePillSnapshot, useSnapshot } from "./useSnapshot.ts";

const ada = {
  id: "ada-id",
  name: "Ada Lovelace",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
};

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
  settings: DEFAULT_SETTINGS,
  microphones: {
    kind: "ready",
    devices: [
      { uid: "builtin", name: "MacBook Pro Microphone" },
      { uid: "usb", name: "USB Microphone" },
    ],
    defaultUid: "builtin",
  },
  microphoneTest: { kind: "off" },
  account: { kind: "signedOut" },
};

const ready: Snapshot = {
  ...base,
  permissions: { microphone: "granted", accessibility: "granted" },
  models: { asr: { state: "ready" }, cleanup: { state: "ready" } },
};

const historySaved: Snapshot = {
  ...ready,
  settings: { ...ready.settings, historyRetention: "month" },
};

const done = (outcome: Outcome): PillState => ({ kind: "done", outcome });

const pillScenes: Record<string, PillState> = {
  idle: { kind: "idle" },
  listening: { kind: "listening" },
  processing: { kind: "processing", overdue: false },
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
  available: { kind: "available", version: "1.5.0", notes: releaseNotes },
  downloading: { kind: "downloading", version: "1.5.0", notes: releaseNotes, percent: 48 },
  ready: { kind: "ready", version: "1.5.0", notes: releaseNotes },
  "ready-no-notes": { kind: "ready", version: "1.5.0", notes: [] },
  failed: { kind: "failed", message: "Could not check for updates. Try again." },
  disabled: { kind: "disabled", reason: "Updates are available in packaged builds." },
};

// A hub scene is the snapshot main would publish plus the history beside it, which defaults to
// sampleHistory() with saving working.
type HubScene = Snapshot & { history?: readonly HistoryEntry[]; saveFailed?: boolean };

const hubScenes: Record<string, HubScene> = {
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
  fresh: { ...base, history: [] },
  progress: {
    ...base,
    permissions: { microphone: "granted", accessibility: "denied" },
    models: {
      asr: { state: "downloading", progress: 0.42 },
      cleanup: { state: "failed", message: "Download interrupted. Check your connection." },
    },
  },
  "setup-not-ready": {
    ...base,
    permissions: { microphone: "granted", accessibility: "notDetermined" },
    models: { asr: { state: "ready" }, cleanup: { state: "ready" } },
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
  "ready-no-transcript": {
    ...ready,
    history: [],
    updates: { ...ready.updates, status: { kind: "ready", version: "1.5.0", notes: releaseNotes } },
  },
  "ready-not-inserted": {
    ...ready,
    session: done({ kind: "notInserted", reason: "focusChanged" }),
    history: sampleHistory("notInserted"),
    updates: { ...ready.updates, status: { kind: "ready", version: "1.5.0", notes: releaseNotes } },
  },
  "history-empty": { ...ready, history: [] },
  history: ready,
  "history-saved": historySaved,
  "history-long": { ...historySaved, history: longHistory() },
  "history-save-failed": { ...historySaved, saveFailed: true },
  "ready-dictating": {
    ...ready,
    session: { kind: "listening" },
    updates: { ...ready.updates, status: { kind: "ready", version: "1.5.0", notes: releaseNotes } },
  },
  snippets: {
    ...ready,
    settings: {
      ...ready.settings,
      snippets: [
        {
          id: "email",
          trigger: "my email",
          expansion: "ada@example.com",
          expansionHtml: null,
          enabled: true,
        },
        {
          id: "address",
          trigger: "office address",
          expansion: "Analytical Engines Ltd.\n12 Marylebone Road\nLondon NW1 5LR",
          expansionHtml: null,
          enabled: false,
        },
        {
          id: "signoff",
          trigger: "standard sign-off",
          expansion:
            "Thanks for the quick turnaround on this. I will review the draft tomorrow morning and send notes before the 11:00 sync. If anything changes on your side, reply here and I will adjust the plan.",
          expansionHtml:
            "<p>Thanks for the quick turnaround on this. I will review the draft <strong>tomorrow morning</strong> and send notes before the <em>11:00 sync</em>. If anything changes on your side, reply here and I will adjust the plan.</p>",
          enabled: true,
        },
      ],
    },
  },
  dictionary: {
    ...ready,
    settings: {
      ...ready.settings,
      snippets: [
        {
          id: "email",
          trigger: "my email",
          expansion: "ada@example.com",
          expansionHtml: null,
          enabled: true,
        },
      ],
      dictionary: [
        { id: "worcestershire", phrase: "Worcestershire", replacement: null },
        { id: "name", phrase: "Hadryś", replacement: null },
        { id: "btw", phrase: "btw", replacement: "by the way" },
        {
          id: "office",
          phrase: "office hours",
          replacement:
            "Tuesdays and Thursdays from 14:00 to 16:00 in room 4.12, or by appointment over email if neither slot works for you",
        },
      ],
    },
  },
  nightly: {
    ...ready,
    settings: { ...ready.settings, updateChannel: "nightly" },
    updates: { ...ready.updates, channel: "nightly", status: { kind: "current" } },
  },
  "account-signed-out": { ...ready, account: { kind: "signedOut" } },
  "account-signing-in": {
    ...ready,
    account: { kind: "signingIn", purpose: "signIn", phase: "browser" },
  },
  "account-signed-in": {
    ...ready,
    account: { kind: "signedIn", ...ada },
  },
  "account-error": {
    ...ready,
    account: { kind: "error", message: "Sign-in was interrupted." },
  },
  "account-unavailable": {
    ...ready,
    account: {
      kind: "unavailable",
      reason: "Set VOICE_API_URL to sign in from a development build.",
    },
  },
};

const cycle: [PillState, number][] = [
  [{ kind: "idle" }, 1200],
  [{ kind: "listening" }, 2600],
  [{ kind: "processing", overdue: false }, 900],
  [done({ kind: "inserted", method: "accessibility" }), 1300],
  [{ kind: "idle" }, 1500],
  [{ kind: "listening" }, 1800],
  [{ kind: "processing", overdue: false }, 700],
  [done({ kind: "notInserted", reason: "focusChanged" }), 2500],
];

function sampleHistory(newestStatus: HistoryStatus = "inserted"): HistoryEntry[] {
  const today = new Date();
  const at = (daysBack: number, hours: number, minutes: number) =>
    new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() - daysBack,
      hours,
      minutes,
    ).getTime();
  return [
    {
      id: "h1",
      at: Math.min(Date.now(), at(0, 11, 44)),
      raw: "um so I think we should uh push the launch to Friday because the the QA pass isn't done yet",
      text: "I think we should push the launch to Friday because the QA pass isn't done yet.",
      status: newestStatus,
    },
    {
      id: "h2",
      at: Math.min(Date.now(), at(0, 9, 12)) - 1,
      raw: "send the invoice to ada at example dot com",
      text: "Send the invoice to ada@example.com.",
      status: "notInserted",
    },
    {
      id: "h3",
      at: at(1, 17, 5),
      raw: "Standup notes.",
      text: "Standup notes.",
      status: "inserted",
    },
    {
      id: "h4",
      at: at(1, 8, 30),
      raw: "dear team the offsite moves to the twelfth new paragraph bring a laptop and your ideas for Q3",
      text: "Dear team,\n\nThe offsite moves to the 12th.\n\nBring a laptop and your ideas for Q3.",
      status: "inserted",
    },
    {
      id: "h5",
      at: at(4, 14, 2),
      raw: "Call Hadryś about the Worcestershire order.",
      text: "Call Hadryś about the Worcestershire order.",
      status: "inserted",
    },
  ];
}

// More rows than Home mounts at once, so the Show more button has something to reveal.
function longHistory(): HistoryEntry[] {
  const first = Date.now();
  return Array.from({ length: 130 }, (_, i) => ({
    id: `long-${i}`,
    at: first - i * 5_400_000,
    raw: `Entry ${i + 1} of the long history.`,
    text: `Entry ${i + 1} of the long history.`,
    status: "inserted",
  }));
}

function sampleInsights(): Insights {
  const days: Record<DayKey, number> = {};
  const today = new Date();
  for (let back = 0; back < 150; back += 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    const words = ((back * 7919) % 997) - (weekend ? 600 : 150);
    if ((back < 40 || back > 46) && words > 0) days[dayKey(date)] = words;
  }
  const recent = Array.from({ length: 100 }, (_, i) => ({
    words: 20 + ((i * 37) % 90),
    ms: 9000 + ((i * 53) % 30) * 1000,
  }));
  return { days, corrected: 1843, dictionaryFixes: 212, recent };
}

function fakeVoice(
  { history: initialHistory = sampleHistory(), saveFailed = false, ...initial }: HubScene,
  loop: boolean,
): HubApi & PillApi {
  let snapshot: Snapshot = initial;
  let history = initialHistory;
  const historyListeners = new Set<(history: HistoryState) => void>();
  const historyState = (): HistoryState => ({
    entries: history,
    retention: snapshot.settings.historyRetention,
    saveFailed,
  });
  const publishHistory = () => {
    for (const listener of historyListeners) listener(historyState());
  };
  const setHistory = (next: readonly HistoryEntry[]) => {
    history = next;
    publishHistory();
  };
  const listeners = new Set<(snapshot: Snapshot) => void>();
  const installs = new Map<ModelId, ReturnType<typeof setInterval>>();
  let insights = sampleInsights();
  const insightsListeners = new Set<(insights: Insights) => void>();
  const set = (next: Snapshot) => {
    const retentionChanged = next.settings.historyRetention !== snapshot.settings.historyRetention;
    snapshot = next;
    for (const listener of listeners) listener(snapshot);
    if (retentionChanged) publishHistory();
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
    downloadUpdate: async () => {
      if (snapshot.updates.status.kind !== "available") throw new Error("No update is available.");
      const { version, notes } = snapshot.updates.status;
      const show = (status: UpdateStatus) =>
        set({ ...snapshot, updates: { ...snapshot.updates, status } });
      [0, 35, 70, 100].forEach((percent, step) =>
        setTimeout(() => show({ kind: "downloading", version, notes, percent }), step * 400),
      );
      setTimeout(() => show({ kind: "ready", version, notes }), 1_800);
    },
    restartForUpdate: async (request) => {
      console.info("restartForUpdate", JSON.stringify(request));
      if (snapshot.updates.status.kind !== "ready") throw new Error("No update is ready.");
      set({
        ...snapshot,
        updates: {
          ...snapshot.updates,
          status: { kind: "installing", version: snapshot.updates.status.version },
        },
      });
    },
    onRestartRequest: () => () => {},
    openRelease: async () => {
      console.info("openRelease");
    },
    getSnapshot: async () => snapshot,
    onSnapshot: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getPillSnapshot: async () => toPillSnapshot(snapshot),
    onPillSnapshot: (listener) => {
      const forward = (next: Snapshot) => listener(toPillSnapshot(next));
      listeners.add(forward);
      return () => listeners.delete(forward);
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
          copyToClipboard: patch.copyToClipboard ?? snapshot.settings.copyToClipboard,
          showInDock: patch.showInDock ?? snapshot.settings.showInDock,
          alwaysShowPill: patch.alwaysShowPill ?? snapshot.settings.alwaysShowPill,
          cleanup: { ...snapshot.settings.cleanup, ...patch.cleanup },
          diagnostics: patch.diagnostics ?? snapshot.settings.diagnostics,
          historyRetention: patch.historyRetention ?? snapshot.settings.historyRetention,
          snippets: patch.snippets ?? snapshot.settings.snippets,
          dictionary: patch.dictionary ?? snapshot.settings.dictionary,
          zoomLevel: patch.zoomLevel ?? snapshot.settings.zoomLevel,
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
    signIn: async () => {
      set({ ...snapshot, account: { kind: "signingIn", purpose: "signIn", phase: "browser" } });
    },
    signOut: async () => {
      set({ ...snapshot, account: { kind: "signedOut" } });
    },
    submitSignInCode: async (code) => {
      if (!/^[\w-]{20,}$/.test(code)) throw new Error("Paste the whole code shown in the browser.");
      set({
        ...snapshot,
        account: { kind: "signedIn", ...ada },
      });
    },
    cancelSignIn: async () => {
      set({ ...snapshot, account: { kind: "signedOut" } });
    },
    dismissAccountError: async () => {
      set({ ...snapshot, account: { kind: "signedOut" } });
    },
    updateAccountName: async ({ firstName, lastName }) => {
      if (snapshot.account.kind !== "signedIn") return;
      const name = { firstName: firstName.trim(), lastName: lastName.trim() };
      if (!name.firstName) throw new Error("Enter a first name.");
      set({ ...snapshot, account: { ...snapshot.account, ...name, name: fullName(name) } });
    },
    requestAccountDeletion: async () => {
      if (snapshot.account.kind !== "signedIn") return;
      set({ ...snapshot, account: { ...snapshot.account, deletion: { kind: "confirming" } } });
    },
    confirmAccountDeletion: async () => {
      if (snapshot.account.kind !== "signedIn" || snapshot.account.deletion?.kind !== "confirming")
        return;
      set({ ...snapshot, account: { kind: "signedOut" } });
    },
    cancelAccountDeletion: async () => {
      if (snapshot.account.kind !== "signedIn") return;
      const { deletion: _deletion, ...identity } = snapshot.account;
      set({ ...snapshot, account: identity });
    },
    retryAccountDeletion: async () => {
      if (snapshot.account.kind !== "signedIn") return;
      set({ ...snapshot, account: { ...snapshot.account, deletion: { kind: "confirming" } } });
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
      clearInterval(installs.get(id));
      const timer = setInterval(() => {
        progress = Math.min(1, progress + 0.07);
        const model: ModelStatus =
          progress < 1 ? { state: "downloading", progress } : { state: "ready" };
        set({ ...snapshot, models: { ...snapshot.models, [id]: model } });
        if (progress >= 1) {
          clearInterval(timer);
          installs.delete(id);
        }
      }, 200);
      installs.set(id, timer);
    },
    uninstallModel: async (id) => {
      clearInterval(installs.get(id));
      installs.delete(id);
      set({ ...snapshot, models: { ...snapshot.models, [id]: { state: "missing" } } });
    },
    getHistory: async () => historyState(),
    onHistory: (listener) => {
      historyListeners.add(listener);
      return () => historyListeners.delete(listener);
    },
    copyHistoryEntry: async (id, version) => {
      console.info("copyHistoryEntry", id, version);
    },
    deleteHistoryEntry: async (id) => {
      setHistory(history.filter((entry) => entry.id !== id));
    },
    clearHistory: async () => {
      setHistory([]);
    },
    getInsights: async () => insights,
    onInsights: (listener) => {
      insightsListeners.add(listener);
      return () => insightsListeners.delete(listener);
    },
    clearInsights: async () => {
      insights = EMPTY_INSIGHTS;
      for (const listener of insightsListeners) listener(insights);
    },
  };
}

function PillPreview() {
  const snapshot = usePillSnapshot();
  return snapshot ? <PillCapsule {...snapshot} /> : null;
}

function HubPreview() {
  const snapshot = useSnapshot();
  const history = useHistory();
  return snapshot && history ? <HubShell snapshot={snapshot} history={history} /> : null;
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
            <PillCapsule session={session} alwaysShowPill copyToClipboard={false} />
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
