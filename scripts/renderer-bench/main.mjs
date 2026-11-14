/// <reference path="../../apps/desktop/node_modules/electron/electron.d.ts" />
// The Electron side of scripts/renderer-bench.mjs, which starts it once per scenario. It plays
// main for the built renderer: it answers the bridge with synthetic data, pushes what main would
// push, drives the page, and writes what the probe in preload.cjs measured.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, screen } from "electron";

import { DEFAULT_SETTINGS, toPillSnapshot } from "../../apps/desktop/src/shared/api.ts";
import { applyHistoryChange } from "../../apps/desktop/src/shared/history.ts";
import { DEFAULT_MEETINGS_SETTINGS } from "../../apps/desktop/src/shared/meetings.ts";
import { apps, dictated, history, insights, meetings, seeded, transcript } from "./data.mjs";
import { bridgeMethods, median, slope } from "./stats.mjs";

/** @typedef {import("../../apps/desktop/src/shared/api.ts").HubApi} HubApi */
/** @typedef {import("../../apps/desktop/src/shared/api.ts").PillApi} PillApi */
/** @typedef {import("../../apps/desktop/src/shared/api.ts").Snapshot} Snapshot */
/** @typedef {import("../../apps/desktop/src/shared/api.ts").PillState} PillState */
/** @typedef {import("../../apps/desktop/src/shared/history.ts").HistoryState} HistoryState */
/** @typedef {import("../../apps/desktop/src/shared/history.ts").HistoryChange} HistoryChange */
/** @typedef {import("../../apps/desktop/src/shared/meetings.ts").MeetingsState} MeetingsState */

const options = JSON.parse(process.env.RENDERER_BENCH ?? "{}");
app.setPath("userData", options.userData);
// The window is shown but never focused, and may be covered. Neither may slow its frames.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

const HUB_SIZE = { width: 1350, height: 850 };
const PILL_SIZE = { width: 320, height: 48 };
const TRANSCRIPT_LINES = 600;
const QUERY = "launch";
const ROWS = "section[aria-labelledby=history] li";
const SHOW_MORE = "section[aria-labelledby=history] button";
const SEARCH = 'input[aria-label="Search history"]';
const NAV = 'nav[aria-label="Voice"] button';
const SETTINGS_NAV = 'nav[aria-label="Settings"] button';
const MEETING_ROWS = "main section[aria-label] li";
const APP_PAGES = ["Meetings", "Insights", "Style", "Transforms", "Snippets", "Dictionary", "Home"];
const SETTINGS_PAGES = ["System", "Models", "Shortcuts", "Account", "Data and Privacy"];

const rand = seeded(options.seed);
// Midnight today, so the history's day groups have the same shape at any hour of the run.
const now = new Date().setHours(0, 0, 0, 0);

/** @type {Snapshot} */
let snapshot = {
  updates: {
    version: "1.0.0",
    installedChannel: "stable",
    channel: "stable",
    status: { kind: "idle" },
  },
  session: { kind: "idle" },
  permissions: { microphone: "granted", accessibility: "granted", systemAudio: "granted" },
  speakerModel: "ready",
  loginItem: "on",
  models: { asr: { state: "ready" }, cleanup: { state: "ready" }, transform: { state: "ready" } },
  settings: DEFAULT_SETTINGS,
  microphones: {
    kind: "ready",
    devices: [
      { uid: "builtin", name: "MacBook Pro Microphone" },
      { uid: "usb", name: "USB Microphone" },
    ],
    defaultUid: "builtin",
  },
  microphoneTest: { kind: "off" },
  account: {
    kind: "signedIn",
    name: "Ada Lovelace",
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.com",
  },
  meetingNotices: [],
  restartNotice: null,
};
/** @type {HistoryState} */
let historyState = {
  entries: history(rand, options.history, now),
  retention: "forever",
  saveFailed: false,
};
/** @type {MeetingsState} */
const meetingsState = {
  meetings: meetings(rand, options.meetings, now),
  folders: [],
  settings: DEFAULT_MEETINGS_SETTINGS,
};
const insightsState = insights(rand, now);

