import { headingsFor } from "./language.ts";
import type { MeetingSummary, Speaker, SpeakerId } from "./provider.ts";

// A speaker chip: the id survives a rename, the label is what a reader without the speaker list
// sees. Code writes every chip; the model only ever writes plain labels.
const TOKEN = /<voice-speaker id="([^"]*)">([^<]*)<\/voice-speaker>/g;

const escape = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const unescape = (text: string) =>
  text
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");

export const speakerToken = ({ id, label }: Speaker) =>
  `<voice-speaker id="${escape(id)}">${escape(label)}</voice-speaker>`;

/** Swaps every chip for `render(speaker)`, where the label is the one the chip was written with. */
export const replaceSpeakerTokens = (markdown: string, render: (speaker: Speaker) => string) =>
  markdown.replace(TOKEN, (_, id: string, label: string) =>
    render({ id: unescape(id), label: unescape(label) }),
  );

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Chips for the speaker labels free text mentions. The mic's label is left alone: "You" in a
 * sentence is as likely the pronoun as the speaker.
 */
function mentionChips(text: string, speakers: readonly Speaker[]): string {
  const named = speakers
    .filter(({ id, label }) => id !== "you" && label.trim() !== "")
    .toSorted((a, b) => b.label.length - a.label.length);
  if (named.length === 0) return text;
  const byLabel = new Map(named.map((speaker) => [speaker.label, speaker]));
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${named.map(({ label }) => escapeRegExp(label)).join("|")})(?![\\p{L}\\p{N}])`,
    "gu",
  );
  return text.replace(pattern, (label) => speakerToken(byLabel.get(label)!));
}

/**
 * Wispr's shape: the overview paragraph, `### Decisions`, then `### Next Steps` grouped by owner
 * in speaker order, unassigned last. Headings follow the summary's language.
 */
export function renderSummaryMarkdown(
  summary: MeetingSummary,
  speakers: readonly Speaker[],
): { markdown: string; overview: string } {
  const headings = headingsFor(summary.language);
  const inline = (text: string) => mentionChips(text.trim(), speakers);
  const overview = inline(summary.overview);
  const owners: (SpeakerId | null)[] = [...speakers.map(({ id }) => id), null];
  const groups = owners.flatMap((owner) => {
    const tasks = summary.nextSteps.filter((step) => step.owner === owner);
    if (tasks.length === 0) return [];
    const speaker = speakers.find(({ id }) => id === owner);
    const heading = speaker ? speakerToken(speaker) : `**${headings.unassigned}**`;
    return [[heading, ...tasks.map(({ task }) => `- ${inline(task)}`)].join("\n")];
  });
  const sections = overview === "" ? [] : [overview];
  if (summary.decisions.length > 0) {
    sections.push(
      `### ${headings.decisions}`,
      summary.decisions.map((decision) => `- ${inline(decision)}`).join("\n"),
    );
  }
  if (groups.length > 0) sections.push(`### ${headings.nextSteps}`, ...groups);
  return { markdown: `${sections.join("\n\n")}\n`, overview };
}

/**
 * Wispr's rule for a summary with no stored overview, such as one the user edited: the text
 * before the first blank line or heading. A summary that opens with a heading has none.
 */
export function overviewOf(markdown: string): string {
  const first = markdown.split(/\n\n|(?=###)/)[0]!.trim();
  return first.startsWith("#") ? "" : first;
}
