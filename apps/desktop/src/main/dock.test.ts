import { describe, expect, test } from "vite-plus/test";

import type { DiagnosticLog } from "./diagnostics-scrub.ts";
import { createDockSync } from "./dock.ts";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(options: { show?: () => Promise<void> } = {}) {
  const calls: Array<"show" | "hide"> = [];
  const waits: Array<() => void> = [];
  const logs: string[] = [];
  const entries: DiagnosticLog[] = [];
  let afterChanges = 0;
  let showInDock = true;
  const sync = createDockSync({
    dock: {
      show: async () => {
        calls.push("show");
        await options.show?.();
      },
      hide: () => calls.push("hide"),
    },
    showInDock: () => showInDock,
    wait: () => new Promise((resolve) => waits.push(resolve)),
    afterChange: () => afterChanges++,
    log: (message, entry) => {
      logs.push(message);
      if (entry) entries.push(entry);
    },
  });
  // Each settings change reaches main in its own IPC task, so a request lands after the
  // previous one has started. The applied promise is boxed so awaiting the request does not
  // also wait for the change.
  async function request(value: boolean) {
    showInDock = value;
    const applied = sync();
    await flush();
    return { applied };
  }
  async function drain(applied: Promise<void>) {
    const done = applied.then(() => true);
    while (!(await Promise.race([done, flush().then(() => false)]))) waits.shift()?.();
  }
  return { calls, logs, entries, waits, afterChanges: () => afterChanges, request, drain };
}

describe("createDockSync", () => {
  test("holds a hide until the settle after a show has passed", async () => {
    const dock = harness();
    await dock.request(true);
    const off = await dock.request(false);
    expect(dock.calls).toEqual(["show"]);
    dock.waits.shift()?.();
    await off.applied;
    expect(dock.calls).toEqual(["show", "hide"]);
  });

  test.each([
    [[true, false, true, false], "hide"],
    [[false, true, false, true], "show"],
  ] as const)("fast toggles %j end with %s", async (values, final) => {
    const dock = harness();
    let last = Promise.resolve();
    for (const value of values) last = (await dock.request(value)).applied;
    await dock.drain(last);
    expect(dock.calls.at(-1)).toBe(final);
  });

  test("logs a failed show and still applies a later change", async () => {
    const dock = harness({ show: () => Promise.reject(new Error("no dock")) });
    await dock.drain((await dock.request(true)).applied);
    expect(dock.logs).toEqual(["dock: no dock"]);
    expect(dock.entries).toEqual([{ message: "dock update failed", level: "warn" }]);
    await dock.drain((await dock.request(false)).applied);
    expect(dock.calls).toEqual(["show", "hide"]);
    expect(dock.afterChanges()).toBe(1);
  });

  test("runs afterChange once a change has applied", async () => {
    const dock = harness();
    const on = await dock.request(true);
    expect(dock.afterChanges()).toBe(0);
    await dock.drain(on.applied);
    expect(dock.afterChanges()).toBe(1);
    await dock.drain((await dock.request(false)).applied);
    expect(dock.afterChanges()).toBe(2);
  });
});
