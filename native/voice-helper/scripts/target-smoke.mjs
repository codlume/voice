import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

import {
  assert,
  dictateFixture,
  prepareAsr,
  refuseIfVoiceIsRunning,
  withHelper,
} from "./helper.mjs";

const { values: options } = parseArgs({
  options: {
    reads: { type: "string", default: "5" },
    app: { type: "string" },
    url: { type: "string" },
  },
});
const reads = Number(options.reads);
assert(
  Number.isInteger(reads) && reads > 0,
  `--reads must be a positive integer (got ${options.reads})`,
);
assert(!options.url || options.app, "--url needs --app");
refuseIfVoiceIsRunning();

function osascript(script) {
  return execFileSync("osascript", ["-e", script], { encoding: "utf8" }).trim();
}

const quoted = (value) => JSON.stringify(value);

const browsers = {
  Safari: {
    open: (url) =>
      osascript(
        `tell application "Safari"\nmake new document with properties {URL:${quoted(url)}}\nactivate\nreturn id of front window\nend tell`,
      ),
    close: (id) => osascript(`tell application "Safari" to close window id ${id}`),
    front: () => osascript('tell application "Safari" to get id of front window'),
  },
  "Google Chrome": {
    open: (url) =>
      osascript(
        `tell application "Google Chrome"\nset w to make new window\nset URL of active tab of w to ${quoted(url)}\nactivate\nreturn id of w\nend tell`,
      ),
    close: (id) => osascript(`tell application "Google Chrome" to close window id ${id}`),
    front: () => osascript('tell application "Google Chrome" to get id of front window'),
  },
};

const app = options.app;
const browser = app ? browsers[app] : undefined;
const appWasRunning = app ? osascript(`application ${quoted(app)} is running`) === "true" : true;
let windowId;
if (app) {
  if (options.url && browser) {
    if (!appWasRunning) {
      execFileSync("open", ["-a", app]);
      await settle(() => osascript(`application ${quoted(app)} is running`), "true", 15_000);
    }
    windowId = browser.open(options.url);
  } else if (options.url) {
    execFileSync("open", ["-a", app, options.url]);
    console.error(`opened ${options.url} in ${app}; that tab is not closed automatically`);
  } else {
    execFileSync("open", ["-a", app]);
  }
  await new Promise((resolve) => setTimeout(resolve, 3_000));
}

async function settle(read, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let value = read();
  while (value !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    value = read();
  }
  return value;
}

const isHostReadLog = (event) =>
  event.type === "log" && event.message.startsWith("target host read:");

async function hostReadLog(helper, since) {
  const deadline = Date.now() + 500;
  for (;;) {
    const line = helper.eventsSince(since).find(isHostReadLog);
    if (line || Date.now() > deadline) return line?.message ?? null;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];

try {
  await withHelper({}, async (helper) => {
    await prepareAsr(helper);
    const rows = [];
    for (let index = 0; index < reads; index += 1) {
      const since = helper.events.length;
      const startedAt = performance.now();
      const { transcript } = await dictateFixture(helper, "short.wav", `target-${index}`);
      const wallMs = Math.round(performance.now() - startedAt);
      const log = await hostReadLog(helper, since);
      const hops = log?.match(/after (\d+) (?:hops|nodes)/)?.[1];
      const readMs = log?.match(/in (\d+) ms/)?.[1];
      const row = {
        read: index + 1,
        windowInFront: windowId === undefined ? null : browser.front() === windowId,
        bundleId: transcript.target?.bundleId ?? null,
        host: transcript.target?.host ?? null,
        hostReadLog: log,
        hostReadMs: readMs === undefined ? null : Number(readMs),
        hops: hops === undefined ? null : Number(hops),
        wallMs,
      };
      if (row.host !== null && log !== null) {
        assert(!log.includes(row.host), `host-read log line carries the host: ${log}`);
      }
      rows.push(row);
      console.log(JSON.stringify(row));
    }
    const readMs = rows.map((row) => row.hostReadMs).filter((value) => value !== null);
    console.log(
      JSON.stringify({
        app: app ?? "frontmost",
        url: options.url ?? null,
        reads,
        hostsFound: rows.filter((row) => row.host !== null).length,
        hostReadP50Ms: readMs.length ? median(readMs) : null,
        hops: rows.map((row) => row.hops),
        wallP50Ms: median(rows.map((row) => row.wallMs)),
      }),
    );
  });
} finally {
  if (windowId !== undefined) browser.close(windowId);
  if (app && !appWasRunning) osascript(`tell application ${quoted(app)} to quit`);
}
