// Drives the hub preview (renderer dev server) in headless Chrome over CDP to capture the help
// panel prototype and measure it.
//   node scripts/help-panel-bench.mjs <shots|record|bench> [--url=http://localhost:5791] [--out=dir] [--runs=15]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const [mode = "shots", ...rest] = process.argv.slice(2);
const flag = (name, fallback) =>
  rest.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const base = flag("url", "http://localhost:5791");
const out = flag("out", join(tmpdir(), "help-panel-evidence"));
const runs = Number(flag("runs", "15"));
const chromePath = flag("chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
mkdirSync(out, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), "help-bench-chrome-"));
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--window-size=1280,800",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "about:blank",
  ],
  { stdio: "ignore" },
);
const exited = new Promise((resolve) => chrome.on("exit", resolve));
process.on("exit", () => chrome.kill("SIGKILL"));
const stopChrome = async () => {
  chrome.kill("SIGTERM");
  await exited;
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
};

const portFile = join(profile, "DevToolsActivePort");
for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(50);
const port = readFileSync(portFile, "utf8").split("\n")[0];
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((target) => target.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));

let nextId = 1;
const pending = new Map();
const listeners = new Map();
ws.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.id) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  } else {
    for (const listener of listeners.get(message.method) ?? []) listener(message.params);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const on = (method, listener) =>
  listeners.set(method, [...(listeners.get(method) ?? []), listener]);
const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? "eval failed");
  return result.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Performance.enable", { timeDomain: "timeTicks" });
await send("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 800,
  deviceScaleFactor: mode === "bench" ? 1 : 2,
  mobile: false,
});

async function load(scene) {
  const loaded = new Promise((resolve) => on("Page.loadEventFired", resolve));
  await send("Page.navigate", { url: `${base}/preview.html?hub=${scene}` });
  await loaded;
  await evaluate(`new Promise((resolve) => {
    const ready = () => document.querySelector("main h1") && document.querySelector("[data-help]");
    const check = () => (ready() ? resolve(true) : setTimeout(check, 50));
    check();
  })`);
  await sleep(500);
}

