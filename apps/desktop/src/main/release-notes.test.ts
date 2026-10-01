import { describe, expect, test } from "vite-plus/test";

import { releaseNoteItems } from "./release-notes.ts";

const generated = `## What's Changed
* feat(desktop): add a **Show Flow Bar** at all times setting by @mhadrys in https://github.com/codlume/voice/pull/120
* fix(desktop): keep \`Voice\` in Cmd-Tab and the Dock by @mhadrys in https://github.com/codlume/voice/pull/116
- docs: link the [release guide](https://github.com/codlume/voice/blob/main/docs/releasing.md) by @new-person in https://github.com/codlume/voice/pull/121

## New Contributors
* @new-person made their first contribution in https://github.com/codlume/voice/pull/121

**Full Changelog**: https://github.com/codlume/voice/compare/v0.1.0...v0.2.0`;

describe("release note items", () => {
  test("turns GitHub-generated notes into plain bullet text", () => {
    expect(releaseNoteItems(generated)).toEqual([
      "feat(desktop): add a Show Flow Bar at all times setting by @mhadrys in #120",
      "fix(desktop): keep Voice in Cmd-Tab and the Dock by @mhadrys in #116",
      "docs: link the release guide by @new-person in #121",
    ]);
  });

  test("ignores the Nightly preamble and a bulleted changelog link", () => {
    const nightly = `Unstable build of 44142cc. Installed Nightlies update themselves.

## What's Changed
* feat(desktop): add keyboard shortcuts by @mhadrys in https://github.com/codlume/voice/pull/119
* Full Changelog: https://github.com/codlume/voice/compare/v0.2.1-nightly.20261001.7...v0.2.1-nightly.20261001.8`;
    expect(releaseNoteItems(nightly)).toEqual([
      "feat(desktop): add keyboard shortcuts by @mhadrys in #119",
    ]);
  });

  test("caps long items and long lists", () => {
    const [item] = releaseNoteItems(`* ${"word ".repeat(100)}`);
    expect(item).toHaveLength(240);
    expect(item).toMatch(/word…$/);
    const many = Array.from({ length: 40 }, (_, index) => `- change ${index}`).join("\n");
    expect(releaseNoteItems(many)).toHaveLength(30);
    expect(releaseNoteItems(many).at(-1)).toBe("change 29");
  });

  test("drops empty, repeated, and non-bullet lines, and anything that is not a string", () => {
    expect(releaseNoteItems("* \n- **\n*not a bullet\n* fix: one\n- **fix: one**")).toEqual([
      "fix: one",
    ]);
    for (const value of [undefined, null, 42, [{ version: "0.2.0", note: "* change" }], {}]) {
      expect(releaseNoteItems(value)).toEqual([]);
    }
  });
});