// One dictation and one transform, then a dictation that was not inserted: every session kind.
/** @type {PillState[]} */
const sessions = [
  { kind: "listening" },
  { kind: "processing", overdue: false },
  { kind: "done", outcome: { kind: "inserted", method: "accessibility" } },
  { kind: "idle" },
  { kind: "transforming", loading: false },
  { kind: "transformDone", outcome: { kind: "inserted", method: "paste" } },
  { kind: "idle" },
  { kind: "listening" },
  {
    kind: "done",
    outcome: { kind: "notInserted", reason: "focusChanged", copied: true, source: "helper" },
  },
  { kind: "idle" },
];
const level = (i) => 0.08 + 0.8 * Math.abs(Math.sin(i * 0.71)) * (0.5 + 0.5 * Math.sin(i * 0.13));

/** @type {Record<string, number>} */
const metrics = {};
/** @type {string[]} */
const errors = [];
/** @type {BrowserWindow} */
let win;
/** @type {string[]} */
let methods = [];

// Everything the scenarios make the renderer ask main. A call with no answer here fails the run,
// so a scenario cannot time a page that silently got nothing back.
/** @satisfies {Partial<HubApi & PillApi>} */
const answers = {
  getSnapshot: async () => snapshot,
  getPillSnapshot: async () => toPillSnapshot(snapshot, null),
  getHistory: async () => historyState,
  getInsights: async () => insightsState,
  getInstalledApps: async () => /** @type {any} */ (apps),
  getAppIcons: async () => ({}),
  getLastTransform: async () => null,
  getMeetings: async () => meetingsState,
  getMeeting: async (id) => {
    const meeting = meetingsState.meetings.find((candidate) => candidate.id === id);
    return meeting ? { meeting, transcript: transcript(rand, TRANSCRIPT_LINES) } : null;
  },
  // Settings stops a microphone test whenever its General page goes away.
  stopMicrophoneTest: async () => {},
};
ipcMain.handle("bench:call", (_event, name, args) => {
  if (!(name in answers))
    errors.push(`the page called ${name}, which the fake main does not answer`);
  return answers[name]?.(...args);
});
ipcMain.on("bench:methods", (event) => {
  event.returnValue = methods;
});

const check = (ok, problem) => {
  if (!ok) errors.push(problem);
};
function record(group, values) {
  for (const [name, value] of Object.entries(values)) {
    if (Number.isFinite(value)) metrics[`${group} | ${name}`] = value;
  }
}
/** Calls `bench.<method>` in the page, defined by the probe in preload.cjs. */
const page = (method, ...args) =>
  win.webContents.executeJavaScript(
    `bench.${method}(${args.map((arg) => JSON.stringify(arg) ?? "undefined").join(", ")})`,
    true,
  );
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cpuMs() {
  const pid = win.webContents.getOSProcessId();
  const used = app.getAppMetrics().find((process) => process.pid === pid)?.cpu.cumulativeCPUUsage;
  return (used ?? NaN) * 1000;
}
/** One measured click or keystroke in the page, with the CPU time its process spent on it. */
async function act(method, ...args) {
  const before = cpuMs();
  const step = await page(method, ...args);
  return { ...step, cpuMs: cpuMs() - before };
}

function fold(group, steps, wall, { brief = false } = {}) {
  const column = (key) => steps.map((step) => step[key]);
  const profiled = steps.every((step) => step.reactMs !== null);
  const worst = !brief && steps.length > 1;
  record(group, {
    [`${wall} ms p50`]: median(column("wallMs")),
    [`${wall} ms max`]: worst ? Math.max(...column("wallMs")) : null,
    [`${wall.split("→")[0]}→last commit ms p50`]: steps.every((step) => step.doneMs)
      ? median(column("doneMs"))
      : null,
    "renderer cpu ms p50": median(column("cpuMs")),
    "react ms p50": profiled ? median(column("reactMs")) : null,
    "react ms max": profiled && worst ? Math.max(...column("reactMs")) : null,
    "components p50": median(column("components")),
    "commits per step": brief ? null : column("commits").reduce((a, b) => a + b, 0) / steps.length,
  });
}

