import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import { WRITING_STYLES, type WritingStyle } from "@voice/cleanup/style";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { DEFAULT_SETTINGS, type Settings } from "../shared/api.ts";
import { dictationLanguages } from "../shared/dictation-language.ts";
import { parseAssignments, type CategoryStyles } from "../shared/style.ts";
import {
  BUILT_IN_TRANSFORMS,
  DEFAULT_TRANSFORMS,
  POLISH_ID,
  restoreDefaults,
  type Transform,
  type TransformId,
} from "../shared/transforms.ts";
import {
  applyPatch,
  loadSettings,
  parseSettings,
  parseSettingsPatch,
  saveSettings,
} from "./settings.ts";
import { createSettingsQueue } from "./settings-queue.ts";

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

const OPTION_1 = { keycode: 18, modifiers: ["option"] } as const;
const bullets: Transform = {
  id: "synthetic-bullets" as TransformId,
  name: "Bullets",
  instruction: "Turn this into a bulleted list.",
  shortcut: { keycode: 11, modifiers: ["control", "option"] },
};

describe("parseSettings", () => {
  test.each([undefined, null, "true", "false", 0, 1, {}, []])(
    "defaults invalid lower-audio preference %j to off",
    (lowerAudioWhileDictating) => {
      expect(parseSettings({ lowerAudioWhileDictating }).lowerAudioWhileDictating).toBe(false);
    },
  );
  test.each([true, false])(
    "keeps boolean lower-audio preference %j",
    (lowerAudioWhileDictating) => {
      expect(parseSettings({ lowerAudioWhileDictating }).lowerAudioWhileDictating).toBe(
        lowerAudioWhileDictating,
      );
    },
  );
  test.each([
    { muteWhileDictating: true, lowerAudioByPercent: 100 },
    { muteWhileDictating: false, lowerAudioByPercent: 70 },
  ])(
    "carries the earlier mute switch $muteWhileDictating over to lowering by $lowerAudioByPercent%",
    ({ muteWhileDictating, lowerAudioByPercent }) => {
      expect(parseSettings({ muteWhileDictating })).toEqual({
        ...DEFAULT_SETTINGS,
        lowerAudioWhileDictating: muteWhileDictating,
        lowerAudioByPercent,
      });
    },
  );
  test("prefers the lower-audio switch over the earlier mute switch", () => {
    expect(
      parseSettings({ lowerAudioWhileDictating: false, muteWhileDictating: true })
        .lowerAudioWhileDictating,
    ).toBe(false);
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
      lowerAudioWhileDictating: false,
      lowerAudioByPercent: 70,
      copyToClipboard: false,
      showInDock: true,
      alwaysShowPill: true,
      dictationLanguage: "en",
      cleanup: { enabled: false, styles: PERSONAL_CASUAL_REST_FORMAL, assignments: [] },
      diagnostics: "off",
      snippets: [],
      dictionary: [],
      zoomLevel: 0,
      transforms: DEFAULT_TRANSFORMS,
    });
  });

  test.each([undefined, null, true, "yes", "ON", 1, {}, "unanswered"])(
    "treats a missing or invalid diagnostics choice %j as off",
    (diagnostics) => {
      expect(parseSettings({ diagnostics }).diagnostics).toBe("off");
    },
  );

  test.each([undefined, null, "on", []])(
    "loads transforms %j as the switched-off defaults",
    (transforms) => {
      expect(parseSettings({ transforms }).transforms).toEqual(DEFAULT_TRANSFORMS);
    },
  );

  test("drops unreadable transforms and resets an auto-apply choice that names none", () => {
    const transforms = {
      enabled: true,
      items: [bullets, { id: "broken", name: "", instruction: "x" }, { ...bullets, name: "Copy" }],
      autoApply: "broken",
    };
    expect(parseSettings({ transforms }).transforms).toEqual({
      enabled: true,
      items: [bullets],
      autoApply: null,
    });
  });

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

  test("defaults lowering audio to 70%, keeps a saved amount on the 10% grid from 10% to 100%, and rejects anything else", () => {
    expect(parseSettings({}).lowerAudioByPercent).toBe(70);
    for (const percent of [10, 50, 100]) {
      expect(parseSettings({ lowerAudioByPercent: percent }).lowerAudioByPercent).toBe(percent);
    }
    for (const raw of [0, 5, 55, 110, -10, 90.5, "50", null]) {
      expect(parseSettings({ lowerAudioByPercent: raw }).lowerAudioByPercent).toBe(70);
    }
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
  test.each([
    { patch: null },
    { patch: [] },
    { patch: { theme: 42 } },
    { patch: { hotkey: "bogus" } },
    { patch: { toggleHotkey: "bogus" } },
    { patch: { updateChannel: 1 } },
    { patch: { dictationLanguage: "bogus" } },
    { patch: { lowerAudioWhileDictating: "false" } },
    { patch: { muteWhileDictating: true } },
    { patch: { lowerAudioByPercent: 0 } },
    { patch: { lowerAudioByPercent: 55 } },
    { patch: { lowerAudioByPercent: 110 } },
    { patch: { lowerAudioByPercent: "50" } },
    { patch: { copyToClipboard: 1 } },
    { patch: { showInDock: null } },
    { patch: { alwaysShowPill: [] } },
    { patch: { diagnostics: true } },
    { patch: { pageAnimationMs: 73 } },
    { patch: { zoomLevel: "1" } },
    { patch: { microphone: { uid: "" } } },
    { patch: { cleanup: null } },
    { patch: { cleanup: { enabled: "false" } } },
    { patch: { cleanup: { styles: [] } } },
    { patch: { cleanup: { styles: { personal: "bogus" } } } },
    { patch: { volume: 11 } },
    { patch: { theme: "dark", volume: 11 } },
    { patch: { cleanup: { assignments: [] } } },
    { patch: { cleanup: { styles: { chat: "casual" } } } },
    {
      patch: {
        transforms: { items: [...BUILT_IN_TRANSFORMS, { ...bullets, shortcut: OPTION_1 }] },
      },
    },
  ])("rejects malformed wire patch $patch without replacing saved settings", async ({ patch }) => {
    const dir = await mkdtemp(NodePath.join(tmpdir(), "voice-settings-patch-"));
    const file = NodePath.join(dir, "settings.json");
    let current = parseSettings({
      theme: "dark",
      hotkey: "rightOption",
      updateChannel: "nightly",
      cleanup: { styles: { personal: "formal" } },
      snippets: [
        {
          id: "s",
          trigger: "signature",
          expansion: "Synthetic signature",
          expansionHtml: null,
          enabled: true,
        },
      ],
      dictionary: [{ id: "d", phrase: "Voice", replacement: null }],
    });
    try {
      await saveSettings(file, current);
      const saved = await readFile(file, "utf8");
      const savedSettings = current;
      const queue = createSettingsQueue({
        current: () => current,
        save: (next) => saveSettings(file, next),
        applied: (next) => {
          current = next;
        },
      });
      await expect(
        queue.run((previous) => applyPatch(previous, parseSettingsPatch(patch))),
      ).rejects.toThrow("Could not save these settings.");
      expect(await readFile(file, "utf8")).toBe(saved);
      expect(current).toBe(savedSettings);
      expect(loadSettings(file)).toEqual(savedSettings);
      const next = await queue.run((previous) =>
        applyPatch(previous, parseSettingsPatch({ copyToClipboard: true })),
      );
      expect(next).toEqual({ ...savedSettings, copyToClipboard: true });
      expect(loadSettings(file)).toEqual(next);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a wire patch can change every setting a patch owns", () => {
    const changed: Settings = {
      microphone: { uid: "synthetic-usb", name: "Synthetic USB Mic" },
      hotkey: "rightCommand",
      toggleHotkey: "rightOption",
      lowerAudioWhileDictating: true,
      lowerAudioByPercent: 100,
      copyToClipboard: true,
      showInDock: false,
      alwaysShowPill: false,
      dictationLanguage: "pl",
      updateChannel: "nightly",
      theme: "dark",
      pageAnimationMs: 0,
      cleanup: { enabled: false, styles: everywhere("veryCasual"), assignments: [] },
      diagnostics: "on",
      snippets: [
        {
          id: "s",
          trigger: "my email",
          expansion: "name@example.com",
          expansionHtml: null,
          enabled: false,
        },
      ],
      dictionary: [{ id: "d", phrase: "btw", replacement: "by the way" }],
      zoomLevel: 1.5,
      transforms: { enabled: true, items: [bullets], autoApply: bullets.id },
    };
    const { assignments: _, ...cleanup } = changed.cleanup;
    const wire: unknown = JSON.parse(JSON.stringify({ ...changed, cleanup }));
    expect(applyPatch(DEFAULT_SETTINGS, parseSettingsPatch(wire))).toEqual(changed);
  });

  test("a transforms patch changes only the fields it names and replaces the list whole", () => {
    const on = applyPatch(DEFAULT_SETTINGS, parseSettingsPatch({ transforms: { enabled: true } }));
    expect(on.transforms).toEqual({ ...DEFAULT_TRANSFORMS, enabled: true });
    const chosen = applyPatch(on, parseSettingsPatch({ transforms: { autoApply: POLISH_ID } }));
    expect(chosen.transforms).toEqual({ ...on.transforms, autoApply: POLISH_ID });
    const replaced = applyPatch(
      chosen,
      parseSettingsPatch({ transforms: { items: [...BUILT_IN_TRANSFORMS, bullets] } }),
    );
    expect(replaced.transforms).toEqual({
      enabled: true,
      items: [...BUILT_IN_TRANSFORMS, bullets],
      autoApply: POLISH_ID,
    });
    const off = applyPatch(replaced, parseSettingsPatch({ transforms: { autoApply: null } }));
    expect(off.transforms.autoApply).toBeNull();
    expect(applyPatch(replaced, { theme: "dark" }).transforms).toEqual(replaced.transforms);
  });

  test("deleting the auto-apply transform resets the choice to none", () => {
    const chosen = applyPatch(DEFAULT_SETTINGS, {
      transforms: { items: [...BUILT_IN_TRANSFORMS, bullets], autoApply: bullets.id },
    });
    const deleted = applyPatch(
      chosen,
      parseSettingsPatch({ transforms: { items: BUILT_IN_TRANSFORMS } }),
    );
    expect(deleted.transforms).toEqual({ ...DEFAULT_TRANSFORMS, autoApply: null });
  });

  test.each([
    ["a malformed shortcut", [{ ...bullets, shortcut: { keycode: 40, modifiers: ["shift"] } }]],
    ["a shortcut without modifiers", [{ ...bullets, shortcut: { keycode: 40, modifiers: [] } }]],
    ["a modifier as the key", [{ ...bullets, shortcut: { keycode: 58, modifiers: ["option"] } }]],
    ["a duplicate shortcut", [...BUILT_IN_TRANSFORMS, { ...bullets, shortcut: OPTION_1 }]],
    ["a repeated id", [bullets, { ...bullets, shortcut: null }]],
    ["an empty name", [{ ...bullets, name: "" }]],
    ["an item that is not one", [bullets, "Polish"]],
  ])("refuses a transform list with %s", (_label, items) => {
    expect(() => parseSettingsPatch({ transforms: { items } })).toThrow(
      "Could not save these settings.",
    );
  });

  test.each([
    { transforms: null },
    { transforms: { enabled: "true" } },
    { transforms: { items: {} } },
    { transforms: { autoApply: 3 } },
    { transforms: { shortcuts: [] } },
  ])("refuses the transforms patch %j", (patch) => {
    expect(() => parseSettingsPatch(patch)).toThrow("Could not save these settings.");
  });

  test("restoring defaults through a patch keeps the transforms the user made", () => {
    const onOption1 = { ...bullets, shortcut: OPTION_1 };
    const edited = { ...DEFAULT_TRANSFORMS, enabled: true, autoApply: bullets.id };
    const before = applyPatch(DEFAULT_SETTINGS, {
      transforms: { ...edited, items: [onOption1] },
    });
    const wire: unknown = JSON.parse(
      JSON.stringify({ transforms: { items: restoreDefaults(before.transforms.items) } }),
    );
    expect(applyPatch(before, parseSettingsPatch(wire)).transforms).toEqual({
      enabled: true,
      items: [{ ...BUILT_IN_TRANSFORMS[0], shortcut: null }, BUILT_IN_TRANSFORMS[1], onOption1],
      autoApply: bullets.id,
    });
  });

  test("lower-audio preference survives unrelated patches and can be turned back off", () => {
    const enabled = applyPatch(DEFAULT_SETTINGS, { lowerAudioWhileDictating: true });
    expect(applyPatch(enabled, { theme: "dark" }).lowerAudioWhileDictating).toBe(true);
    expect(applyPatch(enabled, { lowerAudioWhileDictating: false })).toEqual(DEFAULT_SETTINGS);
  });
  test("the lowering amount is kept while lowering is off", () => {
    const halved = applyPatch(DEFAULT_SETTINGS, { lowerAudioByPercent: 50 });
    expect(halved).toEqual({ ...DEFAULT_SETTINGS, lowerAudioByPercent: 50 });
    const on = applyPatch(halved, { lowerAudioWhileDictating: true });
    expect(applyPatch(on, { lowerAudioWhileDictating: false }).lowerAudioByPercent).toBe(50);
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
      lowerAudioWhileDictating: false,
      lowerAudioByPercent: 70,
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
      transforms: DEFAULT_TRANSFORMS,
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
    expect(applyPatch(zoomed, { zoomLevel: 0.7 }).zoomLevel).toBe(0.5);
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
    expect(() => parseSettingsPatch({ snippets })).toThrow("Could not save these settings.");
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
    expect(() => parseSettingsPatch({ dictionary })).toThrow("Could not save these settings.");
  });

  test("saves a hand-written word that leaves out its replacement", () => {
    const patch = parseSettingsPatch({ dictionary: [{ id: "2", phrase: "Hadryś" }] });
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
    "persists lower-audio preference %j and its amount across reloads",
    async (lowerAudioWhileDictating) => {
      const file = NodePath.join(dir, "settings.json");
      await saveSettings(
        file,
        applyPatch(DEFAULT_SETTINGS, { lowerAudioWhileDictating, lowerAudioByPercent: 40 }),
      );
      expect(loadSettings(file)).toMatchObject({
        lowerAudioWhileDictating,
        lowerAudioByPercent: 40,
      });
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

  test("a settings file from before Transforms loads them switched off with the built-ins", async () => {
    const file = NodePath.join(dir, "settings.json");
    const { transforms: _, ...older } = applyPatch(DEFAULT_SETTINGS, { theme: "dark" });
    await writeFile(file, JSON.stringify(older));
    expect(loadSettings(file)).toEqual({ ...older, transforms: DEFAULT_TRANSFORMS });
  });

  test("a settings file with Option+Escape, the cancel key, loads with that shortcut nulled", async () => {
    const file = NodePath.join(dir, "settings.json");
    const onEscape = { ...bullets, shortcut: { keycode: 53, modifiers: ["option"] } };
    await writeFile(file, JSON.stringify({ transforms: { enabled: true, items: [onEscape] } }));
    expect(loadSettings(file).transforms.items).toEqual([{ ...bullets, shortcut: null }]);
  });

  test("a settings file whose transforms were all deleted loads with none", async () => {
    const file = NodePath.join(dir, "settings.json");
    const settings = applyPatch(DEFAULT_SETTINGS, { transforms: { items: [] } });
    await saveSettings(file, settings);
    expect(loadSettings(file).transforms.items).toEqual([]);
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

  test("the next save moves a corrupt file aside with its bytes intact", async () => {
    const file = NodePath.join(dir, "settings.json");
    const original = '{\n  "dictionary": [{ "id": "d", "phrase": "Kubernetes" }],\n}\n';
    await writeFile(file, original);
    await saveSettings(file, applyPatch(loadSettings(file), { theme: "dark" }));
    const asides = (await readdir(dir)).filter((name) =>
      name.startsWith("settings.json.unreadable-"),
    );
    expect(asides).toHaveLength(1);
    expect(await readFile(NodePath.join(dir, asides[0]!), "utf8")).toBe(original);
    expect(loadSettings(file)).toEqual({ ...DEFAULT_SETTINGS, theme: "dark" });
  });

  test("a save keeps top-level keys this build does not know", async () => {
    const file = NodePath.join(dir, "settings.json");
    const futureFeature = { items: [{ id: "f", on: true }] };
    await writeFile(file, JSON.stringify({ theme: "light", futureFeature }));
    await saveSettings(file, applyPatch(loadSettings(file), { theme: "dark" }));
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
      theme: "dark",
      futureFeature,
    });
  });

  test("a save drops the mute switch it migrated, so an older build reads the new choice", async () => {
    const file = NodePath.join(dir, "settings.json");
    await writeFile(file, JSON.stringify({ muteWhileDictating: true }));
    await saveSettings(file, applyPatch(loadSettings(file), { lowerAudioWhileDictating: false }));
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved).not.toHaveProperty("muteWhileDictating");
    expect(saved.lowerAudioWhileDictating).toBe(false);
  });

  test("a file that cannot be read stops the save and stays in place", async () => {
    const file = NodePath.join(dir, "settings.json");
    const original = JSON.stringify({ theme: "light", futureFeature: true });
    await writeFile(file, original);
    await chmod(file, 0o000);
    await expect(
      saveSettings(file, applyPatch(DEFAULT_SETTINGS, { theme: "dark" })),
    ).rejects.toThrow();
    await chmod(file, 0o600);
    expect(await readFile(file, "utf8")).toBe(original);
    expect(await readdir(dir)).toEqual(["settings.json"]);
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
      transforms: {
        enabled: true,
        items: [bullets, { ...BUILT_IN_TRANSFORMS[1], shortcut: null }],
        autoApply: bullets.id,
      },
    });
    expect(settings.cleanup.assignments).toHaveLength(2);
    expect(settings.transforms.items).toHaveLength(2);
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
