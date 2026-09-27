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
  test("uses the installed channel for old settings and preserves an explicit selection", () => {
    expect(parseSettings({}, "nightly").updateChannel).toBe("nightly");
    expect(parseSettings({ updateChannel: "beta" }, "nightly").updateChannel).toBe("nightly");
    expect(parseSettings({ updateChannel: "stable" }, "nightly").updateChannel).toBe("stable");
  });
  test("keeps valid fields and defaults the rest, field by field", () => {
    expect(
      parseSettings({
        hotkey: "rightOption",
        cleanup: { enabled: false, styling: "shouty" },
      }),
    ).toEqual({
      hotkey: "rightOption",
      updateChannel: "stable",
      theme: "system",
      cleanup: { enabled: false, styling: "semi-formal" },
    });
  });

  test("drops the retired list and email options from an old settings file", () => {
    expect(parseSettings({ cleanup: { structure: "lists", context: "email" } }).cleanup).toEqual(
      DEFAULT_SETTINGS.cleanup,
    );
  });

  test("keeps a saved styling that differs from the default", () => {
    expect(parseSettings({ cleanup: { styling: "semi-casual" } }).cleanup.styling).toBe(
      "semi-casual",
    );
  });

  test("keeps a saved theme and falls back to system for an unknown one", () => {
    expect(parseSettings({ theme: "dark" }).theme).toBe("dark");
    expect(parseSettings({ theme: "purple" }).theme).toBe("system");
  });

  test.each([null, "text", 42, [], { cleanup: "no" }])("falls back to defaults for %j", (raw) => {
    expect(parseSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });
});

describe("applyPatch", () => {
  test("merges a partial cleanup patch and keeps other fields", () => {
    const formal = applyPatch(DEFAULT_SETTINGS, { cleanup: { styling: "formal" } });
    const next = applyPatch(formal, { cleanup: { enabled: false } });
    expect(next).toEqual({
      hotkey: "fn",
      updateChannel: "stable",
      theme: "system",
      cleanup: { enabled: false, styling: "formal" },
    });
    expect(DEFAULT_SETTINGS.cleanup).toEqual({ enabled: true, styling: "semi-formal" });
  });

  test("changes the hotkey alone", () => {
    expect(applyPatch(DEFAULT_SETTINGS, { hotkey: "rightCommand" }).hotkey).toBe("rightCommand");
  });

  test("changes the theme alone and keeps other fields", () => {
    expect(applyPatch(DEFAULT_SETTINGS, { theme: "light" })).toEqual({
      ...DEFAULT_SETTINGS,
      theme: "light",
    });
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
      updateChannel: "nightly",
      theme: "dark",
      cleanup: { enabled: false },
    });
    await saveSettings(file, settings);
    await expect(loadSettings(file)).resolves.toEqual(settings);
    await expect(readdir(NodePath.dirname(file))).resolves.toEqual(["settings.json"]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(settings);
  });
});
