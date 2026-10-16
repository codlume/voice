import { describe, expect, test } from "vite-plus/test";

import { notesSinceInstalled, releaseNoteItems } from "./release-notes.ts";

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

const feed = (releaseHistory: unknown) => ({
  version: "0.5.0",
  releaseNotes: "* five",
  releaseHistory,
});

describe("release notes for an update", () => {
  const history = [
    { version: "0.5.0", notes: "* five" },
    { version: "0.4.0", notes: "* four" },
    { version: "0.3.0", notes: "* three" },
    { version: "0.2.0", notes: "* two" },
  ];

  test("lists each release newer than the installed version, newest first", () => {
    expect(notesSinceInstalled(feed(history), "0.3.0")).toEqual({
      releases: [
        { version: "0.5.0", items: ["five"] },
        { version: "0.4.0", items: ["four"] },
      ],
      omitted: 0,
    });
  });

  test("stops at an installed release that shipped without notes", () => {
    const withBlank = [history[0], history[1], { version: "0.3.0", notes: "" }, history[3]];
    expect(
      notesSinceInstalled(feed(withBlank), "0.3.0").releases.map(({ version }) => version),
    ).toEqual(["0.5.0", "0.4.0"]);
  });

  test("lists the whole history when the installed version is older than all of it", () => {
    expect(
      notesSinceInstalled(feed(history), "0.1.0").releases.map(({ version }) => version),
    ).toEqual(["0.5.0", "0.4.0", "0.3.0", "0.2.0"]);
  });

  test("falls back to the feed's own notes when it has no usable history", () => {
    const single = { releases: [{ version: "0.5.0", items: ["five"] }], omitted: 0 };
    for (const malformed of [
      undefined,
      [],
      "* four",
      [{ version: "0.4.0", notes: "* four" }, { version: 4 }],
      [{ version: "0.4.0" }],
      [null],
    ]) {
      expect(notesSinceInstalled(feed(malformed), "0.1.0")).toEqual(single);
    }
    expect(notesSinceInstalled({ version: "0.5.0" }, "0.1.0")).toEqual({
      releases: [],
      omitted: 0,
    });
    expect(notesSinceInstalled(null, "0.1.0")).toEqual({ releases: [], omitted: 0 });
  });

  test("shows the six newest releases and counts the rest", () => {
    const long = Array.from({ length: 9 }, (_, index) => ({
      version: `0.${9 - index}.0`,
      notes: `* change ${9 - index}`,
    }));
    const notes = notesSinceInstalled(feed(long), "0.0.1");
    expect(notes.releases.map(({ version }) => version)).toEqual([
      "0.9.0",
      "0.8.0",
      "0.7.0",
      "0.6.0",
      "0.5.0",
      "0.4.0",
    ]);
    expect(notes.omitted).toBe(3);
  });

  test("drops releases whose notes have no items, without counting them", () => {
    const sparse = [
      { version: "0.5.0", notes: "**Full Changelog**: https://example.test" },
      { version: "0.4.0", notes: "* four" },
      { version: "0.3.0", notes: "" },
    ];
    expect(notesSinceInstalled(feed(sparse), "0.2.0")).toEqual({
      releases: [{ version: "0.4.0", items: ["four"] }],
      omitted: 0,
    });
  });
});
