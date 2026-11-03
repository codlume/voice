import assert from "node:assert/strict";
import { test } from "node:test";

import { scoreMeeting } from "./meeting-score.mjs";

const turn = (source, startMs, endMs, text) => ({ source, startMs, endMs, text });
const mic = (startMs, endMs, text) => ({ source: "mic", startMs, endMs, text });
const system = (startMs, endMs, text) => ({ source: "system", startMs, endMs, text });

// meeting-pl-doubletalk-turns.json, as scripts/fixtures.mjs generates it.
const turns = [
  turn(
    "system",
    500,
    5686,
    "Dobra, to lecimy. Pierwsze pytanie dotyczy wdrożenia nowej wersji aplikacji.",
  ),
  turn("system", 6286, 10141, "Czy zespół testowy skończył już sprawdzać aplikację mobilną?"),
  turn(
    "mic",
    11341,
    16154,
    "Tak, skończyli wczoraj wieczorem i nie znaleźli żadnych poważnych błędów.",
  ),
  turn(
    "system",
    17354,
    24166,
    "Świetnie, to super. Szybko poszło. W takim razie wypuszczamy nową wersję w czwartek po południu.",
  ),
  turn("mic", 19854, 23237, "Czekaj, w czwartek mam spotkanie z klientem."),
  turn(
    "system",
    25366,
    30715,
    "Dobrze, to przesuńmy wydanie na piątek rano, czyli o dziewiątej czasu polskiego.",
  ),
  turn("mic", 31915, 36017, "Piątek rano mi pasuje. Wyślę zaproszenie do całego zespołu."),
  turn(
    "system",
    37217,
    43703,
    "Jeszcze jedno. Marketing prosi o krótką notatkę dla klientów przed wydaniem, najlepiej do środy.",
  ),
  turn("mic", 40717, 43835, "Zapisuję, notatka dla klientów do środy."),
  turn("system", 45035, 49513, "Dzięki, to wszystko z mojej strony. Do usłyszenia w piątek."),
  turn("mic", 50013, 52041, "Dzięki, do usłyszenia."),
];
const systemTexts = (...indexes) => indexes.map((index) => turns[index]?.text);

// The final mic lines of a run with the gate on.
const afterFix = [
  mic(11300, 16100, "Tak, skończyli wczoraj wieczorem i nie znaleźli żadnych poważnych błędów."),
  mic(19620, 22900, "Czekaj, czwartek mam spotkanie z klientem."),
  mic(31540, 35540, "Piątek rano mi pasuje. Wyślę zaproszenie do całego zespołu."),
  mic(40500, 43860, "Zapisuję notatka dla klientów do środy."),
  mic(49780, 51540, "Dzięki, do usłyszenia."),
];

test("a clean run keeps the user's words and has no echo or stray words", () => {
  assert.deepEqual(scoreMeeting(turns, afterFix), {
    userTurns: 5,
    userWords: { kept: 34, total: 35 },
    doubleTalkWords: { kept: 12, total: 13 },
    userTurnsLost: [],
    echoKept: [],
    echoWords: 0,
    strayWords: 0,
  });
});

test("decomposed Unicode scores like composed text", () => {
  const decomposed = afterFix.map((line) => ({ ...line, text: line.text.normalize("NFD") }));
  assert.deepEqual(scoreMeeting(turns, decomposed), scoreMeeting(turns, afterFix));
});

test("the run before the fix scores all six echoed system turns, merged lines included", () => {
  const beforeFix = [
    mic(
      500,
      10260,
      "Dobra, to lecimy. Pierwsze pytanie dotyczy wdrożenia nowej wersji aplikacji. Czy zespół testowy skończył już sprawdzać aplikację mobilną?",
    ),
    mic(11140, 16100, "Tak, skończyli wczoraj wieczorem i nie znaleźli żadnych poważnych błędów."),
    mic(
      17380,
      30820,
      "Świetnie, to super. Szybko poszukaj, w takim czasie jak mam uszczękanie z wylicznym. popołudniu. Dobrze, to przesuńmy wydanie na piątek rano, czyli o 9 czasu polskiego.",
    ),
    mic(31700, 36020, "5 rano mi pasuje. Wyślę zaproszenie do całego zespołu."),
    mic(
      36980,
      43620,
      "Jeszcze jedno. Marketing prosi o krótką notatkę dla klienta przed wydaniem notatkę dla jakiejś doświadczeń.",
    ),
    mic(
      44900,
      51460,
      "Dzięki, to wszystko z mojej strony. Do usłyszenia w piątek. Dzięki, do usłyszenia.",
    ),
  ];
  const score = scoreMeeting(turns, beforeFix);
  assert.deepEqual(score.echoKept, systemTexts(0, 1, 3, 5, 7, 9));
  assert.deepEqual(score.userTurnsLost, [turns[4]?.text, turns[8]?.text]);
  assert.deepEqual(score.userWords, { kept: 24, total: 35 });
  assert.deepEqual(score.doubleTalkWords, { kept: 3, total: 13 });
  assert.equal(score.echoWords, 55);
  assert.equal(score.strayWords, 67);
});

