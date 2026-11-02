import type { AppPage } from "./HubShell.tsx";

/** One thing the help explains, tied to the control that shows it through `data-help`. */
type HelpItem = { anchor: string; title: string; body: string };
type ViewHelp = { intro: string; items: readonly HelpItem[] };

export const viewHelp = {
  meetings: {
    intro:
      "Meetings records you and the people you talk to, writes it down on this Mac, and summarizes it when you stop.",
    items: [
      {
        anchor: "meetings.start",
        title: "Start a meeting",
        body: "Records your microphone and the other side of the call. Tell the others you are recording.",
      },
      {
        anchor: "meetings.settings",
        title: "Meeting settings",
        body: "Choose how long meetings are kept and whether Voice reminds you to ask for consent.",
      },
      {
        anchor: "meetings.tabs",
        title: "Past notes and folders",
        body: "Past notes lists every meeting by day. Folders groups the ones you filed.",
      },
      {
        anchor: "meetings.search",
        title: "Search",
        body: "Finds words in titles, notes, summaries, and transcripts.",
      },
      {
        anchor: "meetings.list",
        title: "Your meetings",
        body: "Point at a meeting to preview it. Click it to open the summary and transcript.",
      },
      {
        anchor: "meetings.overview",
        title: "Overview",
        body: "The summary's overview for the meeting you point at, without opening it.",
      },
    ],
  },
  insights: {
    intro:
      "Insights counts your dictations on this Mac. It keeps numbers and app names, never your words.",
    items: [
      {
        anchor: "insights.pace",
        title: "Pace",
        body: "Words per minute over your recent dictations, compared with typing.",
      },
      {
        anchor: "insights.words",
        title: "Words",
        body: "Every word you have dictated since Voice started counting.",
      },
      {
        anchor: "insights.fixes",
        title: "Fixes made by Voice",
        body: "Filler words cleanup removed and spellings your dictionary corrected.",
      },
      {
        anchor: "insights.streak",
        title: "Streak and activity",
        body: "Days in a row you dictated, and a square per day that darkens with more words.",
      },
      {
        anchor: "insights.where",
        title: "Where you dictate",
        body: "Which kinds of apps get your words, and your top apps by share.",
      },
    ],
  },
  home: null,
  style: null,
  transforms: null,
  snippets: null,
  dictionary: null,
} as const satisfies Record<AppPage, ViewHelp | null>;

export type HelpAnchor = NonNullable<(typeof viewHelp)[AppPage]>["items"][number]["anchor"];

/** Marks the element a help item highlights. */
export const helpAnchor = (anchor: HelpAnchor) => ({ "data-help": anchor });

export const findAnchor = (anchor: HelpAnchor) =>
  document.querySelector<HTMLElement>(`[data-help="${anchor}"]`);
