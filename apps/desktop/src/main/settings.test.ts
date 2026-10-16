import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import { WRITING_STYLES, type WritingStyle } from "@voice/cleanup/style";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { DEFAULT_SETTINGS, type SettingsPatch } from "../shared/api.ts";
import { dictationLanguages } from "../shared/dictation-language.ts";
import { parseAssignments, type CategoryStyles } from "../shared/style.ts";
import { applyPatch, loadSettings, parseSettings, saveSettings } from "./settings.ts";

const disk = vi.hoisted(() => ({ events: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  const { basename } = await import("node:path");
  // Every FileHandle shares this prototype, including the ones fs.writeFile opens internally.
  const probe = await fs.open(process.execPath);
  const handles = Object.getPrototypeOf(probe) as typeof probe;
  await probe.close();
  const sync = handles.sync;
  handles.sync = async function (this: typeof probe) {
    await sync.call(this);
    const { size } = await this.stat();
    disk.events.push(`sync ${size > 0 ? "with data" : "empty"}`);
  };
  return {
    ...fs,
    rename: async (from: string, to: string) => {
      await fs.rename(from, to);
      disk.events.push(`rename ${basename(from)} -> ${basename(to)}`);
    },
  };
});

const PERSONAL_CASUAL_REST_FORMAL = {
  personal: "casual",
  work: "formal",
  email: "formal",
  other: "formal",
};

const everywhere = (style: WritingStyle): CategoryStyles => ({
  personal: style,
  work: style,
  email: style,
  other: style,
});

const stylesOf = (cleanup: object) => parseSettings({ cleanup }).cleanup.styles;

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
        cleanup: { enabled: false, style: "shouty" },
      }),
    ).toEqual({
      hotkey: "rightOption",
      toggleHotkey: null,
      updateChannel: "stable",
      theme: "system",
      pageAnimationMs: 200,
      microphone: null,
      muteWhileDictating: false,
      copyToClipboard: false,
      showInDock: true,
      alwaysShowPill: true,
      dictationLanguage: "en",
      cleanup: { enabled: false, styles: PERSONAL_CASUAL_REST_FORMAL, assignments: [] },
      diagnostics: "off",
      snippets: [],
      dictionary: [],
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

  test.each(WRITING_STYLES)("seeds every category from a saved %j style", (style) => {
    expect(parseSettings({ cleanup: { enabled: false, style } }).cleanup).toEqual({
      enabled: false,
      styles: everywhere(style),
      assignments: [],
    });
  });

  test.each([
    ["casual", "veryCasual"],
    ["semi-casual", "casual"],
    ["semi-formal", "formal"],
    ["formal", "formal"],
  ] as const)("seeds every category from the legacy styling %j as %j", (styling, style) => {
    expect(parseSettings({ cleanup: { enabled: false, styling } }).cleanup).toEqual({
      enabled: false,
      styles: everywhere(style),
      assignments: [],
    });
  });

  test("a saved style wins over the legacy styling, which fills in for an invalid one", () => {
    expect(stylesOf({ style: "casual", styling: "casual" })).toEqual(everywhere("casual"));
    expect(stylesOf({ style: "shouty", styling: "semi-casual" })).toEqual(everywhere("casual"));
    expect(stylesOf({ style: "shouty", styling: "shouty" })).toEqual(PERSONAL_CASUAL_REST_FORMAL);
  });

  test("saved styles win over style and styling, and an invalid one takes its own default", () => {
    const saved = { personal: "formal", work: "veryCasual", email: "casual", other: "casual" };
    expect(stylesOf({ styles: saved, style: "formal", styling: "casual" })).toEqual(saved);
    expect(
      stylesOf({
        styles: { personal: "shouty", work: 3, email: "veryCasual" },
        style: "veryCasual",
      }),
    ).toEqual({ personal: "casual", work: "formal", email: "veryCasual", other: "formal" });
  });

  test("drops invalid assignments on load and keeps the last one for a key", () => {
    const mail = { kind: "app", bundleId: "com.apple.mail", name: "Mail", category: "work" };
    const assignments = [
      mail,
      { kind: "site", host: "github.com", category: "shouty" },
      { kind: "site", host: "not a host", category: "work" },
      { kind: "app", bundleId: "com.example.app", category: "work" },
      "slack.com",
      { kind: "site", host: "slack.com", category: "work" },
      { kind: "site", host: "Slack.com", category: "personal" },
    ];
    expect(parseSettings({ cleanup: { assignments } }).cleanup.assignments).toEqual([
      mail,
      { kind: "site", host: "slack.com", category: "personal" },
    ]);
  });

  test("keeps a saved theme and falls back to system for an unknown one", () => {
    expect(parseSettings({ theme: "dark" }).theme).toBe("dark");
    expect(parseSettings({ theme: "purple" }).theme).toBe("system");
  });

  test("defaults page animations to 200 ms, keeps a saved duration on the 25 ms grid up to 400 ms, and rejects anything else", () => {
    expect(parseSettings({}).pageAnimationMs).toBe(200);
    for (const ms of [0, 25, 400]) {
      expect(parseSettings({ pageAnimationMs: ms }).pageAnimationMs).toBe(ms);
    }
    for (const raw of [401, -1, 150.5, 210, "200", null]) {
      expect(parseSettings({ pageAnimationMs: raw }).pageAnimationMs).toBe(200);
    }
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
    const veryCasual = applyPatch(DEFAULT_SETTINGS, {
      cleanup: { styles: { work: "veryCasual" } },
    });
    const next = applyPatch(veryCasual, { cleanup: { enabled: false } });
    expect(next).toEqual({
      hotkey: "fn",
      toggleHotkey: null,
      updateChannel: "stable",
      theme: "system",
      pageAnimationMs: 200,
      microphone: null,
      muteWhileDictating: false,
      copyToClipboard: false,
      showInDock: true,
      alwaysShowPill: true,
      dictationLanguage: "en",
      cleanup: {
        enabled: false,
        styles: { personal: "casual", work: "veryCasual", email: "formal", other: "formal" },
        assignments: [],
      },
      diagnostics: "off",
      snippets: [],
      dictionary: [],
      zoomLevel: 0,
    });
    expect(DEFAULT_SETTINGS.cleanup).toEqual({
      enabled: true,
      styles: PERSONAL_CASUAL_REST_FORMAL,
      assignments: [],
    });
  });

  const assignments = parseAssignments([
    { kind: "app", bundleId: "com.apple.mail", name: "Mail", category: "work" },
    { kind: "site", host: "slack.com", category: "personal" },
  ]);

  test("cleanup patches keep the saved assignments", () => {
    const saved = parseSettings({ cleanup: { assignments } });
    expect(saved.cleanup.assignments).toEqual(assignments);
    const off = applyPatch(saved, { cleanup: { enabled: false } });
    expect(off.cleanup).toEqual({
      enabled: false,
      styles: PERSONAL_CASUAL_REST_FORMAL,
      assignments,
    });
    const styled = applyPatch(off, { cleanup: { styles: { email: "casual" } } });
    expect(styled.cleanup).toEqual({
      enabled: false,
      styles: { ...PERSONAL_CASUAL_REST_FORMAL, email: "casual" },
      assignments,
    });
  });

  test("a patch cannot replace the assignments", () => {
    const saved = parseSettings({ cleanup: { assignments } });
    const patch = { cleanup: { assignments: [] } } as unknown as SettingsPatch;
    expect(applyPatch(saved, patch).cleanup.assignments).toEqual(assignments);
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

  test("leaves toggle dictation off by default and drops an unknown toggle key", () => {
    expect(DEFAULT_SETTINGS.toggleHotkey).toBeNull();
    expect(parseSettings({}).toggleHotkey).toBeNull();
    expect(parseSettings({ toggleHotkey: "capsLock" }).toggleHotkey).toBeNull();
  });

  test("sets a toggle key, keeps it through other changes, and turns it off with an explicit null", () => {
    const toggle = applyPatch(DEFAULT_SETTINGS, { toggleHotkey: "rightOption" });
    expect(toggle).toEqual({ ...DEFAULT_SETTINGS, toggleHotkey: "rightOption" });
    expect(applyPatch(toggle, { theme: "dark" }).toggleHotkey).toBe("rightOption");
    expect(applyPatch(toggle, { hotkey: "rightCommand" })).toEqual({
      ...DEFAULT_SETTINGS,
      hotkey: "rightCommand",
      toggleHotkey: "rightOption",
    });
    expect(applyPatch(toggle, { toggleHotkey: null })).toEqual(DEFAULT_SETTINGS);
  });

  test("never lets one key both hold and toggle", () => {
    expect(parseSettings({ hotkey: "rightOption", toggleHotkey: "rightOption" })).toMatchObject({
      hotkey: "rightOption",
      toggleHotkey: null,
    });
    expect(applyPatch(DEFAULT_SETTINGS, { toggleHotkey: "fn" }).toggleHotkey).toBeNull();
    const toggle = applyPatch(DEFAULT_SETTINGS, { toggleHotkey: "rightOption" });
    expect(applyPatch(toggle, { hotkey: "rightOption" })).toEqual({
      ...DEFAULT_SETTINGS,
      hotkey: "rightOption",
      toggleHotkey: null,
    });
  });

  test("changes page animations alone, keeps them across unrelated patches, and can set them back", () => {
    const off = applyPatch(DEFAULT_SETTINGS, { pageAnimationMs: 0 });
    expect(off).toEqual({ ...DEFAULT_SETTINGS, pageAnimationMs: 0 });
    expect(applyPatch(off, { theme: "dark" }).pageAnimationMs).toBe(0);
    expect(applyPatch(off, { pageAnimationMs: 200 })).toEqual(DEFAULT_SETTINGS);
  });

  test("changes the theme alone and keeps other fields", () => {
    expect(applyPatch(DEFAULT_SETTINGS, { theme: "light" })).toEqual({
      ...DEFAULT_SETTINGS,
      theme: "light",
    });
  });

  const VALID_SNIPPET = {
    id: "1",
    trigger: "my email",
    expansion: "name@example.com\n",
    expansionHtml: null,
    enabled: true,
  };

  test("saves a snippet list and keeps it through other changes", () => {
    const saved = applyPatch(DEFAULT_SETTINGS, { snippets: [VALID_SNIPPET] });
    expect(applyPatch(saved, { theme: "dark" }).snippets).toEqual([VALID_SNIPPET]);
  });

  test("saves a switched-off snippet as switched off", () => {
    const off = {
      id: "2",
      trigger: "address",
      expansion: "1 Main St",
      expansionHtml: null,
      enabled: false,
    };
    const saved = applyPatch(DEFAULT_SETTINGS, { snippets: [VALID_SNIPPET, off] });
    expect(saved.snippets).toEqual([VALID_SNIPPET, off]);
  });

  test.each([
    ["a duplicate id", [VALID_SNIPPET, { ...VALID_SNIPPET, trigger: "address" }]],
    ["a record missing its expansion", [VALID_SNIPPET, { id: "2", trigger: "address" }]],
    ["a list that is not an array", { 0: VALID_SNIPPET }],
  ])("refuses to save snippets with %s instead of dropping any", (_, snippets) => {
    const patch = { snippets } as unknown as SettingsPatch;
    expect(() => applyPatch(DEFAULT_SETTINGS, patch)).toThrow("Could not save these snippets.");
  });

  const WORD = { id: "1", phrase: "Wispr Flow", replacement: null };
  const REPLACEMENT = { id: "2", phrase: "btw", replacement: "by the way" };

  test("saves a dictionary and keeps it through other changes", () => {
    const saved = applyPatch(DEFAULT_SETTINGS, { dictionary: [WORD, REPLACEMENT] });
    expect(applyPatch(saved, { theme: "dark" }).dictionary).toEqual([WORD, REPLACEMENT]);
    expect(applyPatch(saved, { snippets: [VALID_SNIPPET] }).dictionary).toEqual([
      WORD,
      REPLACEMENT,
    ]);
  });

  test.each([
    ["a duplicate id", [WORD, { ...REPLACEMENT, id: WORD.id }]],
    ["a replacement that is not text", [WORD, { ...REPLACEMENT, replacement: 42 }]],
    ["a list that is not an array", { 0: WORD }],
  ])("refuses to save a dictionary with %s instead of dropping any", (_, dictionary) => {
    const saved = applyPatch(DEFAULT_SETTINGS, { snippets: [VALID_SNIPPET], dictionary: [WORD] });
    const patch = { dictionary } as unknown as SettingsPatch;
    expect(() => applyPatch(saved, patch)).toThrow("Could not save this dictionary.");
  });

  test("saves a hand-written word that leaves out its replacement", () => {
    const patch = { dictionary: [{ id: "2", phrase: "Hadryś" }] } as unknown as SettingsPatch;
    expect(applyPatch(DEFAULT_SETTINGS, patch).dictionary).toEqual([
      { id: "2", phrase: "Hadryś", replacement: null },
    ]);
  });

  test("a phrase that is also a snippet trigger never blocks a save of either list", () => {
    const shadow = { ...WORD, phrase: "My Email" };
    const other = {
      id: "2",
      trigger: "sig",
      expansion: "Best, A",
      expansionHtml: null,
      enabled: true,
    };
    const saved = applyPatch(DEFAULT_SETTINGS, {
      snippets: [VALID_SNIPPET, other],
      dictionary: [shadow],
    });
    expect(saved.dictionary).toEqual([shadow]);
    expect(applyPatch(saved, { snippets: [VALID_SNIPPET] }).snippets).toEqual([VALID_SNIPPET]);
    expect(
      applyPatch(saved, { snippets: [VALID_SNIPPET, { ...other, enabled: false }] }).snippets[1],
    ).toEqual({ ...other, enabled: false });
    expect(applyPatch(saved, { dictionary: [shadow, REPLACEMENT] }).dictionary).toEqual([
      shadow,
      REPLACEMENT,
    ]);
  });

  test("two loaded triggers the page would refuse as one never block a later save", () => {
    const twins = [
      { id: "a", trigger: "café", expansion: "Café Nero", expansionHtml: null, enabled: true },
      { id: "b", trigger: "cafe", expansion: "coffee", expansionHtml: null, enabled: true },
      VALID_SNIPPET,
    ];
    const saved = applyPatch(DEFAULT_SETTINGS, { snippets: twins });
    expect(saved.snippets).toEqual(twins);
    const toggled = [twins[0]!, twins[1]!, { ...VALID_SNIPPET, enabled: false }];
    expect(applyPatch(saved, { snippets: toggled }).snippets).toEqual(toggled);
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
      cleanup: { enabled: false, styles: everywhere("veryCasual"), assignments: [] },
    });
  });

  test.each([
    [{ styling: "casual" }, "veryCasual"],
    [{ style: "casual" }, "casual"],
  ] as const)("a file with %j saves %j styles and no legacy key", async (legacy, style) => {
    const file = NodePath.join(dir, "settings.json");
    await writeFile(file, JSON.stringify({ cleanup: { enabled: true, ...legacy } }));
    await saveSettings(file, applyPatch(loadSettings(file), { theme: "dark" }));
    expect(JSON.parse(await readFile(file, "utf8")).cleanup).toEqual({
      enabled: true,
      styles: everywhere(style),
      assignments: [],
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

  test("a settings file from before snippets loads with none", async () => {
    const file = NodePath.join(dir, "settings.json");
    const { snippets: _, ...older } = applyPatch(DEFAULT_SETTINGS, { theme: "dark" });
    await writeFile(file, JSON.stringify(older));
    expect(loadSettings(file)).toEqual({ ...older, snippets: [] });
  });

  test("a damaged snippet is dropped while the others load", async () => {
    const file = NodePath.join(dir, "settings.json");
    const valid = { id: "1", trigger: "my email", expansion: "name@example.com" };
    await writeFile(
      file,
      JSON.stringify({
        snippets: [valid, { id: "2", trigger: "   ", expansion: "x" }, { id: "3" }],
      }),
    );
    expect(loadSettings(file).snippets).toEqual([{ ...valid, expansionHtml: null, enabled: true }]);
  });

  test("a settings file from before the dictionary loads with an empty one", async () => {
    const file = NodePath.join(dir, "settings.json");
    const { dictionary: _, ...older } = applyPatch(DEFAULT_SETTINGS, { theme: "dark" });
    await writeFile(file, JSON.stringify(older));
    expect(loadSettings(file)).toEqual({ ...older, dictionary: [] });
  });

  test("a damaged dictionary entry is dropped while the others load", async () => {
    const file = NodePath.join(dir, "settings.json");
    const word = { id: "1", phrase: "Wispr Flow", replacement: null };
    const replacement = { id: "2", phrase: "btw", replacement: "by the way" };
    await writeFile(
      file,
      JSON.stringify({
        dictionary: [
          word,
          { id: "3", phrase: "?!", replacement: null },
          { id: "4", phrase: "idk", replacement: 42 },
          { id: "5" },
          replacement,
        ],
      }),
    );
    expect(loadSettings(file).dictionary).toEqual([word, replacement]);
  });

  test("a dictionary phrase that matches a snippet trigger still loads", async () => {
    const file = NodePath.join(dir, "settings.json");
    const snippets = [{ id: "s", trigger: "my email", expansion: "name@example.com" }];
    const dictionary = [{ id: "1", phrase: "My Email", replacement: null }];
    await writeFile(file, JSON.stringify({ snippets, dictionary }));
    expect(loadSettings(file).dictionary).toEqual(dictionary);
  });

  test("a corrupt file yields defaults", async () => {
    const file = NodePath.join(dir, "settings.json");
    await writeFile(file, "{ this is not json");
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS);
  });

  test("a save reaches the disk before it replaces the old file", async () => {
    const file = NodePath.join(dir, "settings.json");
    disk.events = [];
    await saveSettings(file, applyPatch(DEFAULT_SETTINGS, { hotkey: "rightOption" }));
    expect(disk.events).toEqual([
      "sync with data",
      expect.stringMatching(/^rename settings\.json\..+ -> settings\.json$/),
    ]);
  });

  test("save then load round-trips through a nested directory and leaves no temp file", async () => {
    const file = NodePath.join(dir, "nested", "settings.json");
    const settings = parseSettings({
      ...DEFAULT_SETTINGS,
      hotkey: "rightOption",
      updateChannel: "nightly",
      theme: "dark",
      cleanup: {
        enabled: false,
        styles: { personal: "veryCasual", work: "casual", email: "formal", other: "casual" },
        assignments: [
          { kind: "app", bundleId: "com.apple.mail", name: "Mail", category: "personal" },
          { kind: "site", host: "mail.google.com", category: "work" },
        ],
      },
      snippets: [
        {
          id: "1",
          trigger: "my email",
          expansion: "name@example.com\n",
          expansionHtml: null,
          enabled: false,
        },
      ],
      dictionary: [
        { id: "1", phrase: "Hadryś", replacement: null },
        { id: "2", phrase: "btw", replacement: "by the way" },
      ],
      zoomLevel: 1.5,
    });
    expect(settings.cleanup.assignments).toHaveLength(2);
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
