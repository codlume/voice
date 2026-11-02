import type { AppPage } from "./HubShell.tsx";

type HelpItem = {
  /** Matches the `data-help` attribute that `helpAnchor` puts on the control. */
  readonly anchor: string;
  readonly title: string;
  readonly body: string;
};

export type ViewHelp = {
  /** The view's name in the nav, for the info button's label. */
  readonly name: string;
  readonly overview: string;
  readonly items: readonly HelpItem[];
};

export const viewHelp = {
  home: {
    name: "Home",
    overview: "Home shows what to set up next and your latest dictations.",
    items: [],
  },
  meetings: {
    name: "Meetings",
    overview:
      "Voice writes down what you and the others say in a meeting, on this Mac, and summarizes it when you stop.",
    items: [
      {
        anchor: "meetings.start",
        title: "Start a meeting",
        body: "Starts recording your microphone and the other side. Stop it from here, the menu bar, or the notepad.",
      },
      {
        anchor: "meetings.settings",
        title: "Meeting settings",
        body: "Choose the shortcut, where recordings are kept, and whether Voice writes a summary.",
      },
      {
        anchor: "meetings.tabs",
        title: "Notes and folders",
        body: "Notes lists every meeting by day. Folders groups the ones you filed together.",
      },
      {
        anchor: "meetings.search",
        title: "Search",
        body: "Finds a meeting by its title, people, or anything said in it.",
      },
      {
        anchor: "meetings.overview",
        title: "Overview",
        body: "Shows the selected meeting's summary. Open the meeting to read the full transcript.",
      },
    ],
  },
  insights: {
    name: "Insights",
    overview:
      "Insights counts your dictations on this Mac. Voice keeps the numbers and the apps, never your words.",
    items: [
      {
        anchor: "insights.pace",
        title: "Pace",
        body: "Your speaking speed in words per minute, compared with typing.",
      },
      {
        anchor: "insights.fixes",
        title: "Fixes made by Voice",
        body: "How many words cleanup and your dictionary corrected for you.",
      },
      {
        anchor: "insights.streak",
        title: "Streak",
        body: "Days in a row you dictated. Each square is a day, darker means more words.",
      },
      {
        anchor: "insights.where",
        title: "Where you dictate",
        body: "Which kinds of apps get your words. Change an app's category in Style.",
      },
    ],
  },
  style: {
    name: "Style",
    overview: "Style sets how cleanup writes for each kind of app.",
    items: [],
  },
  transforms: {
    name: "Transforms",
    overview: "Transforms rewrite selected text with a shortcut.",
    items: [],
  },
  snippets: {
    name: "Snippets",
    overview: "Snippets expand a short phrase into longer text.",
    items: [],
  },
  dictionary: {
    name: "Dictionary",
    overview: "The dictionary teaches Voice names and words.",
    items: [],
  },
} as const satisfies Record<AppPage, ViewHelp>;

export type HelpAnchor = (typeof viewHelp)[AppPage]["items"][number]["anchor"];

/** Marks the control a help item spotlights. The anchor test checks every item has one. */
export const helpAnchor = (anchor: HelpAnchor) => ({ "data-help": anchor });

export const findAnchor = (anchor: string) =>
  document.querySelector<HTMLElement>(`[data-help="${anchor}"]`);
