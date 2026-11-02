import type { AppPage } from "../HubShell.tsx";

/** A numbered marker on a shot. `target` is a CSS selector in the preview page; the capture script resolves it. */
export type HelpCallout = { target: string; label: string };

/**
 * A screenshot of the preview harness (`preview.html?hub=<scene>&page=<page>`), cropped to the
 * element `clip` matches. `scripts/help-shots.mjs` captures it and records where each callout lands.
 */
export type HelpShot = {
  file: string;
  alt: string;
  scene: string;
  page: AppPage;
  clip: string;
  callouts: readonly HelpCallout[];
};

export type HelpSection = { heading: string; body: string; shot?: HelpShot };

export type HelpTopic = { title: string; summary: string; sections: readonly HelpSection[] };

export type ShotLayout = {
  width: number;
  height: number;
  callouts: readonly { x: number; y: number }[];
};
