import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = fileURLToPath(new URL("..", import.meta.url));
export const fixturesDir = join(repoDir, "test-fixtures/audio");

const fixtures = [
  {
    name: "short.wav",
    speech:
      "Hi Anna, can we move our meeting to Thursday at three thirty? Let me know if that works.",
  },
  {
    name: "long.wav",
    speech:
      "So, um, I was thinking we should, uh, we should probably start the migration on March twelfth. " +
      "Actually no, wait, let's do the fifteenth instead. " +
      "There are about forty two thousand records in the old table, and, like, most of them haven't been touched since two thousand nineteen. " +
      "Anyway, I'll, uh, I'll write up the plan tonight and send it over tomorrow morning, so, yeah, let me know what you think.",
  },
  { name: "silence.wav", silenceSeconds: 2 },
  { name: "url.wav", speech: "open github dot com slash pingdotgg" },
  {
    name: "language-trigger.wav",
    voice: "Milena",
    speech: "Хеллоу, май нейм из Анна. Плиз сенд зе репорт бай Фрайдей.",
  },
  // `say` ends on the last word; a person releases the key a beat later, so these two trail off.
  {
    name: "pauses.wav",
    trailingSilenceSeconds: 0.5,
    speech:
      "Okay so first thing, [[slnc 700]] we need to ship the release by Friday. " +
      "[[slnc 900]] Then we can start on the onboarding flow.",
  },
  {
    name: "boundary.wav",
    trailingSilenceSeconds: 0.8,
    speech:
      "Email Maria Kowalski at acme dot com slash billing, [[slnc 800]] " +
      "forty two thousand dollars, due March twelfth, [[slnc 700]] twenty twenty six.",
  },
  // A pause, two more words, and a release right after them: the decode started at the pause
  // is stale by the time the key comes up.
  {
    name: "pause-then-speech.wav",
    trailingSilenceSeconds: 0.05,
    speech: "We need to ship the release by Friday. [[slnc 500]] Thanks everyone.",
  },
];

// Synthetic meetings: the user on the mic, the others on system audio. A turn starts `gap`
// seconds after the last one ends, or `overlap` seconds after the previous turn started, for
// crosstalk. An `echo` variant mixes the other side into the mic the way a laptop microphone hears
// its own speakers (see `laptop`). `<prefix>-turns.json` holds who said what when, so
// a run can be scored: every user turn must survive, as itself and once. Numbers are written the
// way the speech model writes them, so the score compares like with like.
/**
 * @typedef {{ gap?: number, overlap?: number }} TurnTiming
 * @typedef {{
 *   prefix: string,
 *   speakers: Record<string, [source: string, voice: string]>,
 *   echo?: string,
 *   turns: [speaker: string, speech: string, timing?: TurnTiming][],
 * }} Meeting
 */
