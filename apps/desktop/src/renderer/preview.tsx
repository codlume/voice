import { createRoot } from "react-dom/client";

import {
  DEFAULT_SETTINGS,
  fullName,
  toPillSnapshot,
  type ModelStatus,
  type Outcome,
  type PillState,
  type Snapshot,
  type TransformOutcome,
  type HubApi,
  type PillApi,
  type ReleaseNotes,
  type UpdateStatus,
} from "../shared/api.ts";
import { parseBundleId, type BundleId } from "../shared/app-categories.ts";
import { applyAssignmentEdit } from "../shared/style.ts";
import type {
  HistoryChange,
  HistoryEntry,
  HistoryRetention,
  HistoryState,
  HistoryStatus,
} from "../shared/history.ts";
import { EMPTY_INSIGHTS, dayKey, type DayKey, type Insights } from "../shared/insights.ts";
import {
  DEFAULT_MEETINGS_SETTINGS,
  renameSpeaker,
  retitle,
  searchMeeting,
  type Folder,
  type FolderId,
  type MarkerKind,
  type Meeting,
  type MeetingId,
  type MeetingsChange,
  type MeetingsState,
  type PillMeeting,
  type Segment,
  type Speaker,
  type SpeakerId,
  type TranscriptEntry,
} from "../shared/meetings.ts";
import type { ModelId } from "../shared/models.ts";
import "./style.css";
import { HubShell, type AppPage } from "./HubShell.tsx";
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
  permissions: {
    microphone: "notDetermined",
    accessibility: "notDetermined",
    systemAudio: "notDetermined",
  },
  loginItem: "off",
  models: {
    asr: { state: "missing" },
    cleanup: { state: "missing" },
    transform: { state: "missing" },
  },
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
  meetingNotices: [],
};

const ready: Snapshot = {
  ...base,
  permissions: { microphone: "granted", accessibility: "granted", systemAudio: "notDetermined" },
  models: { asr: { state: "ready" }, cleanup: { state: "ready" }, transform: { state: "missing" } },
};

const historySaved: HubScene = { ...ready, retention: "month" };

const done = (outcome: Outcome): PillState => ({ kind: "done", outcome });
const transformDone = (outcome: TransformOutcome): PillState => ({
  kind: "transformDone",
  outcome,
});

const pillScenes: Record<string, PillState> = {
  idle: { kind: "idle" },
  listening: { kind: "listening" },
  processing: { kind: "processing", overdue: false },
  inserted: done({ kind: "inserted", method: "accessibility" }),
  pasted: done({ kind: "inserted", method: "paste" }),
  empty: done({ kind: "empty" }),
  tooShort: done({ kind: "tooShort" }),
  focusChanged: done({ kind: "notInserted", reason: "focusChanged", copied: false }),
  secureInput: done({ kind: "notInserted", reason: "secureInput", copied: true }),
  noModel: done({ kind: "failed", message: "Set up the speech model in Voice first" }),
  longFailure: done({
    kind: "failed",
    message: "The speech model stopped unexpectedly while transcribing this recording",
  }),
  transforming: { kind: "transforming", loading: false },
  transformLoading: { kind: "transforming", loading: true },
  transformTooLong: transformDone({ kind: "tooLong", maxWords: 1000 }),
  transformNotInserted: transformDone({ kind: "notInserted", reason: "noFocusedField" }),
};

// Fixed times, so a recording scene reads the same each load: 12 minutes in a closed leg.
const meetingSince = Date.now() - 95_000;
const pillMeetingScenes: Record<string, PillMeeting> = {
  "meeting-recording": {
    status: { kind: "recording", since: meetingSince },
    closedMs: 720_000,
    prompt: null,
  },
  "meeting-paused": { status: { kind: "paused" }, closedMs: 815_000, prompt: null },
  "meeting-starting": { status: { kind: "starting", from: "new" }, closedMs: 0, prompt: null },
  "meeting-finishing": { status: { kind: "finishing" }, closedMs: 815_000, prompt: null },
  "meeting-short": { status: { kind: "confirmingShort" }, closedMs: 4_000, prompt: null },
  "meeting-silence": {
    status: { kind: "recording", since: meetingSince },
    closedMs: 720_000,
    prompt: { kind: "silence" },
  },
  "meeting-limit": {
    status: { kind: "recording", since: meetingSince },
    closedMs: 6_900_000,
    prompt: { kind: "maxLengthSoon", endsAt: Date.now() + 290_000 },
  },
};

