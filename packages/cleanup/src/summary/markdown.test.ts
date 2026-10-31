import { expect, test } from "vite-plus/test";

import { detectLanguage } from "./language.ts";
import { renderSummaryMarkdown, SPEAKER_TOKEN } from "./markdown.ts";
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

test("renders Wispr's shape with every speaker as a token written by code", () => {
  expect(renderSummaryMarkdown(summary, speakers)).toBe(
    [
      "The hotfix ships today. {{speaker:s1}} fixes the export and You review it.",
      "",
      "### Decisions",
      "",
      "- Ship 4.12.1 as a hotfix today.",
      "- Column reordering moves to next sprint.",
      "",
      "### Next Steps",
      "",
      "**{{speaker:you}}**",
      "- Review the PR.",
      "",
      "**{{speaker:s1}}**",
      "- Open the PR by 2 pm, as {{speaker:s2}} asked.",
      "",
      "**Unassigned**",
      "- Tell the support team.",
      "",
    ].join("\n"),
  );
});

test("a rename needs no regeneration: tokens resolve to the current name", () => {
  const names = new Map([
    ["you", "You"],
    ["s1", "Anna"],
    ["s2", "Speaker 2"],
  ]);

  const renamed = renderSummaryMarkdown(summary, speakers).replace(SPEAKER_TOKEN, (_, id: string) =>
    names.get(id)!,
  );

  expect(renamed).toContain("**Anna**\n- Open the PR");
  expect(renamed).toContain("as Speaker 2 asked");
  expect(renamed).not.toContain("{{speaker:");
});

test("a label is matched whole, so Speaker 1 is not found inside Speaker 12", () => {
  const many: Speaker[] = [
    { id: "s1", label: "Speaker 1" },
    { id: "s12", label: "Speaker 12" },
  ];
  const markdown = renderSummaryMarkdown(
    { ...summary, overview: "Speaker 12 and Speaker 1 agreed.", decisions: [], nextSteps: [] },
    many,
  );

  expect(markdown).toBe("{{speaker:s12}} and {{speaker:s1}} agreed.\n");
});

test("Polish headings, and empty sections left out", () => {
  const markdown = renderSummaryMarkdown(
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

test.each([
  ["so we will ship the fix and the notes go out with it", "en"],
  ["no dobra, to się jeszcze nie da, ale już mamy plan na piątek", "pl"],
  ["wir haben das nicht gemacht und ich bin auch dafür", "de"],
  ["", "en"],
])("detects %j as %s", (text, language) => {
  expect(detectLanguage(text)).toBe(language);
});