/** @type {Meeting[]} */
const meetings = [
  {
    prefix: "meeting",
    speakers: { you: ["mic", "Daniel"], other: ["system", "Samantha"] },
    echo: "meeting-mic-laptop.wav",
    turns: [
      ["you", "Morning everyone. Let's go through the launch plan for the Kowalski account."],
      ["other", "Sounds good. The beta build is ready, and we fixed forty two bugs last week."],
      ["you", "Great. Can we ship it to the first customers on March twelfth?"],
      ["other", "Yes, if design signs off on the onboarding screens by Friday."],
      ["you", "I'll ask Maria to review them today and send notes tomorrow morning."],
      ["other", "Perfect. I'll update the release checklist and share it in the channel."],
    ],
  },
  {
    prefix: "meeting-two-others",
    speakers: { you: ["mic", "Daniel"], anna: ["system", "Samantha"], tom: ["system", "Ralph"] },
    turns: [
      ["you", "Thanks for joining. Anna, Tom, where are we with the mobile release?"],
      [
        "anna",
        "The iOS build passed review yesterday, and the crash rate is down to half a percent.",
      ],
      [
        "tom",
        "Android is a day behind. We are still waiting on the payment provider to approve the new screens.",
      ],
      [
        "anna",
        "I can help with that. I spoke to their support team last month about the same issue.",
      ],
      [
        "tom",
        "That would be great. If they approve it by Wednesday, we can ship both apps on Thursday.",
      ],
      ["you", "Good. Let's aim for Thursday and check again on Wednesday afternoon."],
      [
        "anna",
        "I will send the release notes to marketing before then, so they can prepare the announcement.",
      ],
      ["tom", "And I will update the store listings with the new screenshots tonight."],
    ],
  },
  {
    // The user repeats what the other side just said, the way people confirm: not echo, and on
    // speakers the echo of the other side must still go.
    prefix: "meeting-repeat-back",
    speakers: { you: ["mic", "Daniel"], other: ["system", "Samantha"] },
    echo: "meeting-repeat-back-mic-laptop.wav",
    turns: [
      ["other", "Can we move the launch to March 12th?"],
      ["you", "March 12th works for me.", { gap: 0.5 }],
      ["other", "The budget for the pilot is $42,000."],
      ["you", "$42,000, right.", { gap: 0.4 }],
      ["other", "Please send the contract to Maria by Friday."],
      ["you", "Maria by Friday. Got it.", { gap: 0.4 }],
      ["other", "So we agree on the plan?"],
      ["you", "Yes.", { gap: 0.4 }],
      ["other", "And Victor owns the legal review."],
      ["you", "Victor owns the legal review. I will follow up with him tomorrow.", { gap: 0.6 }],
    ],
  },
  {
    // The user talks over the other side, whose words the speakers also play into the mic.
    prefix: "meeting-crosstalk",
    speakers: { you: ["mic", "Daniel"], other: ["system", "Samantha"] },
    echo: "meeting-crosstalk-mic-laptop.wav",
    turns: [
      ["you", "Let's go through the renewal before the call ends."],
      [
        "other",
        "The Kowalski renewal is the biggest deal we have this quarter, and the legal team still has not reviewed the final terms of the contract.",
      ],
      ["you", "Sorry, who owns legal review?", { overlap: 3 }],
      ["other", "Victor owns it. He already has the draft."],
      ["you", "Thanks. I will send him the latest numbers today.", { gap: 0.6 }],
    ],
  },
  {
    // A Polish call on laptop speakers: the user answers, talks over the other side twice and
    // repeats a phrase back while it still plays.
    prefix: "meeting-pl-doubletalk",
    speakers: { you: ["mic", "Zosia"], other: ["system", "Zosia"] },
    echo: "meeting-pl-doubletalk-mic-laptop.wav",
    turns: [
      ["other", "Dobra, to lecimy. Pierwsze pytanie dotyczy wdrożenia nowej wersji aplikacji."],
      ["other", "Czy zespół testowy skończył już sprawdzać aplikację mobilną?", { gap: 0.6 }],
      ["you", "Tak, skończyli wczoraj wieczorem i nie znaleźli żadnych poważnych błędów."],
      [
        "other",
        "Świetnie, to super. Szybko poszło. W takim razie wypuszczamy nową wersję w czwartek po południu.",
      ],
      ["you", "Czekaj, w czwartek mam spotkanie z klientem.", { overlap: 2.5 }],
      ["other", "Dobrze, to przesuńmy wydanie na piątek rano, czyli o dziewiątej czasu polskiego."],
      ["you", "Piątek rano mi pasuje. Wyślę zaproszenie do całego zespołu."],
      [
        "other",
        "Jeszcze jedno. Marketing prosi o krótką notatkę dla klientów przed wydaniem, najlepiej do środy.",
      ],
      ["you", "Zapisuję, notatka dla klientów do środy.", { overlap: 3.5 }],
      ["other", "Dzięki, to wszystko z mojej strony. Do usłyszenia w piątek."],
      ["you", "Dzięki, do usłyszenia.", { gap: 0.5 }],
    ],
  },
  {
    // Three voices on system audio, so speaker detection has to tell more than two apart.
    prefix: "meeting-three-others",
    speakers: {
      you: ["mic", "Daniel"],
      anna: ["system", "Samantha"],
      tom: ["system", "Ralph"],
      kate: ["system", "Karen"],
    },
    turns: [
      ["you", "Morning all. Let's start with the roadmap and then the budget."],
      ["anna", "The roadmap is ready. We moved the search work into the second quarter."],
      ["tom", "That works for engineering. The migration finishes at the end of March."],
      ["kate", "Finance needs the new numbers before the board meeting on the twentieth."],
      ["anna", "I can send them on Monday, once the hiring plan is final."],
      ["you", "Good. Tom, is the migration on track?"],
      ["tom", "Mostly. We still wait on the vendor for two of the data exports."],
      ["kate", "If the vendor slips, does the budget for the second quarter change?"],
      ["tom", "Only slightly. We would move about ten thousand dollars into April."],
      ["anna", "Then let's keep the plan and review it again in two weeks."],
      ["kate", "Agreed. I will update the forecast and share it on Friday."],
      ["you", "Thanks everyone. Anna sends the numbers Monday, Kate shares the forecast Friday."],
    ],
  },
];
const gapSeconds = 1.2;