const releaseItems = [
  "feat(desktop): add keyboard shortcuts and a Shortcuts settings page by @mhadrys in #119",
  "feat(desktop): add a Show Flow Bar at all times setting by @mhadrys in #120",
  "feat(desktop): add Open at login and Show in Dock settings by @mhadrys in #118",
  "feat(desktop): add a Data and Privacy settings page by @mhadrys in #117",
  "fix(desktop): keep Voice in Cmd-Tab and the Dock by @mhadrys in #116",
  "feat(desktop): split settings into General and System by @mhadrys in #115",
  "fix(asr): keep the final transcript when the speech model restarts mid-session, so a long dictation is never lost by @mhadrys in #114",
  "fix(insertion): fall back to paste in terminals that reject accessibility writes by @mhadrys in #113",
];

const releaseNotes: ReleaseNotes = {
  releases: [{ version: "1.5.0", items: releaseItems }],
  more: false,
};

const skippedReleaseNotes: ReleaseNotes = {
  releases: [
    { version: "1.5.0", items: releaseItems.slice(0, 2) },
    {
      version: "1.4.2",
      items: ["fix(insertion): keep the clipboard when paste fallback fails by @mhadrys in #111"],
    },
    {
      version: "1.4.1",
      items: [
        "fix(asr): stop dropping the last word of short dictations by @mhadrys in #108",
        "fix(desktop): show the right shortcut on keyboards without fn by @mhadrys in #107",
      ],
    },
    {
      version: "1.4.0",
      items: ["feat(desktop): add a dictionary for names and acronyms by @mhadrys in #102"],
    },
    {
      version: "1.3.1",
      items: ["fix(desktop): reopen the Voice window from the Dock by @mhadrys in #98"],
    },
    { version: "1.3.0", items: ["feat(desktop): add Insights by @mhadrys in #95"] },
  ],
  more: true,
};

const updateScenes: Record<string, UpdateStatus> = {
  checking: { kind: "checking" },
  current: { kind: "current" },
  available: { kind: "available", version: "1.5.0", notes: releaseNotes },
  downloading: { kind: "downloading", version: "1.5.0", notes: releaseNotes, percent: 48 },
  ready: { kind: "ready", version: "1.5.0", notes: releaseNotes },
  "ready-skipped-releases": { kind: "ready", version: "1.5.0", notes: skippedReleaseNotes },
  "ready-no-notes": { kind: "ready", version: "1.5.0", notes: { releases: [], more: false } },
  failed: { kind: "failed", message: "Could not check for updates. Try again." },
  disabled: { kind: "disabled", reason: "Updates are available in packaged builds." },
};

// A hub scene is the snapshot main would publish plus the history beside it, which defaults to
// sampleHistory() with saving working.
type MeetingFixtures = {
  state: MeetingsState;
  transcripts: Readonly<Record<string, readonly TranscriptEntry[]>>;
};

const MINUTE = 60_000;

function dayAt(daysAgo: number, hour: number, minute: number): number {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
}

let segmentCount = 0;
// Fixture speakers are keyed by their name, so a fixture line can name who says it.
const said = (atMinute: number, text: string, speaker: string | null | "you" = "you"): Segment => {
  const startMs = Math.round(atMinute * MINUTE);
  const voice =
    speaker === "you"
      ? { source: "mic" as const }
      : { source: "system" as const, speakerId: speaker as SpeakerId | null };
  return {
    kind: "segment",
    id: `s${++segmentCount}`,
    startMs,
    endMs: startMs + 8000,
    text,
    ...voice,
  };
};
/** A named speaker for every voice the transcript gives a name, in the order they first spoke. */
function speakersIn(transcript: readonly TranscriptEntry[] = []): Speaker[] {
  const names = transcript.flatMap((entry) =>
    entry.kind === "segment" && entry.source === "system" && entry.speakerId
      ? [entry.speakerId]
      : [],
  );
  return [...new Set(names)].map((name, index) => ({
    id: name,
    label: `Speaker ${index + 1}`,
    name: name,
  }));
}

