import type { AppPage } from "./HubShell.tsx";

type HelpItem = {
  /** Matches the `data-help` attribute that `helpAnchor` puts on the control. */
  readonly anchor: string;
  readonly title: string;
  readonly body: string;
};

export type ViewHelp = {
  /** The page's name in the nav, for the info button's label. */
  readonly name: string;
  readonly overview: string;
  readonly items: readonly HelpItem[];
};

/** Every page decides: its help, or null to show no info button until its help is written. */
export const viewHelp = {
  home: null,
  meetings: {
    name: "Meetings",
    overview:
      "Voice writes down what you and the others say in a meeting, on this Mac, and summarizes it when you stop.",
    items: [
      {
        anchor: "meetings.start",
        title: "Start a meeting",
        body: "Records your microphone and the other side's audio. Stop it here, from the menu bar, or with your meeting shortcut.",
      },
      {
        anchor: "meetings.settings",
        title: "Meeting settings",
        body: "Set the maximum length, how long meetings are kept, automatic folders, and when the summary opens.",
      },
      {
        anchor: "meetings.tabs",
        title: "Past notes and Folders",
        body: "Past notes lists every meeting by day. Folders shows the meetings you filed together.",
      },
      {
        anchor: "meetings.search",
        title: "Search",
        body: "Finds a meeting by its title, summary, your thoughts, or anything said in it.",
      },
      {
        anchor: "meetings.list",
        title: "Your meetings",
        body: "Click a meeting to read its transcript and summary. Add to folder files it.",
      },
      {
        anchor: "meetings.overview",
        title: "Overview",
        body: "The summary of the meeting you point at. Short meetings get one only when you ask.",
      },
    ],
  },
  insights: {
    name: "Insights",
    overview:
      "Counted on this Mac from your dictations. Voice keeps the numbers and the apps, never your words.",
    items: [
      {
        anchor: "insights.pace",
        title: "Pace",
        body: "How fast you speak in words per minute, compared with typing.",
      },
      {
        anchor: "insights.words",
        title: "Words",
        body: "Every word you have dictated with Voice.",
      },
      {
        anchor: "insights.fixes",
        title: "Fixes made by Voice",
        body: "Words that cleanup and your dictionary corrected for you.",
      },
      {
        anchor: "insights.streak",
        title: "Streak",
        body: "Days in a row you dictated. Each square is a day; darker means more words.",
      },
      {
        anchor: "insights.where",
        title: "Where you dictate",
        body: "Which kinds of apps get your words. Change an app's category in Style.",
      },
    ],
  },
  style: null,
  transforms: null,
  snippets: null,
  dictionary: null,
} as const satisfies Record<AppPage, ViewHelp | null>;

export type HelpPage = {
  [P in AppPage]: (typeof viewHelp)[P] extends null ? never : P;
}[AppPage];

export type HelpAnchor = (typeof viewHelp)[HelpPage]["items"][number]["anchor"];

export const helpFor = (page: AppPage): ViewHelp | null => viewHelp[page];

/** Marks the control a help item points at. help.test.ts checks every item has one. */
export const helpAnchor = (anchor: HelpAnchor) => ({ "data-help": anchor });

export const findAnchor = (anchor: string) =>
  document.querySelector<HTMLElement>(`[data-help="${anchor}"]`);
