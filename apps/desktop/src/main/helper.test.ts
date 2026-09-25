import * as NodePath from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { RESTART_MIN_MS, startHelper, type Helper } from "./helper.ts";
import type { HelperEvent } from "./protocol.ts";

const FAKE = NodePath.join(import.meta.dirname, "testing/fake-helper.ts");

type Observed = { at: number; event: HelperEvent };

function boot(config: Record<string, unknown> = {}) {
  const events: Observed[] = [];
  const exits: number[] = [];
  const logs: string[] = [];
  const waiters: { pred: (event: HelperEvent) => boolean; resolve: () => void }[] = [];
  process.env.VOICE_FAKE_HELPER = JSON.stringify(config);
  const helper = startHelper({
    binary: FAKE,
    modelsDir: "/tmp/voice-models",
    configure: () => [
      { type: "hotkey.configure", key: "fn" },
      { type: "permissions.check" },
      { type: "asr.prepare", download: false },
    ],
    onEvent: (event) => {
      events.push({ at: Date.now(), event });
      for (const waiter of waiters.filter((w) => w.pred(event))) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    },
    onExit: () => exits.push(Date.now()),
    log: (message) => logs.push(message),
  });
  const waitFor = (pred: (event: HelperEvent) => boolean, ms = 5000) =>
    new Promise<void>((resolve, reject) => {
      if (events.some(({ event }) => pred(event))) return resolve();
      const timer = setTimeout(
        () =>
          reject(
            new Error(`timed out waiting; saw ${JSON.stringify(events.map((e) => e.event.type))}`),
          ),
        ms,
      );
      waiters.push({ pred, resolve: () => (clearTimeout(timer), resolve()) });
    });
  const of = <T extends HelperEvent["type"]>(type: T) =>
    events.filter(
      (e): e is Observed & { event: Extract<HelperEvent, { type: T }> } => e.event.type === type,
    );
  return { helper, events, exits, logs, waitFor, of };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("startHelper", () => {
  let helper: Helper | null = null;
  afterEach(async () => {
    await helper?.stop();
    helper = null;
  });

  test("configures a fresh helper and drives a full capture and insert", async () => {
    const h = boot({ transcript: "call ada tomorrow", startMs: 20 });
    helper = h.helper;
    await h.waitFor((e) => e.type === "asr.status");
    expect(h.of("ready")[0]?.event).toEqual({ type: "ready", version: 1 });
    expect(h.of("log").map((e) => e.event.message)).toContain("hotkey configured: fn");
    expect(h.of("permissions")[0]?.event).toEqual({
      type: "permissions",
      microphone: "granted",
      accessibility: "granted",
    });
    expect(h.of("asr.status")[0]?.event).toEqual({
      type: "asr.status",
      state: "ready",
      message: null,
    });

    h.helper.send({ type: "capture.start", id: "s1" });
    await h.waitFor((e) => e.type === "capture.started");
    expect(h.of("capture.started")[0]?.event).toEqual({
      type: "capture.started",
      id: "s1",
      startMs: 20,
    });
    await sleep(120);
    h.helper.send({ type: "capture.stop", id: "s1" });
    await h.waitFor((e) => e.type === "transcript");
    const levels = h.of("capture.level");
    expect(levels.length).toBeGreaterThanOrEqual(2);
    expect(levels.every(({ event }) => event.level >= 0 && event.level <= 1)).toBe(true);
    const transcript = h.of("transcript")[0]!.event;
    expect(transcript).toMatchObject({ id: "s1", text: "call ada tomorrow", asrMs: 40 });
    expect(transcript.audioMs).toBeGreaterThanOrEqual(100);

    h.helper.send({ type: "insert", id: "s1", text: transcript.text });
    await h.waitFor((e) => e.type === "insert.result");
    expect(h.of("insert.result")[0]?.event).toEqual({
      type: "insert.result",
      id: "s1",
      method: "accessibility",
      reason: null,
    });
    expect(h.exits).toEqual([]);
  });

  test("stop ends the child and does not restart it", async () => {
    const h = boot();
    helper = h.helper;
    await h.waitFor((e) => e.type === "ready");
    await h.helper.stop();
    helper = null;
    await sleep(RESTART_MIN_MS + 150);
    expect(h.of("ready")).toHaveLength(1);
    expect(h.exits).toEqual([]);
  });

  test("reports scripted hotkey actions in order", async () => {
    const h = boot({
      script: [
        { at: 10, action: "down" },
        { at: 60, action: "up" },
        { at: 90, action: "cancel" },
      ],
    });
    helper = h.helper;
    await h.waitFor((e) => e.type === "hotkey" && e.action === "cancel");
    expect(h.of("hotkey").map((e) => e.event.action)).toEqual(["down", "up", "cancel"]);
  });

  test("restarts an exited helper with doubling backoff and reconfigures it", async () => {
    const h = boot({ script: [{ at: 10, action: "exit" }] });
    helper = h.helper;
    await h.waitFor(() => h.of("asr.status").length >= 3, 8000);
    const readyAt = h.of("ready").map((e) => e.at);
    expect(h.exits.length).toBeGreaterThanOrEqual(2);
    const firstGap = readyAt[1]! - h.exits[0]!;
    const secondGap = readyAt[2]! - h.exits[1]!;
    expect(firstGap).toBeGreaterThanOrEqual(RESTART_MIN_MS - 5);
    expect(firstGap).toBeLessThan(RESTART_MIN_MS * 2);
    expect(secondGap).toBeGreaterThanOrEqual(RESTART_MIN_MS * 2 - 5);
    expect(secondGap).toBeLessThan(RESTART_MIN_MS * 4);
    expect(h.of("asr.status").length).toBeGreaterThanOrEqual(3);
    expect(h.logs.some((line) => line.includes("exited (3)"))).toBe(true);
  });

  test("drops commands while the helper is down instead of throwing", async () => {
    const h = boot({ script: [{ at: 10, action: "exit" }] });
    helper = h.helper;
    await h.waitFor((e) => e.type === "ready");
    await sleep(60);
    expect(() => h.helper.send({ type: "permissions.check" })).not.toThrow();
    expect(h.logs.some((line) => line.includes("dropped permissions.check"))).toBe(true);
  });
});
