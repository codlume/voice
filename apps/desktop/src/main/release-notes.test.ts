import { describe, expect, test } from "vite-plus/test";

import type { ReleaseNotes } from "../shared/api.ts";
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

const release = (version: string) => ({ version, notes: `* ${version}` });
const notesFor = (versions: readonly string[], installedVersion: string) =>
  notesSinceInstalled(
    {
      version: versions[0] ?? "",
      releaseNotes: `* ${versions[0]}`,
      releaseHistory: versions.map(release),
    },
    installedVersion,
  );
const shown = ({ releases, more }: ReleaseNotes) => ({
  versions: releases.map(({ version }) => version),
  more,
});
const stable = (count: number) =>
  Array.from({ length: count }, (_, index) => `0.${count - index}.0`);

describe("release notes for an update", () => {
  test("lists each release newer than the installed version, newest first", () => {
    expect(notesFor(["0.5.0", "0.4.0", "0.3.0", "0.2.0"], "0.3.0")).toEqual({
      releases: [
        { version: "0.5.0", items: ["0.5.0"] },
        { version: "0.4.0", items: ["0.4.0"] },
      ],
      more: false,
    });
  });

  test("leaves out nightlies built before the stable release a user switches from", () => {
    const nightly = [
      "0.5.1-nightly.20261005.1",
      "0.5.1-nightly.20261004.1",
      "0.5.0-nightly.20261003.1",
      "0.5.0-nightly.20261002.1",
    ];
    expect(shown(notesFor(nightly, "0.5.0"))).toEqual({
      versions: ["0.5.1-nightly.20261005.1", "0.5.1-nightly.20261004.1"],
      more: false,
    });
  });

  test("lists nothing the installed version already has when stable is a downgrade", () => {
    const history = ["0.5.0", "0.4.0", "0.3.0"];
    expect(shown(notesFor(history, "0.5.1-nightly.20261005.1"))).toEqual({
      versions: [],
      more: false,
    });
    expect(shown(notesFor(history, "0.4.1-nightly.20261001.3"))).toEqual({
      versions: ["0.5.0"],
      more: false,
    });
    expect(shown(notesFor(history, "0.9.0"))).toEqual({ versions: [], more: false });
  });

  test("shows the six newest releases and says when more were left out", () => {
    const six = ["0.8.0", "0.7.0", "0.6.0", "0.5.0", "0.4.0", "0.3.0"];
    expect(shown(notesFor(stable(8), "0.1.0"))).toEqual({ versions: six, more: true });
    expect(shown(notesFor(stable(8), "0.2.0"))).toEqual({ versions: six, more: false });
  });

  test("says more were left out when the history never reaches the installed version", () => {
    const newest = ["0.14.0", "0.13.0", "0.12.0", "0.11.0", "0.10.0", "0.9.0"];
    expect(shown(notesFor(newest, "0.1.0"))).toEqual({ versions: newest, more: true });
    expect(shown(notesFor(stable(14).slice(0, 10), "0.8.0"))).toEqual({
      versions: newest,
      more: false,
    });
  });

  test("keeps the readable entries of a history with malformed ones", () => {
    const history = [
      release("0.5.0"),
      { version: 4, notes: "* four" },
      { version: "0.4.5", notes: new Date(0) },
      null,
      "* four",
      { version: "four", notes: "* four" },
      release("0.3.0"),
      release("0.2.0"),
    ];
    expect(
      shown(notesSinceInstalled({ version: "0.5.0", releaseHistory: history }, "0.2.0")),
    ).toEqual({ versions: ["0.5.0", "0.3.0"], more: false });
  });

  test("falls back to the feed's own notes when it has no usable history", () => {
    for (const releaseHistory of [undefined, [], "* four", [null], [{ version: 4 }]]) {
      const own = { version: "0.5.0", releaseNotes: "* five", releaseHistory };
      expect(notesSinceInstalled(own, "0.1.0")).toEqual({
        releases: [{ version: "0.5.0", items: ["five"] }],
        more: false,
      });
      expect(notesSinceInstalled(own, "0.5.1-nightly.20261005.1")).toEqual({
        releases: [],
        more: false,
      });
    }
  });

  test("drops releases whose notes have no items", () => {
    const sparse = [
      { version: "0.5.0", notes: "**Full Changelog**: https://example.test" },
      { version: "0.4.0", notes: "* four" },
      { version: "0.3.0", notes: "" },
      release("0.2.0"),
    ];
    expect(notesSinceInstalled({ version: "0.5.0", releaseHistory: sparse }, "0.2.0")).toEqual({
      releases: [{ version: "0.4.0", items: ["four"] }],
      more: false,
    });
  });
});
