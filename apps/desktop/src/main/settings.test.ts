import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import {
  applyPatch,
  DEFAULT_SETTINGS,
  loadSettings,
  parseSettings,
  saveSettings,
} from "./settings.ts";

describe("parseSettings", () => {
  test("keeps valid fields and defaults the rest, field by field", () => {
    expect(
      parseSettings({
        hotkey: "rightOption",
        cleanup: { enabled: false, styling: "shouty", structure: "lists", context: 7 },
      }),
    ).toEqual({
      hotkey: "rightOption",
      cleanup: { enabled: false, styling: "semi-casual", structure: "lists", context: "general" },
    });
  });

  test.each([null, "text", 42, [], { cleanup: "no" }])("falls back to defaults for %j", (raw) => {
    expect(parseSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });
});

describe("applyPatch", () => {
  test("merges a partial cleanup patch and keeps other fields", () => {
    const next = applyPatch(DEFAULT_SETTINGS, { cleanup: { context: "email" } });
    expect(next).toEqual({
      hotkey: "fn",
      cleanup: { enabled: true, styling: "semi-casual", structure: "prose", context: "email" },
    });
    expect(DEFAULT_SETTINGS.cleanup.context).toBe("general");
  });

  test("changes the hotkey alone", () => {
    expect(applyPatch(DEFAULT_SETTINGS, { hotkey: "rightCommand" }).hotkey).toBe("rightCommand");
  });
});

describe("load and save", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(NodePath.join(tmpdir(), "voice-settings-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  test("a missing file yields defaults", async () => {
    await expect(loadSettings(NodePath.join(dir, "settings.json"))).resolves.toEqual(
      DEFAULT_SETTINGS,
    );
  });

  test("a corrupt file yields defaults", async () => {
    const file = NodePath.join(dir, "settings.json");
    await writeFile(file, "{ this is not json");
    await expect(loadSettings(file)).resolves.toEqual(DEFAULT_SETTINGS);
  });

  test("save then load round-trips through a nested directory and leaves no temp file", async () => {
    const file = NodePath.join(dir, "nested", "settings.json");
    const settings = applyPatch(DEFAULT_SETTINGS, {
      hotkey: "rightOption",
      cleanup: { enabled: false },
    });
    await saveSettings(file, settings);
    await expect(loadSettings(file)).resolves.toEqual(settings);
    await expect(readdir(NodePath.dirname(file))).resolves.toEqual(["settings.json"]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(settings);
  });
});
