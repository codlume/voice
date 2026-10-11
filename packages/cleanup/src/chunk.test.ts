import { expect, test } from "vite-plus/test";

import { type Chunk, chunkTranscript, stitch } from "./chunk.ts";

const chars = (text: string) => text.length;
const words = (text: string) => text.split(/\s+/).filter(Boolean);
const texts = (chunks: Chunk[]) => chunks.map((chunk) => chunk.text);

function spans(raw: string, pieces: string[]): Chunk[] {
  let from = 0;
  return pieces.map((text) => {
    const start = raw.indexOf(text, from);
    if (start < 0) throw new Error(`${JSON.stringify(text)} is not in the transcript`);
    from = start + text.length;
    return { start, end: from, text };
  });
}

test("keeps a short transcript as one trimmed chunk", () => {
  const raw = "  Call Ada at 3 PM. Then email Bob.\n";
  expect(chunkTranscript(raw, 1000, chars)).toEqual([
    { start: 2, end: 35, text: "Call Ada at 3 PM. Then email Bob." },
  ]);
});

test("returns no chunks for empty or whitespace-only input", () => {
  expect(chunkTranscript("", 1000, chars)).toEqual([]);
  expect(chunkTranscript(" \n\t ", 1000, chars)).toEqual([]);
});

test("splits long input only between sentences", () => {
  const sentences = Array.from(
    { length: 40 },
    (_, i) => `Sentence number ${i + 1} talks about the October 12th beta, doesn't it?`,
  );
  const text = sentences.join(" ");

  const chunks = chunkTranscript(text, 200, chars);

  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) {
    expect(chunk.text.length).toBeLessThanOrEqual(200);
    expect(chunk.text).toMatch(/^Sentence number \d+ .*\?$/);
    expect(chunk.text).toBe(text.slice(chunk.start, chunk.end));
  }
  expect(texts(chunks).join(" ")).toBe(text);
});

test("splits a lowercase run at sentence ends that UAX #29 does not break", () => {
  const sentence = "we ship the beta on monday and the stable release after that";
  const text = Array.from({ length: 6 }, () => sentence).join(". ") + ".";

  const chunks = chunkTranscript(text, sentence.length * 2 + 3, chars);

  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) expect(chunk.text).toMatch(/^we ship .*\.$/);
  expect(stitch(text, chunks, [])).toBe(text);
});

test("keeps a sentence that exactly fits the limit whole", () => {
  const sentence = `${"a".repeat(9)}.`;
  expect(texts(chunkTranscript(`${sentence} ${sentence}`, 10, chars))).toEqual([
    sentence,
    sentence,
  ]);
});

test("splits an oversized unpunctuated run at clause seams rather than mid-clause", () => {
  const text =
    "maria will review the pricing page and send a short update to tom before three, " +
    "then tom will fix the login bug and call the design agency, " +
    "which priya already booked because the budget closes on friday";

  const chunks = chunkTranscript(text, 60, chars);

  expect(chunks.length).toBeGreaterThan(2);
  for (const chunk of chunks.slice(1)) {
    const seam = /^(and|then|which|because)\b/.test(chunk.text) || text[chunk.start - 2] === ",";
    expect(seam, `cut mid-clause at ${JSON.stringify(chunk.text)}`).toBe(true);
  }
  expect(stitch(text, chunks, [])).toBe(text);
});

test("splits an oversized clause at word boundaries", () => {
  const text = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");

  const chunks = chunkTranscript(text, 50, chars);

  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(50);
  expect(texts(chunks).flatMap(words)).toEqual(words(text));
});

test("hard-splits a single word longer than the limit and stitches it back with nothing", () => {
  const url = `https://example.com/${"x".repeat(400)}`;

  const chunks = chunkTranscript(url, 20, chars);

  for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(20);
  expect(stitch(url, chunks, [])).toBe(url);
});

test("stitch keeps the whitespace between chunks verbatim", () => {
  const raw = "a.\n\nb";
  const chunks = chunkTranscript(raw, 2, chars);

  expect(texts(chunks)).toEqual(["a.", "b"]);
  expect(stitch(raw, chunks, [])).toBe(raw);
  expect(stitch(raw, chunks, ["A.", "B."])).toBe("A.\n\nB.");
});

