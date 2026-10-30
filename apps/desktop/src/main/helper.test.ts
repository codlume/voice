import { connect } from "node:net";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import * as Option from "effect/Option";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import type { DiagnosticLog } from "./diagnostics-scrub.ts";
import { RESTART_MIN_MS, startHelper, type Helper, type HelperExit } from "./helper.ts";
import { decodeTarget, type HelperEvent } from "./protocol.ts";

const FAKE = NodePath.join(import.meta.dirname, "testing/fake-helper.ts");

type Observed = { at: number; event: HelperEvent };

function boot(config: Record<string, unknown> = {}, binary = FAKE) {
  const events: Observed[] = [];
  const exits: number[] = [];
  const exitReasons: HelperExit[] = [];
  const logs: string[] = [];
  const entries: DiagnosticLog[] = [];
  const waiters: { pred: (event: HelperEvent) => boolean; resolve: () => void }[] = [];
  process.env.VOICE_FAKE_HELPER = JSON.stringify(config);
  const helper = startHelper({
    binary,
    modelsDir: "/tmp/voice-models",
    stateDir: "/tmp/voice-state",
    env: process.env,
    configure: () => [
      { type: "hotkey.configure", key: "fn", toggleKey: null, transforms: [] },
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
    onExit: (exit) => {
      exits.push(Date.now());
      exitReasons.push(exit);
    },
    log: (message, entry) => {
      logs.push(message);
      if (entry) entries.push(entry);
    },
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
  return { helper, events, exits, exitReasons, logs, entries, waitFor, of };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// expect.poll and vi.waitFor advance a fake clock by their interval on every retry, which would
// show up in Date-stamped gaps. This waits on the real clock only.
const realSetTimeout = setTimeout;
async function until(pred: () => boolean, label: string) {
  const deadline = performance.now() + 3000;
  while (!pred()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => realSetTimeout(resolve, 10));
  }
}

async function sendControl(path: string, line: string) {
  const socket = connect(path);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.end(`${line}\n`);
}

describe("startHelper", () => {
  let helper: Helper | null = null;
  afterEach(async () => {
    vi.useRealTimers();
    await helper?.stop();
    helper = null;
  });

  test("configures a fresh helper and drives a full capture and insert", async () => {
    const h = boot({ transcript: "call ada tomorrow", startMs: 20 });
    helper = h.helper;
    await h.waitFor((e) => e.type === "asr.status");
    expect(h.of("ready")[0]?.event).toEqual({ type: "ready", version: 15 });
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

    h.helper.send({
      type: "capture.start",
      microphone: null,
      id: "s1",
      language: "en",
      outputVolumeScale: null,
      detectHost: true,
    });
    await h.waitFor((e) => e.type === "capture.started");
    expect(h.of("capture.started")[0]?.event).toEqual({
      type: "capture.started",
      id: "s1",
      startMs: 20,
      relayMs: null,
      asrState: null,
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

    h.helper.send({ type: "insert", id: "s1", text: transcript.text, html: null });
    await h.waitFor((e) => e.type === "insert.result");
    expect(h.of("insert.result")[0]?.event).toEqual({
      type: "insert.result",
      id: "s1",
      method: "accessibility",
      route: "direct",
    });
    expect(h.exits).toEqual([]);
  });

  test("test.target rides on the next capture only, even one that is cancelled", async () => {
    const h = boot({ transcript: "hi" });
    helper = h.helper;
    await h.waitFor((e) => e.type === "asr.status");
    const target = Option.getOrThrow(
      decodeTarget({ bundleId: "com.google.chrome", host: "mail.google.com" }),
    );
    const start = async (id: string) => {
      h.helper.send({
        type: "capture.start",
        microphone: null,
        id,
        language: "en",
        outputVolumeScale: null,
        detectHost: true,
      });
      await h.waitFor((e) => e.type === "capture.started" && e.id === id);
    };
    const capture = async (id: string) => {
      await start(id);
      h.helper.send({ type: "capture.stop", id });
      await h.waitFor((e) => e.type === "transcript" && e.id === id);
      return h.of("transcript").find(({ event }) => event.id === id)!.event.target;
    };
    h.helper.send({ type: "test.target", target });
    expect(await capture("s1")).toEqual(target);
    expect(await capture("s2")).toBeNull();

    h.helper.send({ type: "test.target", target });
    await start("s3");
    h.helper.send({ type: "capture.cancel", id: "s3" });
    await h.waitFor((e) => e.type === "capture.cancelled" && e.id === "s3");
    expect(await capture("s4")).toBeNull();

    h.helper.send({ type: "test.target", target });
    h.helper.send({ type: "test.target", target: null });
    expect(await capture("s5")).toBeNull();
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

  test("a selection read answers failed until the helper can read, and a configured one as told", async () => {
    const h = boot();
    helper = h.helper;
    await h.waitFor((e) => e.type === "asr.status");
    h.helper.send({ type: "selection.read", id: "r1" });
    await h.waitFor((e) => e.type === "selection.result");
    expect(h.of("selection.result").map((e) => e.event)).toEqual([
      { type: "selection.result", id: "r1", outcome: "failed", reason: "failed" },
    ]);
    h.helper.send({ type: "transform.end", id: "r1" });
    await h.helper.stop();

    const g = boot({ selection: { outcome: "selected", text: "Zażółć" } });
    helper = g.helper;
    await g.waitFor((e) => e.type === "asr.status");
    g.helper.send({ type: "selection.read", id: "r2" });
    await g.waitFor((e) => e.type === "selection.result");
    expect(g.of("selection.result").map((e) => e.event)).toEqual([
      { type: "selection.result", id: "r2", outcome: "selected", text: "Zażółć", via: "copy" },
    ]);
    expect(g.logs.join("\n")).not.toContain("unknown command");
  });

  test("a helper speaking another protocol version is refused, never configured, and not restarted", async () => {
    const h = boot({ version: 2 });
    helper = h.helper;
    await expect
      .poll(() => h.logs.join("\n"))
      .toMatch(/helper: speaks protocol v2 but this build expects v15; refusing/);
    expect(h.entries).toEqual([
      {
        message: "helper protocol mismatch",
        level: "fatal",
        attributes: { "helper.protocol_version": 2, "helper.expected_version": 15 },
      },
    ]);
    await sleep(RESTART_MIN_MS + 150);
    expect(h.events).toEqual([]);
    expect(h.exits).toEqual([]);
    expect(h.logs.join("\n")).not.toContain("hotkey configured");
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
    // Only this process is faked; the fake helper is a real child. Its spawn time then never
    // reaches the stamps, so each gap is exactly the restart delay.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const control = NodePath.join(tmpdir(), `voice-fake-backoff-${process.pid}.sock`);
    const h = boot({ control });
    helper = h.helper;
    for (const round of [1, 2]) {
      await until(() => h.of("asr.status").length === round, `helper ${round} configured`);
      await sendControl(control, "exit");
      await until(() => h.exits.length === round, `helper ${round} exited`);
      vi.advanceTimersToNextTimer();
    }
    await until(() => h.of("asr.status").length === 3, "helper 3 configured");
    const readyAt = h.of("ready").map((e) => e.at);
    expect([readyAt[1]! - h.exits[0]!, readyAt[2]! - h.exits[1]!]).toEqual([
      RESTART_MIN_MS,
      RESTART_MIN_MS * 2,
    ]);
    expect(h.logs.some((line) => line.includes("exited (3)"))).toBe(true);
    expect(h.exitReasons[0]).toEqual({ code: 3, signal: null, pid: expect.any(Number) });
  });

  test("reports a helper that cannot start by its errno code alone", async () => {
    const missing = NodePath.join(tmpdir(), "voice-no-such-helper", "voice-helper");
    const h = boot({}, missing);
    helper = h.helper;
    await expect.poll(() => h.exitReasons.length).toBeGreaterThanOrEqual(1);
    expect(h.exitReasons[0]).toEqual({ spawnError: "ENOENT" });
  });

  test("logs a malformed line by type and size only, never its text", async () => {
    const control = NodePath.join(tmpdir(), `voice-fake-${process.pid}.sock`);
    const h = boot({ control });
    helper = h.helper;
    await h.waitFor((e) => e.type === "ready");
    await sendControl(control, '{"type":"transcript","id":"x","text":"secret words"}');
    for (let i = 0; i < 50 && !h.logs.some((l) => l.includes("unparseable")); i += 1) {
      await sleep(20);
    }
    const line = h.logs.find((l) => l.includes("unparseable"));
    expect(line).toBe("helper: unparseable transcript line (52 chars)");
    expect(h.logs.join("\n")).not.toContain("secret");
    expect(h.entries).toEqual([{ message: "helper event unparseable", level: "error" }]);
  });

  test("a write still in flight when the helper exits is logged and dropped, not thrown", async () => {
    const h = boot({
      script: [
        { at: 10, action: "stall" },
        { at: 150, action: "exit" },
      ],
    });
    helper = h.helper;
    await h.waitFor((e) => e.type === "ready");
    await sleep(60);
    const text = "x".repeat(1 << 20);
    expect(() => h.helper.send({ type: "insert", id: "s1", text, html: null })).not.toThrow();
    await expect.poll(() => h.logs.join("\n")).toMatch(/helper: stdin .*EPIPE/);
    expect(h.entries).toContainEqual({
      message: "helper stdin failed",
      level: "warn",
      attributes: { "error.code": "EPIPE" },
    });
    await expect.poll(() => h.exits.length).toBeGreaterThanOrEqual(1);
  });

  test("lists fixture apps with a browser flag and answers an icon render by its id", async () => {
    const h = boot();
    helper = h.helper;
    await h.waitFor((e) => e.type === "asr.status");
    h.helper.send({ type: "apps.list" });
    await h.waitFor((e) => e.type === "apps.listed");
    const apps = h.of("apps.listed")[0]?.event.apps ?? [];
    expect(apps.map(({ bundleId, browser }) => [bundleId, browser])).toEqual([
      ["com.apple.MobileSMS", false],
      ["com.tinyspeck.slackmacgap", false],
      ["com.google.Chrome", true],
    ]);
    h.helper.send({ type: "icons.render", id: "7", paths: apps.map(({ path }) => path) });
    await h.waitFor((e) => e.type === "icons.rendered");
    expect(h.of("icons.rendered")[0]?.event).toEqual({
      type: "icons.rendered",
      id: "7",
      icons: [],
    });
  });

  test("drops commands while the helper is down instead of throwing", async () => {
    const h = boot({ script: [{ at: 10, action: "exit" }] });
    helper = h.helper;
    await h.waitFor((e) => e.type === "ready");
    await sleep(60);
    expect(() => h.helper.send({ type: "permissions.check" })).not.toThrow();
    expect(h.logs.some((line) => line.includes("dropped permissions.check"))).toBe(true);
    expect(h.entries).toContainEqual({
      message: "helper command dropped",
      level: "warn",
      attributes: { "command.type": "permissions.check" },
    });
  });
});