const center = (selector) =>
  evaluate(`(() => {
    const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);
const move = (x, y) => send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
async function click(selector) {
  const { x, y } = await center(selector);
  await move(x, y);
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}
const key = async (code, keyName, keyCode, modifiers = 0) => {
  await send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    code,
    key: keyName,
    windowsVirtualKeyCode: keyCode,
    modifiers,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    code,
    key: keyName,
    windowsVirtualKeyCode: keyCode,
    modifiers,
  });
};
const tab = (shift = false) => key("Tab", "Tab", 9, shift ? 8 : 0);
const hoverItem = async (anchor) => {
  const { x, y } = await center(`[data-help-item="${anchor}"]`);
  await move(x, y);
};
const shot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(out, `${name}.png`), Buffer.from(data, "base64"));
  console.log(join(out, `${name}.png`));
};
const items = () =>
  evaluate(`[...document.querySelectorAll("[data-help-item]")].map((e) => e.dataset.helpItem)`);
const openHelp = () => click('button[aria-controls="hub-help"]');

if (mode === "shots") {
  for (const [scene, anchor] of [
    ["meetings", "meetings.start"],
    ["meetings", "meetings.list"],
    ["meetings", "meetings.overview"],
    ["insights", "insights.streak"],
    ["insights", "insights.fixes"],
  ]) {
    await load(scene);
    await openHelp();
    await sleep(400);
    await hoverItem(anchor);
    await sleep(600);
    await shot(`${scene}-${anchor.split(".")[1]}`);
  }
  await evaluate(`localStorage.setItem("voice.helpHighlight", "spotlight")`);
  await load("meetings");
  await openHelp();
  await sleep(400);
  await hoverItem("meetings.settings");
  await sleep(600);
  await shot("meetings-spotlight");
  await evaluate(`localStorage.removeItem("voice.helpHighlight")`);
}

if (mode === "record") {
  const frames = join(out, "frames");
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames);
  const stamps = [];
  on("Page.screencastFrame", ({ data, sessionId, metadata }) => {
    const file = join(frames, `${String(stamps.length).padStart(5, "0")}.png`);
    stamps.push({ file, at: metadata.timestamp });
    writeFileSync(file, Buffer.from(data, "base64"));
    void send("Page.screencastFrameAck", { sessionId });
  });
  await load("meetings");
  await send("Page.startScreencast", {
    format: "png",
    everyNthFrame: 1,
    maxWidth: 1280,
    maxHeight: 800,
  });
  await move(640, 400);
  await sleep(800);
  await openHelp();
  await sleep(900);
  for (const anchor of await items()) {
    await hoverItem(anchor);
    await sleep(900);
  }
  await move(1270, 790);
  await sleep(400);
  await evaluate(`document.querySelector("#hub-help h2").focus()`);
  for (let i = 0; i < 6; i++) {
    await tab();
    await sleep(900);
  }
  await key("Escape", "Escape", 27);
  await sleep(700);
  await load("insights");
  await move(640, 400);
  await openHelp();
  await sleep(900);
  for (const anchor of await items()) {
    await hoverItem(anchor);
    await sleep(900);
  }
  await move(1270, 790);
  await sleep(400);
  await evaluate(`document.querySelector("#hub-help h2").focus()`);
  for (let i = 0; i < 5; i++) {
    await tab();
    await sleep(900);
  }
  await send("Page.stopScreencast");
  await sleep(300);
  const list = stamps
    .map(({ file, at }, index) => {
      const next = stamps[index + 1]?.at ?? at + 0.04;
      return `file '${file}'\nduration ${Math.max(0.001, next - at).toFixed(4)}`;
    })
    .join("\n");
  writeFileSync(join(frames, "list.txt"), `${list}\nfile '${stamps.at(-1).file}'\n`);
  const video = join(out, "help-panel.mp4");
  await new Promise((resolve, reject) =>
    spawn(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        join(frames, "list.txt"),
        "-vf",
        "fps=30,scale=1280:-2,format=yuv420p",
        "-c:v",
        "libx264",
        video,
      ],
      { stdio: "inherit" },
    ).on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`)))),
  );
  rmSync(frames, { recursive: true, force: true });
  console.log(video, `${stamps.length} frames`);
}

