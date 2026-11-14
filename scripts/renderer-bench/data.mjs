// Seeded synthetic data for the renderer benchmark. Every name, sentence and address is made up,
// and the same seed always gives the same data, so two runs render the same rows.

/** @typedef {import("../../apps/desktop/src/shared/history.ts").HistoryEntry} HistoryEntry */
/** @typedef {import("../../apps/desktop/src/shared/insights.ts").Insights} Insights */
/** @typedef {import("../../apps/desktop/src/shared/meetings.ts").Meeting} Meeting */
/** @typedef {import("../../apps/desktop/src/shared/meetings.ts").TranscriptEntry} TranscriptEntry */

const MINUTE = 60_000;
const DAY = 86_400_000;

/** A small deterministic generator (mulberry32) returning numbers in [0, 1). */
export function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const int = (rand, below) => Math.floor(rand() * below);
/** @type {<T>(rand: () => number, list: readonly T[]) => T} */
const pick = (rand, list) => /** @type {any} */ (list[int(rand, list.length)]);

const people = ["Ada Lovelace", "Priya Shah", "Tom Becker", "Lena Ortiz", "Sam Patel", "Hadryś"];
const topics = [
  "the launch",
  "the export fix",
  "the Windows build",
  "the Q3 roadmap",
  "invoice 4821",
  "the onboarding flow",
  "the pricing page",
  "the standup notes",
];
const days = ["Monday", "Thursday", "Friday", "the 12th", "March 3rd"];
const sentences = [
  (rand) => `Push ${pick(rand, topics)} to ${pick(rand, days)} because the QA pass isn't done yet.`,
  (rand) =>
    `Send ${pick(rand, topics)} to ${pick(rand, people)} at team${int(rand, 90)}@example.com.`,
  (rand) =>
    `The numbers are at https://example.com/reports/${1000 + int(rand, 9000)} if you need them.`,
  (rand) =>
    `Call ${pick(rand, people)} about ${pick(rand, topics)} before ${1 + int(rand, 12)}:30.`,
  (rand) => `We agreed on ${10 + int(rand, 90)} percent by ${pick(rand, days)}.`,
  (rand) => `${pick(rand, people)} will review ${pick(rand, topics)} and reply here.`,
  () => "Thanks, that works for me.",
  () => "Sounds good.",
];

function transcriptText(rand) {
  const shape = rand();
  const count = shape < 0.55 ? 1 : shape < 0.85 ? 2 + int(rand, 2) : 4 + int(rand, 5);
  const lines = Array.from({ length: count }, () => pick(rand, sentences)(rand));
  // A long dictation carries a paragraph break, as cleanup writes one.
  return count > 3
    ? `${lines.slice(0, 2).join(" ")}\n\n${lines.slice(2).join(" ")}`
    : lines.join(" ");
}

/** @returns {HistoryEntry} */
function entry(rand, id, at) {
  const text = transcriptText(rand);
  const raw = rand() < 0.4 ? text : `um ${text.toLowerCase().replaceAll(/[.,]/g, "")}`;
  return { id, at, raw, text, status: rand() < 0.04 ? "notInserted" : "inserted" };
}

/** `count` entries, newest first, a few minutes to an hour apart, all before `now`. */
export function history(rand, count, now) {
  let at = now;
  return Array.from({ length: count }, (_, i) => {
    at -= (5 + int(rand, 56)) * MINUTE;
    return entry(rand, `h${i}`, at);
  });
}

/** The entry a finished dictation adds: newer than every entry `history` made. */
export const dictated = (rand, index, now) => entry(rand, `new${index}`, now + (index + 1) * 1000);

const dayKey = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export const apps = [
  ["com.tinyspeck.slackmacgap", "Slack"],
  ["com.apple.MobileSMS", "Messages"],
  ["com.apple.mail", "Mail"],
  ["net.whatsapp.WhatsApp", "WhatsApp"],
  ["com.google.Chrome", "Google Chrome"],
  ["com.apple.TextEdit", "TextEdit"],
].map(([bundleId, name]) => ({
  bundleId,
  name,
  browser: name === "Google Chrome",
}));

export function insights(rand, now) {
  const dayCounts = {};
  for (let back = 0; back < 150; back += 1) {
    const date = new Date(now - back * DAY);
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    if (!weekend || rand() < 0.3) dayCounts[dayKey(date)] = 100 + int(rand, 900);
  }
  const usage = () => ({ words: 2000 + int(rand, 20_000), sessions: 50 + int(rand, 700) });
  return /** @type {Insights} */ (
    /** @type {unknown} */ ({
      days: dayCounts,
      corrected: 1843,
      dictionaryFixes: 212,
      recent: Array.from({ length: 100 }, () => ({
        words: 20 + int(rand, 90),
        ms: 9000 + int(rand, 30) * 1000,
      })),
      categories: { personal: usage(), work: usage(), email: usage(), other: usage() },
      apps: Object.fromEntries(apps.map(({ bundleId }) => [bundleId, 500 + int(rand, 15_000)])),
    })
  );
}

const meetingTitles = ["Weekly product sync", "Design review", "Customer call", "Sprint planning"];

/** `count` finished meetings, newest first, two a day; most carry a summary. */
export function meetings(rand, count, now) {
  return Array.from({ length: count }, (_, i) => {
    const startedAt = now - Math.floor(i / 2) * DAY - (4 + (i % 2) * 5) * 60 * MINUTE;
    const minutes = 15 + int(rand, 45);
    const markdown = `${pick(rand, people)} walked through ${pick(rand, topics)}.\n\n### Next Steps\n- **You**\n  - ${pick(rand, sentences)(rand)}`;
    return /** @type {Meeting} */ (
      /** @type {unknown} */ ({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        title: `${pick(rand, meetingTitles)} ${i + 1}`,
        createdAt: startedAt,
        spans: [{ startedAt, endedAt: startedAt + minutes * MINUTE }],
        status: { kind: "ready" },
        folderIds: [],
        notes: i % 3 === 0 ? pick(rand, sentences)(rand) : "",
        summary:
          rand() < 0.6
            ? { kind: "ready", summary: { markdown, coversUntilMs: minutes * MINUTE } }
            : { kind: "none" },
        speakers: people
          .slice(1, 4)
          .map((name, n) => ({ id: name, label: `Speaker ${n + 1}`, name })),
        finalPassFailed: null,
        transcriptRevision: 0,
      })
    );
  });
}

/** A long meeting's transcript: `segments` lines, the user and three other voices taking turns. */
export function transcript(rand, segments) {
  return Array.from({ length: segments }, (_, i) => {
    const startMs = i * 9000;
    const speaker = int(rand, 4);
    const voice =
      speaker === 0 ? { source: "mic" } : { source: "system", speakerId: people[speaker] };
    const text = pick(rand, sentences)(rand);
    return /** @type {TranscriptEntry} */ (
      /** @type {unknown} */ ({
        kind: "segment",
        id: `s${i}`,
        startMs,
        endMs: startMs + 8000,
        text,
        ...voice,
      })
    );
  });
}