const marked = (atMinute: number, marker: MarkerKind): TranscriptEntry => ({
  kind: "marker",
  marker,
  atMs: Math.round(atMinute * MINUTE),
});

const fixtureId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as MeetingId;
const productFolder = "00000000-0000-4000-9000-000000000001" as FolderId;
const standupFolder = "00000000-0000-4000-9000-000000000002" as FolderId;

function fixtureMeeting(
  n: number,
  title: string | null,
  startedAt: number,
  minutes: number,
  patch: Partial<Meeting> = {},
): Meeting {
  return {
    id: fixtureId(n),
    title: title === null ? null : title,
    createdAt: startedAt,
    spans: [{ startedAt, endedAt: startedAt + minutes * MINUTE }],
    status: { kind: "ready" },
    folderIds: [],
    notes: "",
    summary: { kind: "none" },
    speakers: [],
    finalPassFailed: false,
    ...patch,
  };
}

const summaryOf = (markdown: string, coversMinutes: number, at: number) => ({
  markdown,
  coversUntilMs: coversMinutes * MINUTE,
});

const productSync = `Priya Shah and Tom Becker reviewed the beta feedback and agreed to ship the export fix before widening the beta. Tom Becker flagged that the Windows build still trails by a week, so the launch email waits for it.

### Decisions
- Ship the export fix on **Thursday**, then open the beta to the waitlist
- Keep the old pricing page until the launch email goes out

### Next Steps
- **Priya Shah**
  - Draft the launch email by Wednesday
  - Collect three customer quotes from the beta
- **Tom Becker**
  - Finish the Windows build and share the test plan
- **You**
  - Review the release notes with support`;

const sprintPlanning = `Anna Kowalska i Piotr Nowak ustalili zakres sprintu: najpierw poprawki wyszukiwania, potem nowy ekran ustawień. Piotr Nowak zgłosił, że testy na macOS 14 trwają za długo i trzeba je podzielić.

### Decisions
- Sprint trwa dwa tygodnie, demo w piątek 13 listopada
- Ekran ustawień przechodzi do następnego sprintu, jeśli wyszukiwanie się opóźni

### Next Steps
- **Anna Kowalska**
  - Rozpisać zadania dla wyszukiwania do środy
- **Piotr Nowak**
  - Podzielić testy na macOS 14 na dwa zestawy`;

const designReview = `Lena Ortiz walked through the new onboarding flow. Everyone liked the shorter permission step, but the microphone prompt still appears before the user knows why.

### Decisions
- Move the microphone prompt after the first explanation screen

### Next Steps
- **Lena Ortiz**
  - Update the prototype with the new order`;

const customerCall = `Sam Patel from Northwind asked for a way to keep meeting notes in their own wiki. They export to Markdown today and paste by hand.

### Next Steps
- **You**
  - Send Sam Patel the Markdown export steps`;

