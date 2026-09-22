import { afterEach, expect, it, vi } from "vite-plus/test";
import { createCommands, floatingBarPermits } from "./commands";
import { createSession } from "./session";
import { menuEntries, type MenuEntry } from "./menu-bar";
import { decodeReply, type View } from "@voice/contracts/desktop";
import type {
  CaptureCommand,
  InsertionOutcome,
  ProviderRequest,
  TargetStatus,
} from "@voice/contracts/session";

// The shortcut, floating bar, menu bar, and main window drive one session owner. Each test mixes
// entry points and asserts only the observable session outcome and the commands sent to adapters.
afterEach(() => vi.useRealTimers());
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
type Sender = "window" | "bar";
function fixture(
  overrides: {
    available?: () => boolean;
    target?: TargetStatus;
    insert?: () => Promise<InsertionOutcome>;
  } = {},
) {
  const capture: CaptureCommand[] = [];
  const provider: ProviderRequest[] = [];
  const targets: string[] = [];
  const opened: View[] = [];
  const owner = createSession({
    available: overrides.available ?? (() => true),
    device: () => null,
    credential: async () => "synthetic",
    capture: (command) => capture.push(command),
    provider: (command) => provider.push(command),
    changed: () => {},
    copy: async () => true,
    access: () => {},
    target: {
      capture: async (id) => {
        targets.push(`capture:${id}`);
        return overrides.target ?? "eligible";
      },
      arm: async (id) => {
        targets.push(`arm:${id}`);
      },
      insert: async (id, text) => {
        targets.push(`insert:${id}:${text}`);
        return overrides.insert ? overrides.insert() : "inserted";
      },
      release: () => {},
    },
    engaged: () => {},
  });
  const commands = createCommands<Sender>({
    session: () => owner,
    open: (view) => opened.push(view),
    isAuthorized: () => true,
    permitted: (sender, command) => sender !== "bar" || floatingBarPermits(command),
    initialSettings: { appearance: "light" },
    storage: { set: async (value) => value, restart: async () => ({ appearance: "light" }) },
    status: () => ({
      storage: "ready",
      helper: "ready",
      capture: "available",
      shortcuts: "listening",
    }),
  });
  const send = async (sender: Sender, payload: unknown) =>
    decodeReply(await commands.execute(sender, payload));
  const menu = () =>
    menuEntries(owner.snapshot(), {
      session: (command) => void owner.execute(command),
      open: (view) => opened.push(view),
      quit: () => {},
    });
  const item = (label: string) => {
    const entry = menu().find(
      (candidate): candidate is Exclude<MenuEntry, { type: "separator" }> =>
        !("type" in candidate) && candidate.label.startsWith(label),
    );
    if (!entry) throw new Error(`Missing menu item ${label}`);
    return entry;
  };
  const click = (label: string) => {
    const entry = item(label);
    if (!entry.enabled) throw new Error(`${label} is disabled`);
    entry.run?.();
  };
  const starts = () => capture.filter((command) => command.type === "capture.start");
  const identity = () => {
    const start = starts().at(-1);
    if (!start) throw new Error("No capture started");
    return { session: start.session, attempt: start.attempt };
  };
  const frame = () =>
    owner.captureEvent({
      type: "capture.frame",
      ...identity(),
      sequence: 0,
      pcm: Buffer.alloc(640, 3).toString("base64"),
    });
  const finish = (text: string) => {
    owner.captureEvent({ type: "capture.stopped", ...identity(), frames: 1, samples: 320 });
    owner.providerEvent({ type: "complete", ...identity(), text, samples: 320 });
  };
  return {
    owner,
    capture,
    provider,
    targets,
    opened,
    send,
    item,
    click,
    starts,
    identity,
    frame,
    finish,
  };
}

it("shortcut Start then floating-bar Stop inserts once into the original target", async () => {
  const { owner, send, targets, starts, frame, finish, identity } = fixture();
  owner.shortcut("hold.down");
  await settle();
  frame();
  expect(owner.snapshot().phase).toBe("recording");
  const stopped = await send("bar", { type: "session.stop" });
  expect(stopped).toMatchObject({ ok: true, session: { phase: "processing" } });
  owner.shortcut("hold.up");
  owner.shortcut("hold.down");
  expect(starts()).toHaveLength(1);
  finish("Bar stopped.");
  await settle();
  expect(targets.filter((entry) => entry.startsWith("insert:"))).toEqual([
    `insert:${identity().session}:Bar stopped.`,
  ]);
  expect(owner.snapshot()).toMatchObject({ phase: "complete", message: "Inserted.", notice: null });
  owner.close();
});