test("a word heard seconds before the user says it is stray, not the user's", () => {
  const routeAsSpeakers = [
    mic(11140, 16100, "Tak, skończyli wczoraj wieczorem i nie znaleźli żadnych poważnych błędów."),
    mic(20900, 24420, "czasie jak mam uszczękanie z wylicznym. popołudniu."),
    mic(27460, 27860, "piątek"),
    mic(31700, 36020, "5 rano mi pasuje. Wyślę zaproszenie do całego zespołu."),
    mic(41860, 43620, "notatkę dla jakiejś doświadczeń."),
    mic(49780, 51460, "Dzięki, do usłyszenia."),
  ];
  const score = scoreMeeting(turns, routeAsSpeakers);
  assert.deepEqual(score.userWords, { kept: 23, total: 35 });
  assert.deepEqual(score.doubleTalkWords, { kept: 2, total: 13 });
  assert.deepEqual(score.echoKept, systemTexts(7));
  assert.equal(score.echoWords, 2);
  assert.equal(score.strayWords, 11);
});

test("words the user and the other side both said go to the user", () => {
  const tie = afterFix.with(3, mic(40420, 43860, "Zapisuje, notatka dla klienta do środy."));
  const score = scoreMeeting(turns, tie);
  assert.deepEqual(score.echoKept, []);
  assert.equal(score.echoWords, 0);
  assert.deepEqual(score.userWords, { kept: 32, total: 35 });
});

test("system lines are not scored", () => {
  const systemLines = [
    system(
      500,
      8100,
      "Dobra, to lecimy. Pierwsze pytanie dotyczy wdrożenia nowej wersji aplikacji. Czy zespół testowy skończył już",
    ),
    system(8100, 10180, "sprawdzać aplikację mobilną?"),
    system(
      17380,
      24340,
      "Świetnie, to super, szybko poszło. W takim razie wypuszczamy nową wersję w czwartek po południu.",
    ),
    system(25140, 30820, "Dobrze, to przesuńmy wydanie na 5 rano, czyli o 9 czasu polskiego."),
    system(
      36900,
      43780,
      "Jeszcze jedno, marketing prosi o krótko notatkę dla klientów przed wydaniem, najlepiej do środy.",
    ),
    system(44740, 49060, "Dzięki to wszystko z mojej strony. Do usłyszenia w piątek."),
  ];
  assert.deepEqual(
    scoreMeeting(turns, [...afterFix, ...systemLines]),
    scoreMeeting(turns, afterFix),
  );
});

test("echo that runs on in the user's own line counts as echo and stray", () => {
  const merged = afterFix.with(0, mic(11300, 24100, `${turns[2]?.text} ${turns[3]?.text}`));
  const score = scoreMeeting(turns, merged);
  assert.deepEqual(score.echoKept, systemTexts(3));
  assert.equal(score.echoWords, 15);
  assert.equal(score.strayWords, 15);
  assert.deepEqual(score.userTurnsLost, []);
});

test("echo that leads into the user's line counts as echo and keeps the user's words", () => {
  const lead = afterFix.with(
    0,
    mic(500, 16100, `${turns[0]?.text} ${turns[1]?.text} ${turns[2]?.text}`),
  );
  const score = scoreMeeting(turns, lead);
  assert.deepEqual(score.echoKept, systemTexts(0, 1));
  assert.equal(score.echoWords, 18);
  assert.deepEqual(score.userWords, { kept: 34, total: 35 });
});

test("a lost repeat-back turn stays lost when the echo it repeats is kept", () => {
  const echoInstead = afterFix.with(3, mic(37217, 43703, turns[7]?.text ?? ""));
  const score = scoreMeeting(turns, echoInstead);
  assert.deepEqual(score.userTurnsLost, [turns[8]?.text]);
  assert.deepEqual(score.doubleTalkWords, { kept: 6, total: 13 });
  assert.deepEqual(score.echoKept, systemTexts(7));
});

test("a user turn heard twice counts once", () => {
  const twice = [...afterFix, mic(50500, 52000, "Dzięki, do usłyszenia.")];
  const score = scoreMeeting(turns, twice);
  assert.deepEqual(score.userWords, { kept: 34, total: 35 });
  assert.equal(score.strayWords, 3);
});

test("one word the user shares with the other side is not echo", () => {
  const repeatBack = [
    turn("system", 500, 2752, "Can we move the launch to March 12th?"),
    turn("mic", 3252, 5479, "March 12th works for me."),
  ];
  const score = scoreMeeting(repeatBack, [mic(3200, 5520, "The 12th of March works for me.")]);
  assert.deepEqual(score.echoKept, []);
  assert.equal(score.strayWords, 2);
  assert.deepEqual(score.userWords, { kept: 5, total: 5 });
});