function sampleMeetings({ recording = false } = {}): MeetingFixtures {
  const syncAt = dayAt(0, 9, 30);
  const designAt = dayAt(0, 13, 0);
  const planningAt = dayAt(1, 10, 0);
  const standupAt = dayAt(1, 9, 0);
  const customerAt = dayAt(3, 16, 15);
  const meetings: Meeting[] = [
    fixtureMeeting(2, "Design review: onboarding", designAt, 20, {
      folderIds: [productFolder],
      spans: [
        { startedAt: designAt, endedAt: designAt + 20 * MINUTE },
        { startedAt: designAt + 40 * MINUTE, endedAt: designAt + 52 * MINUTE },
      ],
      summary: { kind: "ready", summary: summaryOf(designReview, 20, designAt + 21 * MINUTE) },
    }),
    fixtureMeeting(1, "Weekly product sync", syncAt, 34, {
      folderIds: [productFolder],
      notes:
        "Ask Tom whether the Windows test plan covers older audio drivers.\nPricing page: keep until launch.",
      summary: { kind: "ready", summary: summaryOf(productSync, 34, syncAt + 35 * MINUTE) },
    }),
    fixtureMeeting(3, "Planowanie sprintu", planningAt, 46, {
      summary: { kind: "ready", summary: summaryOf(sprintPlanning, 46, planningAt + 47 * MINUTE) },
    }),
    fixtureMeeting(4, "Morning standup", standupAt, 4, { folderIds: [standupFolder] }),
    fixtureMeeting(5, "Customer call: Northwind", customerAt, 28, {
      summary: {
        kind: "failed",
        message: "The cleanup model stopped before it finished.",
        previous: summaryOf(customerCall, 28, customerAt + 29 * MINUTE),
      },
    }),
  ];
  if (recording) {
    const since = Date.now() - 12 * MINUTE;
    meetings.unshift(
      fixtureMeeting(6, null, since, 0, { spans: [], status: { kind: "recording", since } }),
    );
  }
  const transcripts: MeetingFixtures["transcripts"] = {
    [fixtureId(1)]: [
      said(0.1, "Morning. Let's start with the beta feedback."),
      said(
        0.4,
        "Most of it is about the export. People lose formatting in long notes.",
        "Priya Shah",
      ),
      said(1.2, "The fix is ready. I want one more day of testing on older Macs.", "Tom Becker"),
      said(1.6, "Then we ship it Thursday and open the beta to the waitlist."),
      marked(2.0, "dictated"),
      said(2.3, "Agreed. I'll draft the launch email by Wednesday.", "Priya Shah"),
      marked(18, "paused"),
      marked(18, "resumed"),
      said(
        18.2,
        "The Windows build is about a week behind, so the email should wait.",
        "Tom Becker",
      ),
      said(19, "Fine. Keep the old pricing page until the email goes out."),
    ],
    [fixtureId(2)]: [
      said(0.2, "Here is the new onboarding flow, three screens instead of five.", "Lena Ortiz"),
      said(3, "The microphone prompt still shows up before we explain anything."),
      marked(20, "paused"),
      marked(20, "resumed"),
      said(20.5, "I moved the prompt after the first screen. Take a look.", "Lena Ortiz"),
    ],
    [fixtureId(3)]: [
      said(0.1, "Zaczynamy od zakresu sprintu.", "Anna Kowalska"),
      said(0.8, "Najpierw wyszukiwanie, potem ekran ustawień."),
      said(1.5, "Testy na macOS 14 trwają czterdzieści minut. Trzeba je podzielić.", "Piotr Nowak"),
      said(2.4, "Demo w piątek trzynastego listopada.", "Anna Kowalska"),
    ],
    [fixtureId(4)]: [
      said(0.1, "Yesterday I finished the folder dialog."),
      said(0.6, "I'm on the export bug today.", null),
    ],
    [fixtureId(5)]: [
      said(0.2, "We keep our meeting notes in a wiki and paste them in by hand.", "Sam Patel"),
      said(1, "Voice can export each meeting as Markdown. I'll send you the steps."),
    ],
    ...(recording && {
      [fixtureId(6)]: [
        said(0.1, "Okay, recording. Let's go through the roadmap."),
        { ...said(0.4, "Can everyone hear me", null) },
      ],
    }),
  };
  for (const meeting of meetings) meeting.speakers = speakersIn(transcripts[meeting.id]);
  return {
    state: {
      meetings,
      folders: [
        { id: productFolder, name: "Product", createdAt: dayAt(20, 9, 0), kind: "manual" },
        {
          id: standupFolder,
          name: "Standups",
          createdAt: dayAt(20, 9, 0),
          kind: "auto",
          rule: { kind: "titleContains", text: "standup" },
        },
      ],
      settings: DEFAULT_MEETINGS_SETTINGS,
    },
    transcripts,
  };
}

