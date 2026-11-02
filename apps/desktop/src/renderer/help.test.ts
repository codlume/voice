import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { viewHelp } from "./help.ts";

const sources = readdirSync(import.meta.dirname)
  .filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
  .map((name) => readFileSync(`${import.meta.dirname}/${name}`, "utf8"))
  .join("\n");

const anchors = Object.values(viewHelp).flatMap((help) =>
  help ? help.items.map(({ anchor }) => anchor) : [],
);

describe("view help", () => {
  // helpAnchor and the help props only take anchors the content names, so a control can't point
  // at a deleted item. This covers the other side: an item whose control lost its anchor.
  it.each(anchors)("puts %s on a control", (anchor) => {
    expect(sources).toMatch(new RegExp(`(helpAnchor\\(|help=)"${anchor.replace(".", "\\.")}"`));
  });

  it("names each anchor once", () => {
    expect(new Set(anchors).size).toBe(anchors.length);
  });
});
