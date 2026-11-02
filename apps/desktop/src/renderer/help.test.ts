import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { viewHelp } from "./help.ts";

const sources = readdirSync(import.meta.dirname)
  .filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
  .map((name) => readFileSync(`${import.meta.dirname}/${name}`, "utf8"))
  .join("\n");

describe("view help", () => {
  // helpAnchor only takes anchors the content names, so a control can't point at a deleted item.
  // This covers the other side: an item whose control lost its anchor.
  it.each(Object.values(viewHelp).flatMap(({ items }) => items.map(({ anchor }) => anchor)))(
    "puts %s on a control",
    (anchor) => {
      expect(sources).toContain(`"${anchor}"`);
    },
  );
});