async function open(name, size) {
  methods = bridgeMethods(
    readFileSync(join(import.meta.dirname, `../../apps/desktop/src/preload/${name}.ts`), "utf8"),
  );
  win = new BrowserWindow({
    ...size,
    x: 40,
    y: 40,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
      // As the app's windows.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.on("console-message", ({ level: severity, message }) => {
    if (severity === "error") errors.push(`console: ${message}`);
  });
  win.webContents.on("render-process-gone", (_event, { reason }) =>
    errors.push(`renderer ${reason}`),
  );
  win.webContents.on("preload-error", (_event, _path, error) => errors.push(`preload: ${error}`));
  // Shown once it has painted, as the app shows the Flow Bar. A window shown before it loads
  // gets its first frame a second late, whatever the page is.
  win.once("ready-to-show", () => win.showInactive());
  await win.loadFile(join(options.dist, `${name}.html`));
  const load = await page("ready");
  check(win.isVisible(), "the window was never shown");
  check(
    load.frameMs < 40,
    `frames came ${load.frameMs.toFixed(0)} ms apart: the window is throttled`,
  );
  return {
    [name === "pill" ? "first paint ms" : "first contentful paint ms"]: load.paintMs,
    "react start ms": load.reactStartMs,
    "first render ms": load.firstRenderMs,
    "interactive ms": load.interactiveMs,
    "longest task ms": load.longestTaskMs,
    // Read once the page is quiet: everything the process spent to get there.
    "renderer cpu ms": cpuMs(),
    "react ms": load.reactMs,
    components: load.components,
    commits: load.commits,
    "dom nodes": load.domNodes,
  };
}

async function openHub() {
  const load = await open("hub", { ...HUB_SIZE, titleBarStyle: "hidden" });
  const shown = Math.min(historyState.entries.length, 100);
  check((await page("count", ROWS)) === shown, `Home does not show ${shown} history rows`);
  check(
    (await page("text", `${ROWS} p`)) === historyState.entries[0]?.text,
    "the first history row is not the newest synthetic entry",
  );
  return load;
}

async function push(name, value) {
  const from = await page("mark");
  const before = cpuMs();
  win.webContents.send("bench:event", name, value);
  const step = await page("after", from);
  return { ...step, cpuMs: cpuMs() - before };
}

/** The snapshot main would push next: a new object each time, as main's is. */
function changed(/** @type {Partial<Snapshot>} */ patch) {
  snapshot = { ...snapshot, ...patch };
  return snapshot;
}

async function pushSnapshots(count) {
  const steps = [];
  for (let i = 0; i < count; i += 1) {
    const session = /** @type {PillState} */ (sessions[i % sessions.length]);
    steps.push(await push("onSnapshot", changed({ session })));
  }
  return steps;
}

let dictations = 0;
/** One new entry per push, as main sends after each dictation. */
async function pushHistory(count) {
  const steps = [];
  for (let i = 0; i < count; i += 1) {
    const { retention, saveFailed } = historyState;
    /** @type {HistoryChange} */
    const change = {
      kind: "patch",
      upsert: [dictated(rand, dictations++, now)],
      remove: [],
      retention,
      saveFailed,
    };
    historyState = /** @type {HistoryState} */ (applyHistoryChange(historyState, change));
    steps.push(await push("onHistory", change));
  }
  check(
    (await page("count", ROWS)) === 0 ||
      (await page("text", `${ROWS} p`)) === historyState.entries[0]?.text,
    "the newest pushed entry is not the first history row",
  );
  return steps;
}

/** Renames the newest meeting once per push, as main sends a patch after each edit. */
async function renameMeetings(count) {
  const steps = [];
  for (let i = 0; i < count; i += 1) {
    const [newest, ...rest] = meetingsState.meetings;
    if (!newest) break;
    const renamed = { ...newest, title: `Renamed meeting ${i + 1}` };
    meetingsState.meetings = [renamed, ...rest];
    const { folders, settings } = meetingsState;
    steps.push(
      await push("onMeetings", { kind: "patch", upsert: [renamed], remove: [], folders, settings }),
    );
  }
  check(
    (await page("text", `${MEETING_ROWS} button`)) === `Renamed meeting ${count}`,
    "the last rename does not show in the first meeting row",
  );
  check((await page("count", MEETING_ROWS)) === options.meetings, "a rename changed the row count");
  return steps;
}

async function showMore(times) {
  const before = await page("count", ROWS);
  const steps = [];
  for (let i = 0; i < times; i += 1) steps.push(await act("click", SHOW_MORE, "Show "));
  const shown = Math.min(historyState.entries.length, before + times * 100);
  check((await page("count", ROWS)) === shown, `Show more did not grow the list to ${shown} rows`);
  return steps;
}