type HubScene = Snapshot & {
  meetings?: MeetingFixtures;
  history?: readonly HistoryEntry[];
  insights?: Insights;
  retention?: HistoryRetention;
  saveFailed?: boolean;
};

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
    permissions: { microphone: "granted", accessibility: "denied", systemAudio: "notDetermined" },
    models: {
      asr: { state: "downloading", progress: 0.42 },
      cleanup: { state: "failed", message: "Download interrupted. Check your connection." },
      transform: { state: "missing" },
    },
  },
  "setup-not-ready": {
    ...base,
    permissions: {
      microphone: "granted",
      accessibility: "notDetermined",
      systemAudio: "notDetermined",
    },
    models: {
      asr: { state: "ready" },
      cleanup: { state: "ready" },
      transform: { state: "missing" },
    },
  },
  ready,
  "cleanup-off": {
    ...ready,
    models: {
      asr: { state: "ready" },
      cleanup: { state: "installed" },
      transform: { state: "missing" },
    },
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
    session: done({ kind: "notInserted", reason: "focusChanged", copied: false }),
    history: sampleHistory("notInserted"),
    updates: { ...ready.updates, status: { kind: "ready", version: "1.5.0", notes: releaseNotes } },
  },
  meetings: { ...ready, meetings: sampleMeetings() },
  "meetings-empty": ready,
  "meetings-recording": { ...ready, meetings: sampleMeetings({ recording: true }) },
  "history-empty": { ...ready, history: [] },
  history: ready,
  "history-saved": historySaved,
  "history-long": { ...historySaved, history: longHistory() },
  "history-save-failed": { ...historySaved, saveFailed: true },
  "insights-usage-empty": {
    ...ready,
    insights: { ...sampleInsights(), categories: EMPTY_INSIGHTS.categories, apps: {} },
  },
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
  [done({ kind: "notInserted", reason: "focusChanged", copied: false }), 2500],
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
  const apps: Record<BundleId, number> = {};
  for (const [id, words] of [
    ["com.tinyspeck.slackmacgap", 15_900],
    ["com.apple.MobileSMS", 6400],
    ["com.apple.mail", 6210],
    ["net.whatsapp.WhatsApp", 3470],
    ["com.example.ledger", 2900],
    ["com.google.Chrome", 2520],
    ["com.apple.TextEdit", 850],
  ] as const) {
    const bundleId = parseBundleId(id);
    if (bundleId) apps[bundleId] = words;
  }
  return {
    days,
    corrected: 1843,
    dictionaryFixes: 212,
    recent,
    categories: {
      personal: { words: 9870, sessions: 540 },
      work: { words: 22_170, sessions: 709 },
      email: { words: 6210, sessions: 88 },
      other: { words: 0, sessions: 0 },
    },
    apps,
  };
}

type MeetingsApi = Pick<
  HubApi,
  Extract<keyof HubApi, `${string}Meeting${string}` | `${string}Folder${string}`>
>;

const unavailable = async () => ({ kind: "unavailable" }) as const;

