import type { HelpTopic } from "./types.ts";

export const insightsHelp: HelpTopic = {
  title: "Insights",
  summary:
    "Insights counts what you dictate on this Mac. Voice keeps numbers, dates and app names, never your words.",
  sections: [
    {
      heading: "Pace, words and fixes",
      body: "Pace is your speaking speed over recent dictations, leaving out the quiet before and after you speak. Fixes counts the filler words cleanup removed and the corrections your dictionary made.",
      shot: {
        file: "insights-totals",
        alt: "Three cards: Pace in words per minute, total Words, and Fixes made by Voice.",
        scene: "ready",
        page: "insights",
        clip: "main header + div",
        callouts: [
          { target: "main header + div > :nth-child(1)", label: "Pace" },
          { target: "main header + div > :nth-child(2)", label: "Words" },
          { target: "main header + div > :nth-child(3)", label: "Fixes" },
        ],
      },
    },
    {
      heading: "Streak and activity",
      body: "A streak counts days in a row with at least one dictation. Each square in the activity grid is a day; darker means more words. Tab to the grid, then use the arrow keys to move by day or week.",
      shot: {
        file: "insights-streak",
        alt: "The Streak card with the current and longest streak above a grid of days shaded by words dictated.",
        scene: "ready",
        page: "insights",
        clip: "main header + div + div",
        callouts: [
          {
            target: "main header + div + div > div:nth-child(2)",
            label: "Current and longest streak",
          },
          { target: "main header + div + div > div:nth-child(3)", label: "Words per day" },
        ],
      },
    },
    {
      heading: "Where you dictate",
      body: "This card splits your words by the Style categories and lists your top apps. A website counts under its browser.",
    },
    {
      heading: "Clear your insights",
      body: "Settings › Data and Privacy › Clear deletes every count. Dictation keeps working and counting starts again from zero.",
    },
  ],
};