it("menu Start then main-window Cancel stops capture and Start stays disabled until capture ends", async () => {
  const { owner, send, click, item, capture, targets, identity, frame } = fixture();
  expect(item("Stop").enabled).toBe(false);
  click("Start dictation");
  expect(owner.snapshot()).toMatchObject({ phase: "starting", origin: "dictation" });
  expect(targets).toEqual([`capture:${identity().session}`]);
  await settle();
  frame();
  expect(item("Start dictation")).toMatchObject({
    enabled: false,
    sublabel: "A session is already in progress.",
  });
  expect(item("Stop").enabled).toBe(true);
  expect(await send("window", { type: "session.cancel" })).toMatchObject({
    ok: true,
    session: { phase: "cancelled", blocker: "busy" },
  });
  expect(capture.at(-1)).toMatchObject({ type: "capture.cancel", ...identity() });
  expect(item("Start dictation").enabled).toBe(false);
  owner.captureEvent({ type: "capture.stopped", ...identity(), frames: 0, samples: 0 });
  expect(item("Start dictation")).toMatchObject({ enabled: true });
  expect(item("Start dictation")).not.toHaveProperty("sublabel");
  owner.close();
});

it("floating-bar Start then menu Cancel, and the bar can only reach dictation controls", async () => {
  const { owner, send, click, starts, frame } = fixture();
  expect(await send("bar", { type: "session.start", origin: "practice" })).toEqual({
    ok: false,
    error: "unauthorized",
  });
  expect(await send("bar", { type: "recovery.copy", id: "any" })).toEqual({
    ok: false,
    error: "unauthorized",
  });
  expect(await send("bar", { type: "credential.remove" })).toEqual({
    ok: false,
    error: "unauthorized",
  });
  expect(starts()).toHaveLength(0);
  expect(await send("bar", { type: "session.start", origin: "dictation" })).toMatchObject({
    ok: true,
    session: { phase: "starting", origin: "dictation" },
  });
  await send("bar", { type: "session.start", origin: "dictation" });
  expect(starts()).toHaveLength(1);
  await settle();
  frame();
  click("Cancel");
  expect(owner.snapshot().phase).toBe("cancelled");
  owner.close();
});

it("opening recovery while processing leaves the session running and its changed target goes to recovery", async () => {
  const { owner, send, click, item, opened, frame, finish } = fixture({
    insert: async () => "changed",
  });
  await send("bar", { type: "session.start", origin: "dictation" });
  await settle();
  frame();
  await send("bar", { type: "session.stop" });
  click("Open recovery");
  expect(await send("bar", { type: "app.open", view: "recovery" })).toMatchObject({ ok: true });
  expect(opened).toEqual(["recovery", "recovery"]);
  expect(owner.snapshot().phase).toBe("processing");
  finish("Keep this.");
  await settle();
  const snapshot = owner.snapshot();
  expect(snapshot).toMatchObject({
    phase: "failed",
    notice: "not-inserted",
    recovery: [expect.objectContaining({ text: "Keep this.", delivery: "failed" })],
  });
  expect(snapshot.lastTranscript).toBe(snapshot.recovery[0]?.id);
  expect(item("Open recovery").label).toBe("Open recovery (1 of 5)");
  owner.close();
});

it("Copy and Paste last transcript act on the newest held transcript, even an undelivered one", async () => {
  let outcome: InsertionOutcome = "inserted";
  const { owner, click, item, targets, frame, finish } = fixture({ insert: async () => outcome });
  expect(item("Copy last transcript")).toMatchObject({
    enabled: false,
    sublabel: "No transcript is held.",
  });
  expect(item("Paste last transcript").enabled).toBe(false);
  click("Start dictation");
  await settle();
  frame();
  click("Stop");
  finish("First.");
  await settle();
  const first = owner.snapshot().latestSuccessful?.id;
  expect(owner.snapshot().lastTranscript).toBe(first);
  outcome = "uncertain";
  click("Start dictation");
  await settle();
  frame();
  click("Stop");
  finish("Second.");
  await settle();
  const [second] = owner.snapshot().recovery;
  expect(owner.snapshot()).toMatchObject({ notice: "uncertain", lastTranscript: second?.id });
  click("Copy last transcript");
  await settle();
  expect(owner.snapshot().recovery).toEqual([]);
  expect(owner.snapshot().recoveryMessage).toBe("Copied.");
  click("Paste last transcript");
  await settle();
  expect(targets.at(-1)).toBe(`arm:${second?.id}`);
  expect(owner.snapshot().armedPaste).toBe(second?.id);
  expect(item("Start dictation")).toMatchObject({
    enabled: false,
    sublabel: "A paste is waiting for you to choose a field.",
  });
  expect(item("Paste last transcript").enabled).toBe(false);
  expect(item("Cancel paste").enabled).toBe(true);
  click("Cancel paste");
  expect(owner.snapshot().armedPaste).toBeNull();
  owner.close();
});