// Holds what the page sets in memory. Recording waits for the real recorder, like main.
function fakeMeetings(
  { state: initial, transcripts }: MeetingFixtures = {
    state: { meetings: [], folders: [], settings: DEFAULT_MEETINGS_SETTINGS },
    transcripts: {},
  },
): MeetingsApi {
  let state = initial;
  const listeners = new Set<(change: MeetingsChange) => void>();
  const set = (next: Partial<MeetingsState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener({ kind: "all", state });
  };
  const editMeeting = (id: string, change: (meeting: Meeting) => Meeting) =>
    set({
      meetings: state.meetings.map((meeting) => (meeting.id === id ? change(meeting) : meeting)),
    });
  const editFolders = (change: (folders: readonly Folder[]) => readonly Folder[]) =>
    set({ folders: change(state.folders) });
  return {
    getMeetings: async () => state,
    onMeetings: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getMeeting: async (id) => {
      const meeting = state.meetings.find((candidate) => candidate.id === id);
      return meeting ? { meeting, transcript: transcripts[id] ?? [] } : null;
    },
    renameMeeting: async (id, title) =>
      editMeeting(id, (meeting) => retitle(meeting, title, state.folders, state.settings)),
    renameMeetingSpeaker: async (id, speakerId, name) =>
      editMeeting(id, (meeting) => renameSpeaker(meeting, speakerId, name)),
    updateMeetingNotes: async (id, notes) => editMeeting(id, (meeting) => ({ ...meeting, notes })),
    deleteMeeting: async (id) =>
      set({ meetings: state.meetings.filter((meeting) => meeting.id !== id) }),
    createFolder: async (draft) => {
      const folder: Folder = {
        ...draft,
        id: crypto.randomUUID() as FolderId,
        createdAt: Date.now(),
      };
      editFolders((folders) => [...folders, folder]);
      return folder;
    },
    updateFolder: async (id, draft) =>
      editFolders((folders) =>
        folders.map((folder) => (folder.id === id ? { ...folder, ...draft } : folder)),
      ),
    deleteFolder: async (id) =>
      editFolders((folders) => folders.filter((folder) => folder.id !== id)),
    setMeetingInFolder: async (meetingId, folderId, inFolder) =>
      editMeeting(meetingId, (meeting) => ({
        ...meeting,
        folderIds: inFolder
          ? [...new Set([...meeting.folderIds, folderId])]
          : meeting.folderIds.filter((id) => id !== folderId),
      })),
    searchMeetings: async (query) =>
      state.meetings.flatMap(
        (meeting) => searchMeeting(meeting, transcripts[meeting.id] ?? [], query) ?? [],
      ),
    updateMeetingsSettings: async (patch) => set({ settings: { ...state.settings, ...patch } }),
    copyMeetingMarkdown: async (id) => {
      console.info("copyMeetingMarkdown", id);
    },
    exportMeetingMarkdown: async () => "cancelled",
    startMeeting: unavailable,
    toggleMeeting: unavailable,
    pauseMeeting: unavailable,
    resumeMeeting: unavailable,
    stopMeeting: unavailable,
    keepMeeting: unavailable,
    discardMeeting: unavailable,
    generateMeetingSummary: unavailable,
    retryMeetingTranscript: unavailable,
    deleteMeetingAudio: unavailable,
    onMeetingTranscript: () => () => {},
    onMeetingPartial: () => () => {},
    dismissMeetingNotice: async () => {},
  };
}