test("line breaks stay outside model input even when both lines fit in one chunk", () => {
  const raw = "call ada\r\n\r\n  send bob\nask priya";
  const chunks = chunkTranscript(raw, 1000, chars);

  expect(texts(chunks)).toEqual(["call ada", "send bob", "ask priya"]);
  expect(stitch(raw, chunks, ["Call Ada", "Send Bob", "Ask Priya."])).toBe(
    "Call Ada\r\n\r\n  Send Bob\nAsk Priya.",
  );
});

test("stitch preserves paragraph capitalization after an unterminated line", () => {
  const raw = "call ada\n\nsend bob";
  const chunks = spans(raw, ["call ada", "send bob"]);

  expect(stitch(raw, chunks, ["Call Ada", "Send Bob."])).toBe("Call Ada\n\nSend Bob.");
});

test("stitch keeps the raw text of a chunk without an output", () => {
  const raw = "call ada and i'll send the notes";
  const chunks = spans(raw, ["call ada and", "i'll send the notes"]);

  expect(stitch(raw, chunks, ["Call Ada and", undefined])).toBe("Call Ada and i'll send the notes");
});

test("stitch lowercases a capital the model put after an unterminated part", () => {
  const raw = "priya will draft the release notes by friday";
  const chunks = spans(raw, ["priya will", "draft the release notes by friday"]);

  expect(stitch(raw, chunks, ["Priya will", "Draft the release notes by Friday."])).toBe(
    "Priya will draft the release notes by Friday.",
  );
});

test("stitch keeps I and its contractions capitalized", () => {
  const raw = "call ada and i'll send the notes";
  const chunks = spans(raw, ["call ada and", "i'll send the notes"]);

  expect(stitch(raw, chunks, ["Call Ada and", "I'll send the notes."])).toBe(
    "Call Ada and I'll send the notes.",
  );
});

test("stitch keeps a capital after a sentence end", () => {
  const raw = "review the page. then email bob";
  const chunks = spans(raw, ["review the page.", "then email bob"]);

  expect(stitch(raw, chunks, ["Review the page.", "Then email Bob."])).toBe(
    "Review the page. Then email Bob.",
  );
});

test("stitch keeps a sentence capital when cleanup drops the preceding period", () => {
  const raw = "call ada. then email bob";
  const chunks = chunkTranscript(raw, 15, chars);

  expect(stitch(raw, chunks, ["Call Ada", "Then email Bob."])).toBe("Call Ada Then email Bob.");
});

test("stitch keeps a capital the user dictated", () => {
  const raw = "call ada and Sofia will review it";
  const chunks = spans(raw, ["call ada and", "Sofia will review it"]);

  expect(stitch(raw, chunks, ["Call Ada and", "Sofia will review it."])).toBe(
    "Call Ada and Sofia will review it.",
  );
});

test("stitch keeps acronym and mixed-case corrections at a mid-sentence seam", () => {
  for (const [rawWord, cleanedWord] of [
    ["api", "API"],
    ["github", "GitHub"],
  ]) {
    const raw = `check the ${rawWord} before release`;
    const chunks = spans(raw, ["check the", `${rawWord} before release`]);
    expect(stitch(raw, chunks, ["Check the", `${cleanedWord} before release.`])).toBe(
      `Check the ${cleanedWord} before release.`,
    );
  }
});

test("stitch drops a chunk cleaned to nothing and folds its gap into the next one", () => {
  const raw = "um uh\n\ncall ada um then email bob";
  const chunks = spans(raw, ["um uh", "call ada", "um", "then email bob"]);

  expect(stitch(raw, chunks, ["", "Call Ada", "", "then email Bob."])).toBe(
    "Call Ada then email Bob.",
  );
});