async function visit(label, nav = NAV) {
  const step = await act("click", nav, label);
  const current = await page("text", `${nav}[aria-current=page]`);
  check(current.startsWith(label), `${label} did not become the current page`);
  return step;
}

async function openSettings() {
  const step = await act("click", 'button[aria-label="Settings"]');
  check((await page("count", SETTINGS_NAV)) > 0, "Settings did not open");
  return step;
}
const closeSettings = () => act("click", 'button[aria-label="Close settings"]');

/** Every page once, ending on Home, where it began. */
async function tour(visits = {}) {
  const add = (label, step) => (visits[label] ??= []).push(step);
  for (const label of APP_PAGES) add(label, await visit(label));
  add("Settings General", await openSettings());
  for (const label of SETTINGS_PAGES) add(`Settings ${label}`, await visit(label, SETTINGS_NAV));
  add("close Settings", await closeSettings());
  return visits;
}

async function search(shown) {
  const keys = [];
  for (let length = 1; length <= QUERY.length; length += 1) {
    keys.push(await act("type", SEARCH, QUERY.slice(0, length)));
  }
  const matches = historyState.entries.filter(
    ({ text, raw }) => text.toLowerCase().includes(QUERY) || raw.toLowerCase().includes(QUERY),
  ).length;
  check(
    matches > 0 &&
      matches < historyState.entries.length &&
      (await page("count", ROWS)) === Math.min(matches, shown),
    `the search for "${QUERY}" did not show its ${matches} matches`,
  );
  const cleared = await act("type", SEARCH, "");
  check((await page("count", ROWS)) === shown, "clearing the search did not bring the rows back");
  return { keys, cleared };
}