// What a MacBook Pro microphone hears from its own speakers at 60% volume, measured with a
// played Polish meeting: the speech comes back 18.5 dB down, tilted toward 2.5-5 kHz, with a
// strong direct path, a room tail and distortion 16.5 dB below the echo that no linear filter
// predicts. The user's voice sits 6 dB above the echo and 30 dB above the room's noise, at the
// levels the microphone recorded.
const laptop = { userDb: -11.7, clip: 3, delayMs: 40, echoDb: -23.5, noise: 0.0076 };

// A 300 ms impulse response: the direct path, a few early reflections, and a decaying tail
// about 18 dB below the direct path. Seeded, so every run generates the same fixture.
function roomResponse() {
  const rate = 16000;
  const taps = new Float32Array(rate * 0.3);
  let seed = 7;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32 - 0.5;
  };
  taps[0] = 1;
  for (const [ms, gain] of [
    [2.1, 0.3],
    [3.4, -0.22],
    [5.8, 0.17],
    [7.9, -0.12],
  ]) {
    taps[Math.round((ms * rate) / 1000)] += gain;
  }
  for (let i = Math.round(0.005 * rate); i < taps.length; i++) {
    taps[i] += 0.035 * random() * Math.exp(-i / rate / 0.058);
  }
  const data = Buffer.alloc(taps.length * 4);
  taps.forEach((tap, i) => data.writeFloatLE(tap, i * 4));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(32, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
/** @param {Meeting} meeting */
const meetingFixtures = ({ prefix, echo }) => [
  `${prefix}-mic.wav`,
  `${prefix}-system.wav`,
  `${prefix}-turns.json`,
  ...(echo ? [echo] : []),
];

function run(command, args) {
  const result = spawnSync(command, args, { stdio: ["ignore", "inherit", "inherit"] });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
}

function generate(fixture) {
  const target = join(fixturesDir, fixture.name);
  const encode = ["-y", "-loglevel", "error"];
  if ("silenceSeconds" in fixture) {
    run("ffmpeg", [
      ...encode,
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=16000:cl=mono",
      "-t",
      String(fixture.silenceSeconds),
      "-c:a",
      "pcm_s16le",
      target,
    ]);
    return;
  }
  const aiff = join(tmpdir(), `voice-fixture-${process.pid}-${fixture.name}.aiff`);
  try {
    run("say", [...(fixture.voice ? ["-v", fixture.voice] : []), "-o", aiff, fixture.speech]);
    const pad = fixture.trailingSilenceSeconds
      ? ["-af", `apad=pad_dur=${fixture.trailingSilenceSeconds}`]
      : [];
    run("ffmpeg", [
      ...encode,
      "-i",
      aiff,
      ...pad,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      target,
    ]);
  } finally {
    rmSync(aiff, { force: true });
  }
}

function duration(file) {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`ffprobe ${file} exited ${result.status}`);
  return Number(result.stdout.trim());
}

