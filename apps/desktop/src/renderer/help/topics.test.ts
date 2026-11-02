import { existsSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { shotLayouts } from "./shots.ts";
import { helpTopics } from "./topics.ts";

const shots = Object.values(helpTopics).flatMap((topic) =>
  topic.sections.flatMap((section) => (section.shot ? [section.shot] : [])),
);

describe("help topics", () => {
  it("captures every shot, with one pin per callout", () => {
    for (const shot of shots) {
      expect(existsSync(new URL(`./shots/${shot.file}.png`, import.meta.url)), shot.file).toBe(
        true,
      );
      expect(shotLayouts[shot.file]?.callouts, shot.file).toHaveLength(shot.callouts.length);
    }
  });

  it("keeps no layout for a shot that no topic uses", () => {
    const used = new Set(shots.map((shot) => shot.file));
    expect(Object.keys(shotLayouts).filter((file) => !used.has(file))).toEqual([]);
  });
});