if (mode === "bench") {
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const pct = (values, p) =>
    [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
  const round = (n) => Math.round(n * 100) / 100;
  const metrics = async () =>
    Object.fromEntries(
      (await send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]),
    );
  const delta = (before, after, names) =>
    Object.fromEntries(names.map((name) => [name, after[name] - before[name]]));

  // Paint time = the frame after the change: rAF, then a task queued from it runs after that paint.
  const probe = `window.__probe = {
    nextPaint: () => new Promise((resolve) => requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve(performance.now());
      channel.port2.postMessage(0);
    })),
    shifts: [],
  };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__probe.shifts.push({ value: entry.value, recent: entry.hadRecentInput });
  }).observe({ type: "layout-shift", buffered: true });`;

  const results = { scenes: {} };
  for (const scene of ["meetings", "insights"]) {
    const r = {};
    await load(scene);
    await evaluate(probe);

    const open = [];
    const shown = [];
    const openLayout = [];
    for (let i = 0; i < runs; i++) {
      await move(5, 795);
      await evaluate(`window.__open = new Promise((resolve) => {
        let clickAt = 0;
        addEventListener("click", (event) => { clickAt = event.timeStamp; }, { capture: true, once: true });
        const observer = new MutationObserver(async () => {
          const panel = document.getElementById("hub-help");
          if (!panel) return;
          observer.disconnect();
          const ended = panel.getAnimations().length
            ? new Promise((done) => panel.addEventListener("animationend", done, { once: true }))
            : Promise.resolve();
          const painted = await window.__probe.nextPaint();
          await ended;
          const full = await window.__probe.nextPaint();
          resolve({ painted: painted - clickAt, full: full - clickAt });
        });
        observer.observe(document.body, { childList: true, subtree: true });
      }); true`);
      const before = await metrics();
      await openHelp();
      const { painted, full } = await evaluate(`window.__open`);
      const after = await metrics();
      open.push(painted);
      shown.push(full);
      openLayout.push(delta(before, after, ["LayoutDuration", "RecalcStyleDuration"]));
      await click('button[aria-controls="hub-help"]');
      await sleep(250);
    }
    r.openToFirstPaintMs = round(median(open));
    r.openToFullyShownMs = round(median(shown));
    r.openLayoutMs = round(median(openLayout.map((m) => m.LayoutDuration * 1000)));
    r.openStyleMs = round(median(openLayout.map((m) => m.RecalcStyleDuration * 1000)));

    await openHelp();
    await sleep(400);
    const anchors = await items();
    const present = await evaluate(
      `${JSON.stringify(anchors)}.filter((a) => document.querySelector('[data-help="' + a + '"]')?.getClientRects().length > 0)`,
    );
    r.anchorsVisible = `${present.length}/${anchors.length}`;
    // Stable layout probe: the target rects must not move when the ring draws.
    const rects = `JSON.stringify(${JSON.stringify(present)}.map((a) => { const b = document.querySelector('[data-help="' + a + '"],[data-help-off="' + a + '"]').getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map(Math.round); }))`;

    const armHover = `window.__hover = new Promise((resolve) => {
      let at = 0;
      const ring = document.querySelector("[data-help-ring]");
      addEventListener("pointerover", (event) => { if (event.target.closest?.("[data-help-item]")) at = event.timeStamp; }, { capture: true, once: true });
      const observer = new MutationObserver(async () => {
        observer.disconnect();
        resolve((await window.__probe.nextPaint()) - at);
      });
      observer.observe(ring, { attributes: true, attributeFilter: ["style"] });
      setTimeout(() => resolve({ timeout: true, active: document.activeElement?.outerHTML.slice(0, 80), at }), 2000);
    }); true`;
    const hover = [];
    for (let i = 0; i < runs; i++) {
      // A highlight from nothing, so scrolling to the control does not differ between runs.
      await move(5, 795);
      await sleep(200);
      await evaluate(armHover);
      await hoverItem(present[i % present.length]);
      hover.push(await evaluate(`window.__hover`));
      await sleep(250);
    }
    r.hoverToHighlightPaintMs = round(median(hover));
    r.hoverToHighlightP95Ms = round(pct(hover, 0.95));

    const armFocus = armHover.replace(`"pointerover"`, `"focusin"`);
    const focus = [];
    await move(5, 795);
    for (let i = 0; i < runs; i++) {
      await evaluate(`document.querySelector('#hub-help button[aria-label="Close help"]').focus()`);
      await sleep(150);
      await evaluate(armFocus);
      await tab();
      const value = await evaluate(`window.__hover`);
      if (typeof value !== "number") console.error("focus run", i, value);
      else focus.push(value);
      await sleep(200);
    }
    r.focusToHighlightPaintMs = round(median(focus));

    // Off: the view's anchors are renamed, so hovering an item runs the panel's own work but
    // finds no control to ring. The difference between the two is what the highlight costs.
    const sweepOnce = async (highlight) => {
      if (!highlight)
        await evaluate(
          `document.querySelectorAll("[data-help]").forEach((e) => { e.dataset.helpOff = e.dataset.help; delete e.dataset.help; }); true`,
        );
      await move(5, 795);
      await evaluate(`document.activeElement.blur()`);
      await sleep(500);
      const rectsBefore = await evaluate(rects);
      await evaluate(`window.__probe.shifts.length = 0`);
      await evaluate(`window.__frames = []; window.__loaf = []; window.__recording = true;
      new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__loaf.push(e.duration); }).observe({ type: "long-animation-frame" });
      (function tick(last) { requestAnimationFrame((now) => { if (last) window.__frames.push(now - last); if (window.__recording) tick(now); }); })(0); true`);
      const sweepBefore = await metrics();
      const boxes = await evaluate(
        `[...document.querySelectorAll("[data-help-item]")].map((e) => { const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, top: b.top + 2, bottom: b.bottom - 2 }; })`,
      );
      const top = boxes[0].top;
      const bottom = boxes.at(-1).bottom;
      let changes = 0;
      let last = null;
      for (let sweep = 0; sweep < 4; sweep++) {
        for (let step = 0; step <= 60; step++) {
          const t = sweep % 2 ? 1 - step / 60 : step / 60;
          const y = top + (bottom - top) * t;
          const current = boxes.findIndex((b) => y >= b.top && y <= b.bottom);
          if (current !== -1 && current !== last) changes++;
          last = current === -1 ? last : current;
          await move(boxes[0].x, y);
          await sleep(16);
        }
      }
      const sweepAfter = await metrics();
      await evaluate(`window.__recording = false`);
      await sleep(100);
      const frames = await evaluate(`window.__frames`);
      const loaf = await evaluate(`window.__loaf`);
      const rectsAfter = await evaluate(rects);
      const shifts = await evaluate(`window.__probe.shifts`);
      const sweep = delta(sweepBefore, sweepAfter, [
        "LayoutCount",
        "RecalcStyleCount",
        "LayoutDuration",
        "RecalcStyleDuration",
        "ScriptDuration",
        "TaskDuration",
      ]);
      const result = {
        highlightChanges: changes,
        frames: frames.length,
        frameMedianMs: round(median(frames)),
        frameP95Ms: round(pct(frames, 0.95)),
        frameMaxMs: round(Math.max(...frames)),
        framesOver20Ms: frames.filter((f) => f > 20).length,
        longAnimationFrames: loaf.length,
        layoutShiftSum: round(shifts.reduce((sum, s) => sum + s.value, 0)),
        targetsMoved: rectsBefore !== rectsAfter,
        perChange: {
          layouts: round(sweep.LayoutCount / changes),
          layoutMs: round((sweep.LayoutDuration * 1000) / changes),
          styleMs: round((sweep.RecalcStyleDuration * 1000) / changes),
          scriptMs: round((sweep.ScriptDuration * 1000) / changes),
          taskMs: round((sweep.TaskDuration * 1000) / changes),
        },
      };

      if (!highlight)
        await evaluate(
          `document.querySelectorAll("[data-help-off]").forEach((e) => { e.dataset.help = e.dataset.helpOff; delete e.dataset.helpOff; }); true`,
        );
      return result;
    };
    const on = [];
    const off = [];
    for (let i = 0; i < 3; i++) {
      on.push(await sweepOnce(true));
      off.push(await sweepOnce(false));
    }
    const mid = (list, pick) => round(median(list.map(pick)));
    r.sweep = {
      highlightChanges: on[0].highlightChanges,
      frames: on.reduce((n, x) => n + x.frames, 0),
      frameMedianMs: mid(on, (x) => x.frameMedianMs),
      frameP95Ms: mid(on, (x) => x.frameP95Ms),
      frameMaxMs: Math.max(...on.map((x) => x.frameMaxMs)),
      framesOver20Ms: on.reduce((n, x) => n + x.framesOver20Ms, 0),
      longAnimationFrames: on.reduce((n, x) => n + x.longAnimationFrames, 0),
      layoutShiftSum: on.reduce((n, x) => n + x.layoutShiftSum, 0),
      targetsMoved: on.some((x) => x.targetsMoved),
    };
    r.highlightCostPerChange = Object.fromEntries(
      Object.keys(on[0].perChange).map((k) => [
        k,
        {
          on: mid(on, (x) => x.perChange[k]),
          off: mid(off, (x) => x.perChange[k]),
          added: round(
            median(on.map((x) => x.perChange[k])) - median(off.map((x) => x.perChange[k])),
          ),
        },
      ]),
    );

    const idle = async (label) => {
      await sleep(1000);
      const samples = [];
      for (let i = 0; i < 5; i++) {
        const a = await metrics();
        await sleep(2000);
        const b = await metrics();
        samples.push(((b.TaskDuration - a.TaskDuration) * 1000) / 2);
      }
      r[label] = round(median(samples));
    };
    await move(5, 795);
    await click('button[aria-controls="hub-help"]');
    await idle("idleClosedTaskMsPerSec");
    await openHelp();
    await move(5, 795);
    await idle("idleOpenTaskMsPerSec");
    await hoverItem(present[0]);
    await idle("idleHighlightedTaskMsPerSec");
    results.scenes[scene] = r;
  }
  results.method = { runs, chrome: chromePath, viewport: "1280x800@1x", url: base };
  writeFileSync(join(out, "bench.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
}

ws.close();
await stopChrome();
process.exit(0);
