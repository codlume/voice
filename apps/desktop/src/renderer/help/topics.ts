import type { AppPage } from "../HubShell.tsx";
import { insightsHelp } from "./insights.ts";
import { meetingsHelp } from "./meetings.ts";
import type { HelpTopic } from "./types.ts";

const stub = (title: string): HelpTopic => ({
  title,
  summary: `Help for ${title} is not written yet.`,
  sections: [],
});

// A Record, so a page added to the nav without help fails the typecheck.
export const helpTopics: Record<AppPage, HelpTopic> = {
  home: stub("Home"),
  meetings: meetingsHelp,
  insights: insightsHelp,
  style: stub("Style"),
  transforms: stub("Transforms"),
  snippets: stub("Snippets"),
  dictionary: stub("Dictionary"),
};
