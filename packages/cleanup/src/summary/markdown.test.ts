import { expect, test } from "vite-plus/test";

import { detectLanguage } from "./language.ts";
import {
  overviewOf,
  renderSummaryMarkdown,
  replaceSpeakerTokens,
  speakerToken,
} from "./markdown.ts";
import type { MeetingSummary, Speaker } from "./provider.ts";

const speakers: Speaker[] = [
  { id: "you", label: "You" },
  { id: "s1", label: "Speaker 1" },
  { id: "s2", label: "Speaker 2" },
];

const summary: MeetingSummary = {
  title: null,
  language: "en",
  overview: "The hotfix ships today. Speaker 1 fixes the export and You review it.",
  decisions: ["Ship 4.12.1 as a hotfix today.", "Column reordering moves to next sprint."],
  nextSteps: [
    { owner: "s1", task: "Open the PR by 2 pm, as Speaker 2 asked." },
    { owner: null, task: "Tell the support team." },
    { owner: "you", task: "Review the PR." },
  ],
};

test("renders Wispr's shape with every speaker as a chip written by code", () => {
  const { markdown, overview } = renderSummaryMarkdown(summary, speakers);

  expect(markdown).toBe(
    [
      'The hotfix ships today. <voice-speaker id="s1">Speaker 1</voice-speaker> fixes the export and You review it.',
      "",
      "### Decisions",
      "",
      "- Ship 4.12.1 as a hotfix today.",
      "- Column reordering moves to next sprint.",
      "",
      "### Next Steps",
      "",
      '<voice-speaker id="you">You</voice-speaker>',
      "- Review the PR.",
      "",
      '<voice-speaker id="s1">Speaker 1</voice-speaker>',
      '- Open the PR by 2 pm, as <voice-speaker id="s2">Speaker 2</voice-speaker> asked.',
      "",
      "**Unassigned**",
      "- Tell the support team.",
      "",
    ].join("\n"),
  );
  expect(overview).toBe(markdown.split("\n\n")[0]);
});

test("a rename needs no regeneration: chips resolve to the current name", () => {
  const { markdown } = renderSummaryMarkdown(summary, speakers);
  const names = new Map([["s1", "Anna"]]);

  const renamed = replaceSpeakerTokens(
    markdown,
    ({ id, label }) => `**${names.get(id) ?? label}**`,
  );

  expect(renamed).toContain("**Anna**\n- Open the PR");
  expect(renamed).toContain("as **Speaker 2** asked");
  expect(renamed).not.toContain("<voice-speaker");
});

test("a label is matched whole, so Speaker 1 is not found inside Speaker 12", () => {
  const many: Speaker[] = [
    { id: "s1", label: "Speaker 1" },
    { id: "s12", label: "Speaker 12" },
  ];
  const { markdown } = renderSummaryMarkdown(
    { ...summary, overview: "Speaker 12 and Speaker 1 agreed.", decisions: [], nextSteps: [] },
    many,
  );

  expect(markdown).toBe(
    '<voice-speaker id="s12">Speaker 12</voice-speaker> and <voice-speaker id="s1">Speaker 1</voice-speaker> agreed.\n',
  );
});

test("a chip survives labels with markup characters", () => {
  const token = speakerToken({ id: 'a"b', label: "<Ann & Bob>" });

  expect(replaceSpeakerTokens(token, ({ id, label }) => `${id}|${label}`)).toBe('a"b|<Ann & Bob>');
});

test("Polish headings, and empty sections left out", () => {
  const { markdown } = renderSummaryMarkdown(
    {
      ...summary,
      language: "pl",
      decisions: [],
      nextSteps: [{ owner: null, task: "Zadzwonić do Kasi." }],
    },
    speakers,
  );

  expect(markdown).not.toContain("### Decyzje");
  expect(markdown).toContain("### Następne kroki\n\n**Bez przypisania**\n- Zadzwonić do Kasi.");
});

test("overviewOf takes the first paragraph, as Wispr does for an edited summary", () => {
  expect(overviewOf("We ship today.\nIt is small.\n\n### Decisions\n- Ship")).toBe(
    "We ship today.\nIt is small.",
  );
  expect(overviewOf("### Decisions\n- Ship")).toBe("");
});

test.each([
  ["so we will ship the fix and the notes go out with it", "en"],
  ["no dobra, to się jeszcze nie da, ale już mamy plan na piątek", "pl"],
  ["wir haben das nicht gemacht und ich bin auch dafür", "de"],
  ["", "en"],
])("detects %j as %s", (text, language) => {
  expect(detectLanguage(text)).toBe(language);
});
