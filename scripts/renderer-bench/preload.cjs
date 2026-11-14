"use strict";
// Preload of the benchmark window. It bridges `window.voice` to the fake main the way the app's
// preloads do (sandboxed, isolated world, contextBridge, one IPC message per call or event), and
// installs the probe in the page before any app script runs.

/**
 * Components that rendered in the commit whose root fiber is `root`, decided as React DevTools
 * decides it: a fiber with no alternate mounted, React visited a subtree only where the child
 * pointer changed, and a visited component rendered if it carries the PerformedWork flag.
 */
function countRendered(root) {
  // FunctionComponent, ClassComponent, ForwardRef and SimpleMemoComponent call component code.
  const renders = new Set([0, 1, 11, 15]);
  const performedWork = 1;
  let count = 0;
  const pending = [{ fiber: root, mounting: false }];
  for (let next = pending.pop(); next; next = pending.pop()) {
    const { fiber } = next;
    const mounting = next.mounting || fiber.alternate === null;
    if (renders.has(fiber.tag) && (mounting || (fiber.flags & performedWork) !== 0)) count += 1;
    if (mounting || fiber.child !== fiber.alternate.child) {
      for (let child = fiber.child; child !== null; child = child.sibling) {
        pending.push({ fiber: child, mounting });
      }
    }
  }
  return count;
}