/** @param {Meeting} meeting */
function generateMeeting({ prefix, speakers, echo, turns }) {
  const work = join(tmpdir(), `voice-fixture-${process.pid}-${prefix}`);
  mkdirSync(work, { recursive: true });
  try {
    let previousStart = 0;
    let end = 0.5 - gapSeconds;
    const lines = turns.map(([speaker, speech, { gap = gapSeconds, overlap } = {}], index) => {
      const [source, voice] = /** @type {[string, string]} */ (speakers[speaker]);
      const file = join(work, `${index}.wav`);
      const aiff = join(work, `${index}.aiff`);
      run("say", ["-v", voice, "-o", aiff, speech]);
      run("ffmpeg", ["-y", "-loglevel", "error", "-i", aiff, "-ar", "16000", "-ac", "1", file]);
      const start = overlap === undefined ? end + gap : previousStart + overlap;
      const seconds = duration(file);
      previousStart = start;
      end = Math.max(end, start + seconds);
      return {
        speaker,
        source,
        file,
        speech,
        startMs: Math.round(start * 1000),
        endMs: Math.round((start + seconds) * 1000),
      };
    });
    const total = String(end + gapSeconds);
    writeFileSync(
      join(fixturesDir, `${prefix}-turns.json`),
      `${JSON.stringify(
        lines.map(({ speaker, source, startMs, endMs, speech }) => ({
          speaker,
          source,
          startMs,
          endMs,
          text: speech,
        })),
        null,
        2,
      )}\n`,
    );
    for (const source of ["mic", "system"]) {
      const own = lines.filter((line) => line.source === source);
      const delayed = own.map((line, index) => `[${index}]adelay=${line.startMs}[d${index}]`);
      const mixed = own.map((_, index) => `[d${index}]`).join("");
      run("ffmpeg", [
        "-y",
        "-loglevel",
        "error",
        ...own.flatMap((line) => ["-i", line.file]),
        "-filter_complex",
        `${delayed.join(";")};${mixed}amix=inputs=${own.length}:normalize=0,apad=whole_dur=${total}`,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        join(fixturesDir, `${prefix}-${source}.wav`),
      ]);
    }
    if (!echo) return;
    const room = join(work, "room.wav");
    writeFileSync(room, roomResponse());
    run("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-i",
      join(fixturesDir, `${prefix}-mic.wav`),
      "-i",
      join(fixturesDir, `${prefix}-system.wav`),
      "-i",
      room,
      "-filter_complex",
      [
        `[0]volume=${laptop.userDb}dB[user]`,
        `[1]highpass=f=250,equalizer=f=3500:t=q:w=1:g=6,asoftclip=type=tanh:param=${laptop.clip},adelay=${laptop.delayMs}[played]`,
        `[played][2]afir=irnorm=-1:gtype=-1,volume=${laptop.echoDb}dB[echo]`,
        `anoisesrc=color=pink:amplitude=${laptop.noise}:seed=7:sample_rate=16000:duration=${total}[noise]`,
        "[user][echo][noise]amix=inputs=3:normalize=0:duration=first",
      ].join(";"),
      "-c:a",
      "pcm_s16le",
      join(fixturesDir, echo),
    ]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function ensureFixtures() {
  mkdirSync(fixturesDir, { recursive: true });
  for (const fixture of fixtures) {
    const target = join(fixturesDir, fixture.name);
    if (existsSync(target)) continue;
    generate(fixture);
    console.log(`generated ${target}`);
  }
  for (const meeting of meetings) {
    const names = meetingFixtures(meeting);
    if (names.every((name) => existsSync(join(fixturesDir, name)))) continue;
    generateMeeting(meeting);
    console.log(`generated ${names.join(", ")} in ${fixturesDir}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) ensureFixtures();
