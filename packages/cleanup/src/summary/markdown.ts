import { UNASSIGNED } from "./ledger.ts";
import type { MeetingSummary, Speaker, SpeakerId } from "./provider.ts";

/**
 * How a summary names a speaker: the id, never the name, so a rename shows in the summary without
 * regenerating it. Code writes every token; the model only ever writes plain labels.
 */
export const speakerToken = (id: SpeakerId) => `{{speaker:${id}}}`;

/** Matches `speakerToken`; group 1 is the id. */
export const SPEAKER_TOKEN = /\{\{speaker:([A-Za-z0-9_-]+)\}\}/g;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Tokens for the speaker labels free text mentions. The mic's label is left alone: "You" in a
 * sentence is as likely the pronoun as the speaker.
 */
function mentionTokens(text: string, speakers: readonly Speaker[]): string {
  const named = speakers
    .filter(({ id, label }) => id !== "you" && label.trim() !== "")
    .toSorted((a, b) => b.label.length - a.label.length);
  if (named.length === 0) return text;
  const byLabel = new Map(named.map((speaker) => [speaker.label, speaker.id]));
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${named.map(({ label }) => escapeRegExp(label)).join("|")})(?![\\p{L}\\p{N}])`,
    "gu",
  );
  return text.replace(pattern, (label) => speakerToken(byLabel.get(label)!));
}

/**
 * Wispr's shape: the overview paragraph, `### Decisions`, then `### Next Steps` grouped by owner
 * in speaker order, unassigned last. Headings are English in every language, as Wispr writes
 * them; the text under them is in the meeting's language.
 */
export function renderSummaryMarkdown(
  summary: MeetingSummary,
  speakers: readonly Speaker[],
): string {
  const inline = (text: string) => mentionTokens(text.trim(), speakers);
  const overview = inline(summary.overview);
  const owners: (SpeakerId | null)[] = [...speakers.map(({ id }) => id), null];
  const groups = owners.flatMap((owner) => {
    const tasks = summary.nextSteps.filter((step) => step.owner === owner);
    if (tasks.length === 0) return [];
    const heading = `**${owner === null ? UNASSIGNED : speakerToken(owner)}**`;
    return [[heading, ...tasks.map(({ task }) => `- ${inline(task)}`)].join("\n")];
  });
  const sections = overview === "" ? [] : [overview];
  if (summary.decisions.length > 0) {
    sections.push(
      "### Decisions",
      summary.decisions.map((decision) => `- ${inline(decision)}`).join("\n"),
    );
  }
  if (groups.length > 0) sections.push("### Next Steps", ...groups);
  return `${sections.join("\n\n")}\n`;
}
