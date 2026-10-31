// Synthetic meetings for the preview harness and the tests. Names, words and folders are made up.
import {
  DEFAULT_MEETINGS_SETTINGS,
  type FolderId,
  type MarkerKind,
  type Meeting,
  type MeetingId,
  type MeetingsState,
  type Segment,
  type Speaker,
  type SpeakerId,
  type TranscriptEntry,
} from "../../shared/meetings.ts";

export type MeetingFixtures = {
  state: MeetingsState;
  transcripts: Readonly<Record<string, readonly TranscriptEntry[]>>;
};

export const MINUTE = 60_000;

export function dayAt(daysAgo: number, hour: number, minute: number): number {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
}

let segmentCount = 0;
// Fixture speakers are keyed by their name, so a fixture line can name who says it.
export const said = (
  atMinute: number,
  text: string,
  speaker: string | null | "you" = "you",
): Segment => {
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
export function speakersIn(transcript: readonly TranscriptEntry[] = []): Speaker[] {
  const names = transcript.flatMap((entry) =>
    entry.kind === "segment" && entry.source === "system" && entry.speakerId
      ? [entry.speakerId]
      : [],
  );
  return [...new Set(names)].map((name, index) => ({
    id: name,
    label: `Speaker ${index + 1}`,
    name,
  }));
}

export const marked = (atMinute: number, marker: MarkerKind): TranscriptEntry => ({
  kind: "marker",
  marker,
  atMs: Math.round(atMinute * MINUTE),
});

export const fixtureId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as MeetingId;
const productFolder = "00000000-0000-4000-9000-000000000001" as FolderId;
const standupFolder = "00000000-0000-4000-9000-000000000002" as FolderId;

export function fixtureMeeting(
  n: number,
  title: string | null,
  startedAt: number,
  minutes: number,
  patch: Partial<Meeting> = {},
): Meeting {
  return {
    id: fixtureId(n),
    title,
    createdAt: startedAt,
    spans: [{ startedAt, endedAt: startedAt + minutes * MINUTE }],
    status: { kind: "ready" },
    folderIds: [],
    notes: "",
    summary: { kind: "none" },
    speakers: [],
    finalPassFailed: false,
    transcriptRevision: 0,
    ...patch,
  };
}

export const summaryOf = (markdown: string, coversMinutes: number) => ({
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

export function sampleMeetings({ recording = false } = {}): MeetingFixtures {
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
      summary: { kind: "ready", summary: summaryOf(designReview, 20) },
    }),
    fixtureMeeting(1, "Weekly product sync", syncAt, 34, {
      folderIds: [productFolder],
      notes:
        "Ask Tom whether the Windows test plan covers older audio drivers.\nPricing page: keep until launch.",
      summary: { kind: "ready", summary: summaryOf(productSync, 34) },
    }),
    fixtureMeeting(3, "Planowanie sprintu", planningAt, 46, {
      summary: { kind: "ready", summary: summaryOf(sprintPlanning, 46) },
    }),
    fixtureMeeting(4, "Morning standup", standupAt, 4, { folderIds: [standupFolder] }),
    fixtureMeeting(5, "Customer call: Northwind", customerAt, 28, {
      summary: {
        kind: "failed",
        message: "The cleanup model stopped before it finished.",
        previous: summaryOf(customerCall, 28),
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
        said(0.4, "Can everyone hear me", null),
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