/* eslint-disable unicorn/consistent-function-scoping -- the probe is serialized whole, so it carries its helpers */
/** Runs in the page's own world. It must not close over anything in this file. */
function installProbe(componentsRendered, methods) {
  const pill = location.pathname.endsWith("pill.html");
  const readySelector = pill ? "[role=status]" : "#history";
  const bridge = window.voiceBridge;
  const commits = [];
  const longTasks = [];
  const commitWaiters = [];
  let first = null;
  const firstPainted = () => first?.paintedMs ?? null;
  const firstPaint = () =>
    performance.getEntriesByName(pill ? "first-paint" : "first-contentful-paint")[0]?.startTime;

  // Only the methods the app's own preload has, so a call the app could not make throws here too.
  window.voice = { diagnosticsStartedAtLaunch: false };
  for (const name of methods) {
    window.voice[name] = name.startsWith("on")
      ? (listener) => bridge.on(name, listener)
      : (...args) => bridge.call(name, args);
  }

  // The next frame's rendering has run on the main thread once a task queued from rAF runs.
  const frame = () =>
    new Promise((resolve) => {
      requestAnimationFrame(() => {
        const { port1, port2 } = new MessageChannel();
        port1.addEventListener("message", () => resolve(performance.now()), { once: true });
        port1.start();
        port2.postMessage(null);
      });
    });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // eslint-disable-next-line no-underscore-dangle -- the name React looks for
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    inject: () => 1,
    onCommitFiberUnmount() {},
    onCommitFiberRoot(_id, root) {
      commits.push({
        at: performance.now(),
        // Only the profiling build of react-dom measures render and effect time.
        renderMs: root.current.actualDuration ?? null,
        effectsMs: 0,
        components: componentsRendered(root.current),
      });
      for (const wake of commitWaiters.splice(0)) wake();
      if (first === null && document.querySelector(readySelector)) {
        first = { committedMs: performance.now(), paintedMs: null };
        void frame().then((at) => {
          first.paintedMs = at;
        });
      }
    },
    onPostCommitFiberRoot(_id, root) {
      const last = commits.at(-1);
      if (last && root.effectDuration !== undefined) {
        last.effectsMs += root.effectDuration + root.passiveEffectDuration;
      }
    },
  };

  new PerformanceObserver((list) => {
    for (const task of list.getEntries()) {
      longTasks.push({ end: task.startTime + task.duration, ms: task.duration });
    }
  }).observe({ type: "longtask", buffered: true });

  const settle = async (quietMs) => {
    const started = performance.now();
    for (;;) {
      const busyUntil = Math.max(started, commits.at(-1)?.at ?? 0, longTasks.at(-1)?.end ?? 0);
      const wait = busyUntil + quietMs - performance.now();
      if (wait <= 0) return;
      if (performance.now() - started > 15_000) throw new Error("the page did not settle in 15 s");
      await sleep(wait);
    }
  };

  const since = (from) => {
    const done = commits.slice(from);
    const react = done.map((commit) => commit.renderMs + commit.effectsMs);
    const profiled = done.every((commit) => commit.renderMs !== null);
    return {
      commits: done.length,
      components: done.reduce((sum, commit) => sum + commit.components, 0),
      reactMs: profiled ? react.reduce((sum, ms) => sum + ms, 0) : null,
    };
  };

  // `wallMs` is click→paint and `doneMs` is click→last commit (see the header of renderer-bench.mjs).
  const measure = async (act) => {
    const from = commits.length;
    const started = performance.now();
    act();
    const painted = await frame();
    await settle(300);
    const doneMs = commits.length > from ? commits.at(-1).at - started : null;
    return { ...since(from), wallMs: painted - started, doneMs };
  };

  const find = (selector, text) => {
    const found = Array.from(document.querySelectorAll(selector)).find(
      (element) => text === undefined || element.textContent.trim().startsWith(text),
    );
    if (!found) throw new Error(`no ${selector}${text === undefined ? "" : ` reading "${text}"`}`);
    return found;
  };

  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;

  window.bench = {
    /** Resolves once the page's first real render is painted and the page went quiet. */
    async ready() {
      const deadline = performance.now() + 20_000;
      while (firstPainted() === null) {
        if (performance.now() > deadline) throw new Error(`never rendered ${readySelector}`);
        await frame();
      }
      // The paint entry arrives once the frame is on screen, after the main thread's part of it.
      while (firstPaint() === undefined) {
        if (performance.now() > deadline) throw new Error("the first frame was never presented");
        await frame();
      }
      await settle(500);
      const frames = [await frame()];
      for (let i = 0; i < 5; i += 1) frames.push(await frame());
      return {
        ...since(0),
        paintMs: firstPaint(),
        reactStartMs: commits[0].at,
        firstRenderMs: first.committedMs,
        interactiveMs: Math.max(firstPaint(), firstPainted(), ...longTasks.map((task) => task.end)),
        longestTaskMs: Math.max(0, ...longTasks.map((task) => task.ms)),
        frameMs: (frames[5] - frames[0]) / 5,
        domNodes: document.getElementsByTagName("*").length,
      };
    },
    click(selector, text) {
      const target = find(selector, text);
      return measure(() => target.click());
    },
    type(selector, value) {
      const input = find(selector);
      return measure(() => {
        setValue.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
    /** What the last message main sent made React do, once it has committed. */
    async after(from) {
      if (commits.length === from) {
        const committed = new Promise((resolve) => commitWaiters.push(resolve));
        const late = sleep(2000).then(() => {
          if (commits.length === from) throw new Error("a pushed message caused no commit in 2 s");
        });
        await Promise.race([committed, late]);
      }
      const wallMs = commits[from].at - bridge.arrivedAt();
      await frame();
      return { ...since(from), wallMs };
    },
    /** Commits during `ms` with nothing pushed. */
    async idle(ms) {
      const from = commits.length;
      await sleep(ms);
      return commits.length - from;
    },
    /** Drops the probe's own records, so a heap sample holds the page's memory and not the probe's. */
    forget() {
      commits.length = 0;
      longTasks.length = 0;
    },
    mark: () => commits.length,
    count: (selector) => document.querySelectorAll(selector).length,
    text: (selector, text) => find(selector, text).textContent,
    scroll(selector, top) {
      find(selector).scrollTo({ top });
      return frame();
    },
  };
}
/* eslint-enable unicorn/consistent-function-scoping */

const { contextBridge, ipcRenderer } = require("electron");
const listeners = new Map();
let arrivedAt = 0;
ipcRenderer.on("bench:event", (_event, name, value) => {
  arrivedAt = performance.now();
  for (const listener of listeners.get(name) ?? []) listener(value);
});
contextBridge.exposeInMainWorld("voiceBridge", {
  call: (name, args) => ipcRenderer.invoke("bench:call", name, args),
  on(name, listener) {
    const named = listeners.get(name) ?? new Set();
    listeners.set(name, named.add(listener));
    return () => named.delete(listener);
  },
  arrivedAt: () => arrivedAt,
});
// executeInMainWorld serializes one function, so the probe and the counter travel as one.
const source = `return (${installProbe})(${countRendered}, methods)`;
contextBridge.executeInMainWorld({
  func: new Function("methods", source),
  args: [ipcRenderer.sendSync("bench:methods")],
});