const scenarios = {
  async "hub-cold"() {
    const group = `hub-cold, ${options.history} history entries`;
    record(group, await openHub());
    record(group, { "commits while idle for 2 s": await page("idle", 2000) });
  },

  async "history-expand"() {
    await openHub();
    fold("history-expand, each Show more (100 → 1100 rows)", await showMore(10), "click→paint");
    record("history-expand, each Show more (100 → 1100 rows)", {
      "dom nodes at 1100 rows": await page("count", "*"),
    });
  },

  async "history-search"() {
    await openHub();
    for (const shown of [100, 1100]) {
      if (shown > 100) await showMore(10);
      const { keys, cleared } = await search(shown);
      fold(`history-search, each key (${shown} rows shown)`, keys, "key→paint");
      fold(`history-search, clear (${shown} rows shown)`, [cleared], "key→paint");
    }
  },

  async "history-patch"() {
    await openHub();
    fold("history-patch on Home (100 rows shown)", await pushHistory(20), "push→commit");
    await showMore(10);
    fold("history-patch on Home (1100 rows shown)", await pushHistory(20), "push→commit");
    await visit("Insights");
    fold("history-patch on Insights", await pushHistory(20), "push→commit");
  },

  async "snapshot-churn"() {
    await openHub();
    fold("snapshot-churn on Home (100 rows shown)", await pushSnapshots(100), "push→commit");
    await openSettings();
    fold("snapshot-churn on Settings General", await pushSnapshots(100), "push→commit");
    await push("onSnapshot", changed({ microphoneTest: { kind: "listening", episode: 1 } }));
    const levels = [];
    for (let i = 0; i < 100; i += 1) levels.push(await push("onLevel", level(i)));
    fold("microphone-test level on Settings General", levels, "push→commit");
    await push("onSnapshot", changed({ microphoneTest: { kind: "off" } }));
    await closeSettings();
    await showMore(10);
    fold("snapshot-churn on Home (1100 rows shown)", await pushSnapshots(100), "push→commit");
  },

  async "page-tour"() {
    await openHub();
    const visits = {};
    for (let round = 0; round < 3; round += 1) await tour(visits);
    for (const [label, steps] of Object.entries(visits)) {
      fold(`page-tour, ${label}`, steps, "click→paint", { brief: true });
    }
  },

  async meetings() {
    await openHub();
    fold("meetings, open the list", [await visit("Meetings")], "click→paint");
    const listed = await page("count", MEETING_ROWS);
    check(listed === options.meetings, `Meetings lists ${listed} of ${options.meetings} meetings`);
    record("meetings, open the list", { "dom nodes": await page("count", "*") });
    fold(
      `meetings, rename one of ${options.meetings} shown`,
      await renameMeetings(20),
      "push→commit",
    );
    fold("meetings, open a meeting", [await act("click", `${MEETING_ROWS} button`)], "click→paint");
    check((await page("count", "[role=tab]")) > 0, "the meeting did not open");
    const opened = await act("click", "[role=tab]", "Transcript");
    fold(`meetings, open its ${TRANSCRIPT_LINES}-line transcript`, [opened], "click→paint");
    const lines = await page("count", "ol[aria-label=Transcript] li");
    check(lines > 0, "the transcript shows no lines");
    record(`meetings, open its ${TRANSCRIPT_LINES}-line transcript`, { "transcript rows": lines });
  },

  async pill() {
    record("pill-cold", await open("pill", { ...PILL_SIZE, frame: false, transparent: true }));
    const idleCommits = await page("idle", 2000);
    check(idleCommits === 0, `the idle Flow Bar committed ${idleCommits} times in 2 s`);
    record("pill", { "commits while idle for 2 s": idleCommits });
    const changes = [];
    const show = async (session) => {
      changes.push(await push("onPillSnapshot", toPillSnapshot(changed({ session }), null)));
    };
    await show({ kind: "listening" });
    check((await page("count", "[data-view=listening]")) === 1, "the Flow Bar is not listening");
    const levels = [];
    for (let i = 0; i < 30; i += 1) {
      const started = performance.now();
      levels.push(await push("onLevel", level(i)));
      // The helper sends one level per 100 ms of audio.
      await sleep(Math.max(0, 100 - (performance.now() - started)));
    }
    // The known case that checks the counter: a level sets state in Wave and nowhere else.
    check(
      levels.every((step) => step.commits === 1 && step.components === 1),
      "a level update is not one commit that renders one component, so the counter is wrong",
    );
    await show({ kind: "processing", overdue: false });
    await show({ kind: "done", outcome: { kind: "inserted", method: "accessibility" } });
    await show({ kind: "idle" });
    check((await page("count", "[data-view=idle]")) === 1, "the Flow Bar did not return to idle");
    fold("pill, each level update", levels, "push→commit");
    fold("pill, each session change", changes, "push→commit");
  },

  async memory() {
    await openHub();
    const cdp = win.webContents.debugger;
    cdp.attach("1.3");
    const sample = async () => {
      await page("forget");
      await cdp.sendCommand("HeapProfiler.collectGarbage");
      await cdp.sendCommand("HeapProfiler.collectGarbage");
      const { usedSize } = await cdp.sendCommand("Runtime.getHeapUsage");
      const { nodes, jsEventListeners } = await cdp.sendCommand("Memory.getDOMCounters");
      return {
        "JS heap MB": usedSize / 2 ** 20,
        "DOM nodes": nodes,
        "event listeners": jsEventListeners,
      };
    };
    const samples = [await sample()];
    for (let loop = 0; loop < 10; loop += 1) {
      await tour();
      await showMore(3);
      await page("scroll", "main", 1e9);
      await page("scroll", "main", 0);
      await search(400);
      const before = historyState;
      await pushHistory(20);
      // The loop ends with the history it began with, so growth is not the data's.
      historyState = before;
      await push("onHistory", { kind: "all", state: before });
      await pushSnapshots(100);
      await visit("Insights");
      await visit("Home");
      samples.push(await sample());
    }
    for (const unit of Object.keys(/** @type {object} */ (samples[0]))) {
      const values = samples.map((taken) => taken[unit]);
      record("memory, 10 session loops", {
        [`${unit} after first render`]: values[0],
        [`${unit} after loop 1`]: values[1],
        [`${unit} after loop 10`]: values[10],
        // The first loops also fill caches and compile code; the later ones show what stays.
        [`${unit} growth per loop (loops 5–10)`]: slope(values.slice(5)),
      });
    }
  },
};

void app.whenReady().then(async () => {
  app.dock?.hide();
  const display = screen.getPrimaryDisplay();
  try {
    await scenarios[options.scenario]();
  } catch (error) {
    errors.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
  const info = {
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    window: options.scenario === "pill" ? PILL_SIZE : HUB_SIZE,
    scaleFactor: display.scaleFactor,
    refreshHz: display.displayFrequency,
    transcriptLines: TRANSCRIPT_LINES,
  };
  writeFileSync(options.out, JSON.stringify({ metrics, errors, info }));
  app.exit(0);
});
