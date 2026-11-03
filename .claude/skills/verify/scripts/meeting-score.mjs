// Scores a meeting transcript against the fixture's `<prefix>-turns.json`. Each mic line's words
// are claimed by the turns it overlaps in time, longest contiguous run first and the user's turns on
// a tie, so an echo line that repeats the user's repeat-back is still claimed by the system turn it
// copies whole. Words no user turn claims are stray; stray words a system turn claims are echo. A
// system turn claims runs of two or more words, since one shared word ("the", "w") is coincidence.

const MARGIN_MS = 1000;

const meetingWords = (text) =>
  text
    .normalize("NFC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];

const overlaps = (a, b, margin) => a.startMs <= b.endMs + margin && a.endMs >= b.startMs - margin;

const unclaimed = (text) => meetingWords(text).map((word) => ({ word, claimed: false }));

function longestRun(heard, spoken) {
  let best = { length: 0, heardAt: 0, spokenAt: 0 };
  let previous = Array.from({ length: spoken.length + 1 }, () => 0);
  for (const [i, a] of heard.entries()) {
    const row = [0];
    for (const [j, b] of spoken.entries()) {
      const length = !a.claimed && !b.claimed && a.word === b.word ? (previous[j] ?? 0) + 1 : 0;
      row.push(length);
      if (length > best.length)
        best = { length, heardAt: i + 1 - length, spokenAt: j + 1 - length };
    }
    previous = row;
  }
  return best;
}

const claimed = (turn) => turn.words.filter((word) => word.claimed).length;

const tally = (turns) => ({
  kept: turns.reduce((sum, turn) => sum + claimed(turn), 0),
  total: turns.reduce((sum, turn) => sum + turn.words.length, 0),
});

export function scoreMeeting(turns, segments) {
  const spoken = turns.map((turn) => ({ ...turn, words: unclaimed(turn.text) }));
  const user = spoken.filter((turn) => turn.source === "mic");
  const system = spoken.filter((turn) => turn.source === "system");
  let unmatched = 0;
  const lines = segments
    .filter((segment) => segment.source === "mic")
    .toSorted((a, b) => a.startMs - b.startMs);
  for (const line of lines) {
    const heard = unclaimed(line.text);
    const candidates = [...user, ...system].filter((turn) => overlaps(line, turn, MARGIN_MS));
    for (;;) {
      let best;
      for (const turn of candidates) {
        const run = longestRun(heard, turn.words);
        const floor = turn.source === "system" ? 2 : 1;
        if (run.length >= floor && run.length > (best?.run.length ?? 0)) best = { turn, run };
      }
      if (!best) break;
      for (let k = 0; k < best.run.length; k++) {
        heard[best.run.heardAt + k].claimed = true;
        best.turn.words[best.run.spokenAt + k].claimed = true;
      }
    }
    unmatched += heard.filter((word) => !word.claimed).length;
  }
  const echoWords = tally(system).kept;
  return {
    userTurns: user.length,
    userWords: tally(user),
    doubleTalkWords: tally(user.filter((turn) => system.some((other) => overlaps(turn, other, 0)))),
    userTurnsLost: user
      .filter((turn) => claimed(turn) < 0.6 * turn.words.length)
      .map((turn) => turn.text),
    echoKept: system.filter((turn) => claimed(turn) > 0).map((turn) => turn.text),
    echoWords,
    strayWords: unmatched + echoWords,
  };
}