it("full recovery and incomplete setup block Start from every entry point with the specific cause", async () => {
  let available = false;
  const { owner, send, click, item, starts, identity, frame } = fixture({
    available: () => available,
  });
  expect(owner.snapshot().blocker).toBe("setup");
  expect(item("Start dictation")).toMatchObject({
    enabled: false,
    sublabel: "Complete or repair dictation setup first.",
  });
  owner.shortcut("hold.down");
  expect(owner.snapshot()).toMatchObject({ phase: "failed", notice: "setup" });
  owner.shortcut("hold.up");
  available = true;
  // Setup repair never starts capture on its own.
  expect(starts()).toHaveLength(0);
  for (let index = 0; index < 5; index++) {
    await send("window", { type: "session.start", origin: "dictation" });
    await settle();
    frame();
    owner.captureEvent({ type: "capture.failed", ...identity() });
  }
  expect(owner.snapshot()).toMatchObject({ blocker: "recovery-full", notice: "incomplete" });
  expect(item("Start dictation")).toMatchObject({
    enabled: false,
    sublabel: "Recovery is full. Resolve or discard a session first.",
  });
  expect(await send("bar", { type: "session.start", origin: "dictation" })).toMatchObject({
    ok: true,
    session: { phase: "failed", notice: "recovery-full" },
  });
  owner.shortcut("toggle");
  expect(() => click("Start dictation")).toThrow("disabled");
  expect(starts()).toHaveLength(5);
  const [entry] = owner.snapshot().recovery;
  await send("window", { type: "recovery.discard", id: entry?.id });
  expect(owner.snapshot().blocker).toBeNull();
  expect(starts()).toHaveLength(5);
  owner.close();
});

it("notices distinguish connection warnings, the time limit, no speech, and incomplete capture", async () => {
  vi.useFakeTimers();
  const { owner, send, identity, frame, finish } = fixture();
  await send("bar", { type: "session.start", origin: "dictation" });
  await vi.advanceTimersByTimeAsync(0);
  frame();
  owner.providerEvent({ type: "failed", ...identity(), reason: "connection" });
  expect(owner.snapshot()).toMatchObject({
    phase: "recording",
    notice: "connection",
    message: expect.stringContaining("transcription needs internet"),
  });
  await send("bar", { type: "session.stop" });
  owner.captureEvent({ type: "capture.stopped", ...identity(), frames: 1, samples: 320 });
  expect(owner.snapshot()).toMatchObject({
    phase: "failed",
    notice: "connection",
    recovery: [expect.objectContaining({ hasAudio: true })],
  });
  await send("window", { type: "session.start", origin: "dictation" });
  await vi.advanceTimersByTimeAsync(0);
  frame();
  await vi.advanceTimersByTimeAsync(270_000);
  expect(owner.snapshot()).toMatchObject({ phase: "recording", notice: "limit" });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(owner.snapshot()).toMatchObject({
    phase: "processing",
    notice: "limit",
    message: expect.stringContaining("five-minute limit"),
  });
  finish("");
  expect(owner.snapshot()).toMatchObject({
    phase: "complete",
    notice: "no-speech",
    message: "No speech detected",
  });
  owner.close();
});

it("a session stopped by the five-minute cap says so after insertion", async () => {
  vi.useFakeTimers();
  const { owner, click, frame, finish } = fixture();
  click("Start dictation");
  await vi.advanceTimersByTimeAsync(0);
  frame();
  await vi.advanceTimersByTimeAsync(300_000);
  finish("Long thought.");
  await vi.advanceTimersByTimeAsync(0);
  expect(owner.snapshot()).toMatchObject({
    phase: "complete",
    notice: "limit",
    message: "Inserted. Recording stopped at the five-minute limit.",
  });
  owner.close();
});

it("menu Copy and Paste outcomes become the latest update the floating bar shows", async () => {
  const { owner, click, frame, finish } = fixture({ target: "none" });
  click("Start dictation");
  await settle();
  frame();
  click("Stop");
  finish("Retained.");
  await settle();
  expect(owner.snapshot()).toMatchObject({ lastUpdate: "session", notice: "not-inserted" });
  click("Copy last transcript");
  await settle();
  expect(owner.snapshot()).toMatchObject({ lastUpdate: "recovery", recoveryMessage: "Copied." });
  click("Start dictation");
  expect(owner.snapshot().lastUpdate).toBe("session");
  owner.close();
});
