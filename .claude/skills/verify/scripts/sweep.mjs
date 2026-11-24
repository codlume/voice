// The visual sweep: a fixed list of Voice window states, each reached through the user path from
// a reset hub, so two builds can be shot state for state. `voice-verify.mjs sweep` runs it.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { history, insights, mulberry32 } from "../../../../scripts/renderer-bench/data.mjs";

// Seeded before the app starts, so Home and Insights open populated. All of it is synthetic.
export function seedUserData(userData, now = Date.now()) {
  const rand = mulberry32(7);
  const entries = history(rand, 40, now);
  writeFileSync(
    join(userData, "history.json"),
    `${JSON.stringify({ version: 1, retention: "month", entries })}\n`,
  );
  writeFileSync(
    join(userData, "insights.json"),
    `${JSON.stringify({ version: 2, ...insights(rand, now) })}\n`,
  );
}

// Applied through the settings API before the first shot. A setup shortcut, not proof.
export const SWEEP_SETTINGS = {
  cleanup: { enabled: true },
  snippets: [
    {
      id: "email",
      trigger: "my email",
      expansion: "ada@example.com",
      expansionHtml: null,
      enabled: true,
    },
    {
      id: "address",
      trigger: "office address",
      expansion: "Analytical Engines Ltd.\n12 Marylebone Road\nLondon NW1 5LR",
      expansionHtml: null,
      enabled: false,
    },
    {
      id: "signoff",
      trigger: "standard sign-off",
      expansion: "Thanks for the quick turnaround. I will send notes before the 11:00 sync.",
      expansionHtml:
        "<p>Thanks for the <strong>quick turnaround</strong>. I will send notes before the <em>11:00 sync</em>.</p>",
      enabled: true,
    },
  ],
  dictionary: [
    { id: "worcestershire", phrase: "Worcestershire", replacement: null },
    { id: "btw", phrase: "btw", replacement: "by the way" },
    {
      id: "office",
      phrase: "office hours",
      replacement: "Tuesdays and Thursdays from 14:00 to 16:00",
    },
  ],
};

// The window size every shot uses, in points.
export const SWEEP_WINDOW = { width: 1350, height: 850 };

const settings = (page) => [
  ["key", "Comma", "command"],
  ["click", page],
];
const scrollMain = 'document.querySelector("main [data-scroll], main")?.scrollTo?.(0, 1e6)';

// Each step is a voice-verify command: click <name>, key <code> [modifiers], type <css> <text>,
// or eval <expr> in the hub. Every shot starts from Home with nothing open. Shots that list this
// Mac's apps or input devices are left out on purpose.
export const SHOTS = [
  { name: "home", steps: [] },
  { name: "home-history-search", steps: [["type", "css:input[type=search]", "Thursday"]] },
  { name: "home-history-bottom", steps: [["eval", scrollMain]] },
  {
    name: "sidebar-collapsed",
    steps: [["click", "Collapse sidebar"]],
    after: [["click", "Expand sidebar"]],
  },
  { name: "meetings", steps: [["click", "Meetings, Beta"]] },
  {
    name: "meetings-help",
    steps: [
      ["click", "Meetings, Beta"],
      ["click", "How Meetings works"],
    ],
  },
  {
    name: "dialog-meetings-settings",
    steps: [
      ["click", "Meetings, Beta"],
      ["click", "Meeting settings"],
    ],
  },
  { name: "insights", steps: [["click", "Insights"]] },
  {
    name: "insights-bottom",
    steps: [
      ["click", "Insights"],
      ["eval", scrollMain],
    ],
  },
  {
    name: "insights-help",
    steps: [
      ["click", "Insights"],
      ["click", "How Insights works"],
    ],
  },
  { name: "style", steps: [["click", "Style"]] },
  {
    name: "style-work",
    steps: [
      ["click", "Style"],
      ["click", "Work messages"],
    ],
  },
  {
    name: "style-cleanup-off",
    steps: [
      ["click", "Style"],
      ["click", "Clean up text"],
    ],
    after: [["click", "Clean up text"]],
  },
  { name: "transforms", steps: [["click", "Transforms"]] },
  {
    name: "dialog-transforms-download",
    steps: [
      ["click", "Transforms"],
      ["click", "css:main [role=switch]"],
    ],
  },
  {
    name: "dialog-transform-editor",
    steps: [
      ["click", "Transforms"],
      ["click", "Edit Polish"],
    ],
  },
  {
    name: "dialog-transform-delete",
    steps: [
      ["click", "Transforms"],
      ["click", "Edit Polish"],
      ["click", "Delete transform"],
    ],
  },
  {
    name: "dialog-transform-new",
    steps: [
      ["click", "Transforms"],
      ["click", "Create"],
    ],
  },
  {
    name: "dialog-transforms-restore",
    steps: [
      ["click", "Transforms"],
      ["click", "Restore defaults"],
    ],
  },
  { name: "snippets", steps: [["click", "Snippets"]] },
  {
    name: "dialog-snippet-add",
    steps: [
      ["click", "Snippets"],
      ["click", "Add new"],
    ],
  },
  {
    name: "dialog-snippet-add-error",
    steps: [
      ["click", "Snippets"],
      ["click", "Add new"],
      ["click", "Add snippet"],
    ],
  },
  {
    name: "dialog-snippet-edit",
    steps: [
      ["click", "Snippets"],
      ["click", "Edit standard sign-off"],
    ],
  },
  {
    name: "dialog-snippet-delete",
    steps: [
      ["click", "Snippets"],
      ["click", "Delete my email"],
    ],
  },
  { name: "dictionary", steps: [["click", "Dictionary"]] },
  {
    name: "dialog-dictionary-add",
    steps: [
      ["click", "Dictionary"],
      ["click", "Add new"],
    ],
  },
  {
    name: "dialog-dictionary-add-error",
    steps: [
      ["click", "Dictionary"],
      ["click", "Add new"],
      ["click", "Add to dictionary"],
    ],
  },
  {
    name: "dialog-dictionary-edit",
    steps: [
      ["click", "Dictionary"],
      ["click", "Edit btw"],
    ],
  },
  {
    name: "dialog-dictionary-delete",
    steps: [
      ["click", "Dictionary"],
      ["click", "Delete btw"],
    ],
  },
  { name: "settings-general", steps: settings("General") },
  {
    name: "settings-general-language",
    steps: [...settings("General"), ["click", "css:#setting-dictation-language"]],
  },
  { name: "settings-system", steps: settings("System") },
  { name: "settings-models", steps: settings("Models") },
  {
    name: "dialog-models-uninstall",
    steps: [...settings("Models"), ["click", "Uninstall S1-mini"]],
  },
  { name: "settings-shortcuts", steps: settings("Shortcuts") },
  {
    name: "settings-shortcuts-hotkey",
    steps: [...settings("Shortcuts"), ["click", "css:#setting-hotkey"]],
  },
  { name: "settings-account", steps: settings("Account") },
  { name: "settings-data", steps: settings("Data and Privacy") },
  {
    name: "settings-data-retention",
    steps: [...settings("Data and Privacy"), ["click", "css:#setting-history-retention"]],
  },
  {
    name: "dialog-clear-history",
    steps: [...settings("Data and Privacy"), ["click", "Clear history"]],
  },
  {
    name: "dialog-clear-insights",
    steps: [...settings("Data and Privacy"), ["click", "Clear insights"]],
  },
];