function fakeVoice(
  {
    history: initialHistory = sampleHistory(),
    insights: initialInsights = sampleInsights(),
    retention: initialRetention = "memory",
    saveFailed = false,
    meetings,
    ...initial
  }: HubScene,
  loop: boolean,
  pillMeeting: PillMeeting | null = null,
): HubApi & PillApi {
  let snapshot: Snapshot = initial;
  let history = initialHistory;
  let retention = initialRetention;
  const historyListeners = new Set<(change: HistoryChange) => void>();
  const historyState = (): HistoryState => ({
    entries: history,
    retention,
    saveFailed,
  });
  const publishHistory = () => {
    for (const listener of historyListeners) listener({ kind: "all", state: historyState() });
  };
  const setHistory = (next: readonly HistoryEntry[]) => {
    history = next;
    publishHistory();
  };
  const listeners = new Set<(snapshot: Snapshot) => void>();
  const installs = new Map<ModelId, ReturnType<typeof setInterval>>();
  let insights = initialInsights;
  const insightsListeners = new Set<(insights: Insights) => void>();
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
    ...fakeMeetings(meetings),
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
    getPillSnapshot: async () => toPillSnapshot(snapshot, pillMeeting),
    setPillClickable: async () => {},
    openNotepad: async () => {
      console.info("openNotepad");
    },
    onPillSnapshot: (listener) => {
      const forward = (next: Snapshot) => listener(toPillSnapshot(next, pillMeeting));
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
      const hotkey = patch.hotkey ?? snapshot.settings.hotkey;
      const toggleHotkey =
        patch.toggleHotkey === undefined ? snapshot.settings.toggleHotkey : patch.toggleHotkey;
      set({
        ...snapshot,
        settings: {
          hotkey,
          toggleHotkey: toggleHotkey === hotkey ? null : toggleHotkey,
          updateChannel: patch.updateChannel ?? snapshot.settings.updateChannel,
          dictationLanguage: patch.dictationLanguage ?? snapshot.settings.dictationLanguage,
          theme: patch.theme ?? snapshot.settings.theme,
          pageAnimationMs: patch.pageAnimationMs ?? snapshot.settings.pageAnimationMs,
          microphone:
            patch.microphone === undefined ? snapshot.settings.microphone : patch.microphone,
          meetingShortcut:
            patch.meetingShortcut === undefined
              ? snapshot.settings.meetingShortcut
              : patch.meetingShortcut,
          lowerAudioWhileDictating:
            patch.lowerAudioWhileDictating ?? snapshot.settings.lowerAudioWhileDictating,
          lowerAudioByPercent: patch.lowerAudioByPercent ?? snapshot.settings.lowerAudioByPercent,
          copyToClipboard: patch.copyToClipboard ?? snapshot.settings.copyToClipboard,
          showInDock: patch.showInDock ?? snapshot.settings.showInDock,
          alwaysShowPill: patch.alwaysShowPill ?? snapshot.settings.alwaysShowPill,
          cleanup: {
            enabled: patch.cleanup?.enabled ?? snapshot.settings.cleanup.enabled,
            styles: { ...snapshot.settings.cleanup.styles, ...patch.cleanup?.styles },
            assignments: snapshot.settings.cleanup.assignments,
          },
          diagnostics: patch.diagnostics ?? snapshot.settings.diagnostics,
          snippets: patch.snippets ?? snapshot.settings.snippets,
          dictionary: patch.dictionary ?? snapshot.settings.dictionary,
          zoomLevel: patch.zoomLevel ?? snapshot.settings.zoomLevel,
          transforms: { ...snapshot.settings.transforms, ...patch.transforms },
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
    setHistoryRetention: async (next) => {
      retention = next;
      publishHistory();
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
    getInstalledApps: async () =>
      (
        [
          ["com.apple.MobileSMS", "Messages"],
          ["net.whatsapp.WhatsApp", "WhatsApp"],
          ["ru.keepcoder.Telegram", "Telegram"],
          ["org.whispersystems.signal-desktop", "Signal"],
          ["com.hnc.Discord", "Discord"],
          ["com.tencent.xinWeChat", "WeChat"],
          ["com.tinyspeck.slackmacgap", "Slack"],
          ["com.apple.mail", "Mail"],
          ["com.apple.dt.Xcode", "Xcode"],
          ["com.apple.TextEdit", "TextEdit"],
          ["com.google.Chrome", "Google Chrome", true],
        ] satisfies [string, string, boolean?][]
      ).flatMap(([id, name, browser = false]) => {
        const bundleId = parseBundleId(id);
        return bundleId ? [{ bundleId, name, browser }] : [];
      }),
    getAppIcons: async () => ({}),
    getLastTransform: async () => null,
    onLastTransform: () => () => {},
    copyLastTransform: async () => {},
    editAssignments: async (edit) => {
      const { cleanup } = snapshot.settings;
      set({
        ...snapshot,
        settings: {
          ...snapshot.settings,
          cleanup: { ...cleanup, assignments: applyAssignmentEdit(cleanup.assignments, edit) },
        },
      });
    },
  };
}

function PillPreview() {
  const snapshot = usePillSnapshot();
  return snapshot ? <PillCapsule {...snapshot} /> : null;
}

function HubPreview({ initialPage }: { initialPage: AppPage }) {
  const snapshot = useSnapshot();
  const history = useHistory();
  return snapshot && history ? (
    <HubShell snapshot={snapshot} history={history} initialPage={initialPage} />
  ) : null;
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
            <PillCapsule session={session} alwaysShowPill meeting={null} />
          </div>
        </figure>
      ))}
      {Object.entries(pillMeetingScenes).map(([name, meeting]) => (
        <figure key={name} style={{ margin: 0 }}>
          <figcaption style={{ fontSize: 12, marginBottom: 4 }}>
            <a href={`?pill=${name}`}>{name}</a>
          </figcaption>
          <div style={box}>
            <PillCapsule session={{ kind: "idle" }} alwaysShowPill={false} meeting={meeting} />
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
  window.voice = fakeVoice(
    { ...ready, session },
    pill === "cycle",
    pillMeetingScenes[pill] ?? null,
  );
  if (params.get("backdrop") !== "none") document.body.style.background = "#d9dde3";
  root.render(<PillPreview />);
} else if (hub) {
  window.voice = fakeVoice(hubScenes[hub] ?? base, false);
  root.render(<HubPreview initialPage={hub.startsWith("meetings") ? "meetings" : "home"} />);
} else {
  window.voice = fakeVoice(ready, true);
  root.render(<Gallery />);
}
