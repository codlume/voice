import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import { dictationLanguages } from "../shared/dictation-language.ts";
import {
  applyPatch,
  DEFAULT_SETTINGS,
  loadSettings,
  parseSettings,
  saveSettings,
} from "./settings.ts";

describe("parseSettings", () => {
  test.each([undefined, null, "true", "false", 0, 1, {}, []])(
    "defaults invalid mute preference %j to false",
    (muteWhileDictating) => {
      expect(parseSettings({ muteWhileDictating }).muteWhileDictating).toBe(false);
    },
  );
  test.each([true, false])("keeps boolean mute preference %j", (muteWhileDictating) => {
    expect(parseSettings({ muteWhileDictating }).muteWhileDictating).toBe(muteWhileDictating);
  });
  test.each([undefined, null, "true", "false", 0, 1, {}, []])(
    "defaults missing or invalid copy-to-clipboard preference %j to off",
    (copyToClipboard) => {
      expect(parseSettings({ copyToClipboard }).copyToClipboard).toBe(false);
    },
  );
  test.each([true, false])("keeps boolean copy-to-clipboard preference %j", (copyToClipboard) => {
    expect(parseSettings({ copyToClipboard }).copyToClipboard).toBe(copyToClipboard);
  });
  test.each([undefined, null, "true", "false", 0, 1, {}, []])(
    "defaults missing or invalid Dock preference %j to shown",
    (showInDock) => {
      expect(parseSettings({ showInDock }).showInDock).toBe(true);
    },
  );
  test("keeps an explicit off for show in Dock", () => {
    expect(parseSettings({ showInDock: false }).showInDock).toBe(false);
  });
  test.each([undefined, null, "true", "false", 0, 1, {}, []])(
    "defaults missing or invalid Flow Bar preference %j to always shown",
    (alwaysShowPill) => {
      expect(parseSettings({ alwaysShowPill }).alwaysShowPill).toBe(true);
    },
  );
  test("keeps an explicit off for show Flow Bar at all times", () => {
    expect(parseSettings({ alwaysShowPill: false }).alwaysShowPill).toBe(false);
  });
  test.each([undefined, null, "", "xx", "English", 42, {}, ["pl"]])(
    "defaults missing or invalid dictation language %j to English",
    (dictationLanguage) => {
      expect(parseSettings({ dictationLanguage }).dictationLanguage).toBe("en");
    },
  );
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
      microphone: null,
      muteWhileDictating: false,
      copyToClipboard: false,
      showInDock: true,
      alwaysShowPill: true,
      dictationLanguage: "en",
      cleanup: { enabled: false, styling: "semi-formal" },
      diagnostics: "off",
      zoomLevel: 0,
    });
  });

  test.each([undefined, null, true, "yes", "ON", 1, {}, "unanswered"])(
    "treats a missing or invalid diagnostics choice %j as off",
    (diagnostics) => {
      expect(parseSettings({ diagnostics }).diagnostics).toBe("off");
    },
  );

  test.each(["on", "off"] as const)("keeps a saved diagnostics choice %j", (diagnostics) => {
    expect(parseSettings({ diagnostics }).diagnostics).toBe(diagnostics);
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
  test("mute preference survives unrelated patches and can be turned back off", () => {
    const enabled = applyPatch(DEFAULT_SETTINGS, { muteWhileDictating: true });
    expect(applyPatch(enabled, { theme: "dark" }).muteWhileDictating).toBe(true);
    expect(applyPatch(enabled, { muteWhileDictating: false })).toEqual(DEFAULT_SETTINGS);
  });
  test("copy-to-clipboard is off by default, survives unrelated patches, and can be turned back off", () => {
    expect(DEFAULT_SETTINGS.copyToClipboard).toBe(false);
    const enabled = applyPatch(DEFAULT_SETTINGS, { copyToClipboard: true });
    expect(enabled).toEqual({ ...DEFAULT_SETTINGS, copyToClipboard: true });
    expect(applyPatch(enabled, { theme: "dark" }).copyToClipboard).toBe(true);
    expect(applyPatch(enabled, { copyToClipboard: false })).toEqual(DEFAULT_SETTINGS);
  });
  test("changes language without losing cleanup preference and retains it across unrelated patches", () => {
    const polish = applyPatch(DEFAULT_SETTINGS, { dictationLanguage: "pl" });
    expect(polish).toEqual({ ...DEFAULT_SETTINGS, dictationLanguage: "pl" });
    expect(applyPatch(polish, { theme: "dark" })).toEqual({ ...polish, theme: "dark" });
    expect(applyPatch(polish, { dictationLanguage: "en" })).toEqual(DEFAULT_SETTINGS);
  });
  test("merges a partial cleanup patch and keeps other fields", () => {
    const formal = applyPatch(DEFAULT_SETTINGS, { cleanup: { styling: "formal" } });
    const next = applyPatch(formal, { cleanup: { enabled: false } });
    expect(next).toEqual({
      hotkey: "fn",
      updateChannel: "stable",
      theme: "system",
      microphone: null,
      muteWhileDictating: false,
      copyToClipboard: false,
      showInDock: true,
      alwaysShowPill: true,
      dictationLanguage: "en",
      cleanup: { enabled: false, styling: "formal" },
      diagnostics: "off",
      zoomLevel: 0,
    });
    expect(DEFAULT_SETTINGS.cleanup).toEqual({ enabled: true, styling: "semi-formal" });
  });

  test("answers diagnostics either way, keeps the answer across unrelated patches", () => {
    const on = applyPatch(DEFAULT_SETTINGS, { diagnostics: "on" });
    expect(on).toEqual({ ...DEFAULT_SETTINGS, diagnostics: "on" });
    expect(applyPatch(on, { theme: "dark" }).diagnostics).toBe("on");
    expect(applyPatch(on, { diagnostics: "off" })).toEqual({
      ...DEFAULT_SETTINGS,
      diagnostics: "off",
    });
  });

  test("turns show in Dock off and back on, and keeps it through other changes", () => {
    const hidden = applyPatch(DEFAULT_SETTINGS, { showInDock: false });
    expect(hidden).toEqual({ ...DEFAULT_SETTINGS, showInDock: false });
    expect(applyPatch(hidden, { theme: "dark" })).toEqual({ ...hidden, theme: "dark" });
    expect(applyPatch(hidden, { showInDock: true })).toEqual(DEFAULT_SETTINGS);
  });

  test("turns show Flow Bar at all times off and back on, and keeps it through other changes", () => {
    const hidden = applyPatch(DEFAULT_SETTINGS, { alwaysShowPill: false });
    expect(hidden).toEqual({ ...DEFAULT_SETTINGS, alwaysShowPill: false });
    expect(applyPatch(hidden, { theme: "dark" })).toEqual({ ...hidden, theme: "dark" });
    expect(applyPatch(hidden, { alwaysShowPill: true })).toEqual(DEFAULT_SETTINGS);
  });

  test("zooms and resets, and keeps the zoom through other changes", () => {
    const zoomed = applyPatch(DEFAULT_SETTINGS, { zoomLevel: -1 });
    expect(zoomed).toEqual({ ...DEFAULT_SETTINGS, zoomLevel: -1 });
    expect(applyPatch(zoomed, { theme: "dark" })).toEqual({ ...zoomed, theme: "dark" });
    expect(applyPatch(zoomed, { zoomLevel: 0 })).toEqual(DEFAULT_SETTINGS);
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

  test.each([true, false])(
    "persists mute preference %j across reloads",
    async (muteWhileDictating) => {
      const file = NodePath.join(dir, "settings.json");
      await saveSettings(file, applyPatch(DEFAULT_SETTINGS, { muteWhileDictating }));
      expect(loadSettings(file).muteWhileDictating).toBe(muteWhileDictating);
    },
  );

  test.each(dictationLanguages)("persists $label across reloads", async ({ value }) => {
    const file = NodePath.join(dir, "settings.json");
    const settings = applyPatch(DEFAULT_SETTINGS, { dictationLanguage: value });
    expect(settings.dictationLanguage).toBe(value);
    await saveSettings(file, settings);
    expect(loadSettings(file)).toEqual(settings);
  });

  test("migrates a saved settings file without a language to English", async () => {
    const file = NodePath.join(dir, "settings.json");
    await writeFile(file, JSON.stringify({ cleanup: { enabled: false, styling: "casual" } }));
    expect(loadSettings(file)).toMatchObject({
      dictationLanguage: "en",
      cleanup: { enabled: false, styling: "casual" },
    });
  });

  test("a missing file yields defaults", () => {
    expect(loadSettings(NodePath.join(dir, "settings.json"))).toEqual(DEFAULT_SETTINGS);
  });

  test("a settings file from before diagnostics loads as off", async () => {
    const file = NodePath.join(dir, "settings.json");
    const { diagnostics: _, ...older } = applyPatch(DEFAULT_SETTINGS, { theme: "dark" });
    await writeFile(file, JSON.stringify(older));
    expect(loadSettings(file)).toEqual({ ...older, diagnostics: "off" });
  });

  test("a settings file from before zoom opens at 100%", async () => {
    const file = NodePath.join(dir, "settings.json");
    const { zoomLevel: _, ...older } = applyPatch(DEFAULT_SETTINGS, { theme: "dark" });
    await writeFile(file, JSON.stringify(older));
    expect(loadSettings(file)).toEqual({ ...older, zoomLevel: 0 });
  });

  test("a corrupt file yields defaults", async () => {
    const file = NodePath.join(dir, "settings.json");
    await writeFile(file, "{ this is not json");
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS);
  });

  test("save then load round-trips through a nested directory and leaves no temp file", async () => {
    const file = NodePath.join(dir, "nested", "settings.json");
    const settings = applyPatch(DEFAULT_SETTINGS, {
      hotkey: "rightOption",
      updateChannel: "nightly",
      theme: "dark",
      cleanup: { enabled: false },
      zoomLevel: 1.5,
    });
    await saveSettings(file, settings);
    expect(loadSettings(file)).toEqual(settings);
    await expect(readdir(NodePath.dirname(file))).resolves.toEqual(["settings.json"]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(settings);
  });
});

describe("microphone settings", () => {
  const microphone = { uid: "usb-stable-uid", name: "USB Microphone" };

  test.each([
    undefined,
    null,
    "usb",
    {},
    { uid: "usb" },
    { uid: "", name: "USB" },
    { uid: "usb", name: 42 },
    [],
  ])("defaults malformed or legacy microphone %j to the system default", (value) =>
    expect(parseSettings({ microphone: value }).microphone).toBeNull(),
  );

  test("keeps a pinned device across unrelated patches and explicitly resets to default", () => {
    const pinned = applyPatch(DEFAULT_SETTINGS, { microphone });
    expect(pinned.microphone).toEqual(microphone);
    expect(applyPatch(pinned, { theme: "dark" }).microphone).toEqual(microphone);
    expect(applyPatch(pinned, { microphone: null })).toEqual(DEFAULT_SETTINGS);
  });

  test("persists the stable UID and name and then a reset across reloads", async () => {
    const dir = await mkdtemp(NodePath.join(tmpdir(), "voice-microphone-settings-"));
    const file = NodePath.join(dir, "settings.json");
    try {
      await saveSettings(file, applyPatch(DEFAULT_SETTINGS, { microphone }));
      const loaded = loadSettings(file);
      expect(loaded.microphone).toEqual(microphone);
      await saveSettings(file, applyPatch(loaded, { microphone: null }));
      expect(loadSettings(file).microphone).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