test("abbreviations do not create sentence capitals at forced seams", () => {
  for (const abbreviation of ["p.m.", "a.m.", "e.g."]) {
    const raw = `we met at 3 ${abbreviation} sharp and agreed to ship next week `.repeat(12).trim();
    const chunks = chunkTranscript(raw, 80, chars);
    const outputs = chunks.map((chunk) => chunk.text[0]!.toUpperCase() + chunk.text.slice(1));
    expect(chunks.length).toBeGreaterThan(1);
    expect(stitch(raw, chunks, outputs)).toBe(raw[0]!.toUpperCase() + raw.slice(1));
  }
});

test("a sentence after an abbreviation keeps its cleaned capital", () => {
  const raw = "we met at three p.m. then we left for dinner";
  const chunks = spans(raw, ["we met at three p.m.", "then we left for dinner"]);
  expect(stitch(raw, chunks, ["We met at three p.m.", "Then we left for dinner."])).toBe(
    "We met at three p.m. Then we left for dinner.",
  );
});

test("chunk seams keep ordinary abbreviations with the following word", () => {
  const raw = "we need paper pens etc. and some envelopes before monday";
  const chunks = chunkTranscript(raw, 23, chars);
  const outputs = chunks.map((chunk) => chunk.text[0]!.toUpperCase() + chunk.text.slice(1));
  expect(chunks.some((chunk) => chunk.text.endsWith("etc."))).toBe(false);
  expect(stitch(raw, chunks, outputs)).toBe(
    "We need paper pens etc. and some envelopes before monday",
  );
});

test.each([" ", "   ", "\t\t\t\t"])(
  "removing filler with %j keeps the next paragraph capitalized",
  (gap) => {
    const continuation = "then " + "review the release notes carefully ".repeat(11) + "on friday";
    const raw = "call ada\n\num" + gap + continuation;
    const chunks = chunkTranscript(raw, 400, chars);
    const outputs = chunks.map(({ text }) =>
      text === "um" ? "" : text[0]!.toUpperCase() + text.slice(1),
    );
    expect(stitch(raw, chunks, outputs)).toBe("Call ada\n\nThen " + continuation.slice(5));
  },
);

test("punctuation inside a split URL does not capitalize its query", () => {
  const raw = "go to example.com/path?foo=bar and continue";
  const chunks = chunkTranscript(raw, 20, chars);
  const outputs = chunks.map(({ text }) => text[0]!.toUpperCase() + text.slice(1));
  expect(stitch(raw, chunks, outputs)).toBe("Go to example.com/path?foo=bar and continue");
});

test("removing filler preserves the preceding raw sentence boundary", () => {
  const first = "call ada about " + "the release notes ".repeat(21) + "today.";
  const next = "then " + "review the release notes carefully ".repeat(11) + "on friday";
  const raw = first + " um " + next;
  const chunks = chunkTranscript(raw, 400, chars);
  const outputs = chunks.map(({ text }) =>
    text === "um" ? "" : text[0]!.toUpperCase() + text.slice(1).replace(/\.$/, ""),
  );
  expect(texts(chunks)).toEqual([first, "um", next]);
  expect(stitch(raw, chunks, outputs)).toBe(outputs[0] + " " + outputs[2]);
});

test.each(["um.", "um. uh"])("removed %j still carries a raw sentence boundary", (filler) => {
  const first = "call ada about " + "the release notes ".repeat(21) + "today";
  const next = "then " + "review the release notes carefully ".repeat(11) + "on friday";
  const raw = first + " " + filler + " " + next;
  const chunks = chunkTranscript(raw, 400, chars);
  const outputs = chunks.map(({ text }) =>
    text === filler ? "" : text[0]!.toUpperCase() + text.slice(1),
  );
  expect(texts(chunks)).toEqual([first, filler, next]);
  expect(stitch(raw, chunks, outputs)).toBe(outputs[0] + " " + outputs[2]);
});

test.each([
  ["(", ")"],
  ["[", "]"],
])("opening %s keeps mid-sentence word casing", (open, close) => {
  const raw = `please check ${open}especially the footer${close} before publishing`;
  const chunks = chunkTranscript(raw, 12, chars);
  const outputs = chunks.map(({ text }) => text.replace(`${open}especially`, `${open}Especially`));
  expect(stitch(raw, chunks, outputs)).toBe(raw);
});
