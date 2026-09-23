import { afterEach, expect, it, vi } from "vite-plus/test";
import { createSession } from "./session";
import { createCommands } from "./commands";
import { createSetup } from "./setup";
import { statusLabel } from "./menu-bar";
import {
  isCapturing,
  type CaptureCommand,
  type InsertionOutcome,
  type ProviderEvent,
  type ProviderRequest,
} from "@voice/contracts/session";
import { defaultSetupPreferences, type NativeSetupStatus } from "@voice/contracts/setup";

// Safety stops: key changes, access failures, lost devices, and subordinate crashes. The real
// session owner, command router, and setup state run against recorded capture and provider
// commands; fake clocks drive every deadline.
afterEach(() => vi.useRealTimers());
const native: NativeSetupStatus = {
  permissions: { microphone: "granted", accessibility: "granted", inputMonitoring: "granted" },
  devices: [{ id: "synthetic-input", name: "Synthetic microphone" }],
  defaultDevice: "synthetic-input",
  shortcuts: { hold: "available", toggle: "available", cancel: "available" },
};
type Start = Extract<ProviderRequest, { type: "start" }>;
async function fixture(
  overrides: {
    credential?: () => Promise<string>;
    insert?: (text: string) => Promise<InsertionOutcome>;
  } = {},
) {
  const capture: CaptureCommand[] = [];
  const provider: ProviderRequest[] = [];
  const inserted: string[] = [];
  const access: string[] = [];
  const network = { online: true };
  // Native services: `ready` stands in for the helper process, `key` for the Keychain item.
  const helper = { ready: true, key: true };
  const setup = createSetup({
    native: async (command) => {
      if (!helper.ready) throw new Error("native-unavailable");
      if (command.type === "credential.set") helper.key = true;
      if (command.type === "credential.remove") helper.key = false;
      return command.type.startsWith("credential.")
        ? { type: "credential", presence: helper.key ? "saved" : "missing" }
        : { type: "setup", status: native };
    },
    preferences: () => defaultSetupPreferences,
    save: async () => {},
    connectivity: () => "online",
    credentialChanged: () => {},
  });
  await setup.refresh();
  const owner = createSession({
    available: () => helper.ready && setup.snapshot().blockers.length === 0,
    transcribable: () => helper.ready && setup.snapshot().credential.presence === "saved",
    online: () => network.online,
    device: () => null,
    credential: overrides.credential ?? (async () => "synthetic"),
    capture: (command) => {
      if (!helper.ready) throw new Error("native-unavailable");
      capture.push(command);
    },
    provider: (command) => provider.push(command),
    changed: () => {},
    copy: async () => true,
    access: (reason) => {
      access.push(reason);
      if (reason === "rejected") setup.updateAccess("rejected", "unknown");
      if (reason === "quota") setup.updateAccess("unverified", "quota-exhausted");
    },
    target: {
      capture: async () => "eligible",
      arm: async () => {},
      insert: async (_id, text) => {
        inserted.push(text);
        return { outcome: overrides.insert ? await overrides.insert(text) : "inserted" };
      },
      release: () => {},
    },
    engaged: () => {},
  });
  // Settings changes arrive through the same command router the renderer uses.
  const commands = createCommands({
    session: () => owner,
    setup: () => setup,
    isAuthorized: () => true,
    initialSettings: { appearance: "light" },
    storage: { set: async (value) => value, restart: async () => ({ appearance: "light" }) },
    status: () => ({
      storage: "ready",
      helper: helper.ready ? "ready" : "failed",
      capture: "available",
      shortcuts: "listening",
    }),
  });
  const execute = (payload: unknown) => commands.execute("window", payload);
  const captureStarts = () => capture.filter((command) => command.type === "capture.start");
  const captureStart = () => {
    const start = captureStarts().at(-1);
    if (!start) throw new Error("No capture started");
    return { session: start.session, attempt: start.attempt };
  };
  const starts = () => provider.filter((command): command is Start => command.type === "start");
  const stream = () => {
    const start = starts().at(-1);
    if (!start) throw new Error("No provider attempt started");
    return { session: start.session, attempt: start.attempt };
  };
  const frame = (sequence: number) =>
    owner.captureEvent({
      type: "capture.frame",
      ...captureStart(),
      sequence,
      pcm: Buffer.alloc(640, sequence + 1).toString("base64"),
    });
  async function record(from: number, to: number) {
    for (let sequence = from; sequence < to; sequence++) frame(sequence);
    await vi.advanceTimersByTimeAsync(0);
  }
  const stopped = (frames: number) =>
    owner.captureEvent({
      type: "capture.stopped",
      ...captureStart(),
      frames,
      samples: frames * 320,
    });
  const sent = (attempt: string) =>
    provider.flatMap((command) =>
      command.type === "audio" && command.attempt === attempt ? [command.sequence] : [],
    );
  const event = (input: ProviderEvent) => owner.providerEvent(input);
  async function begin(origin: "practice" | "dictation" = "practice") {
    await execute({ type: "session.start", origin });
    await vi.advanceTimersByTimeAsync(0);
  }
  // A recording that ended incomplete, retained with its audio and text for an explicit Retry.
  async function retained(text: string, frames = 2) {
    await begin();
    await record(0, frames);
    if (text) event({ type: "stable", ...stream(), text });
    owner.captureEvent({ type: "capture.failed", ...captureStart() });
    return captureStart().session;
  }
  return {
    owner,
    setup,
    helper,
    network,
    capture,
    provider,
    inserted,
    access,
    execute,
    captureStarts,
    captureStart,
    starts,
    stream,
    frame,
    record,
    stopped,
    sent,
    event,
    begin,
    retained,
  };
}
const last = <T>(items: T[]) => items.at(-1);

it("a key replaced mid-capture stops capture and the stream at once, keeps drained audio, and resends only on explicit Retry", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  await f.begin();
  await f.record(0, 2);
  const live = f.stream();
  f.event({ type: "stable", ...live, text: "Keep this thought." });
  await f.execute({ type: "credential.set", key: "synthetic-replacement" });
  // Capture is asked to stop, not cancel, so the helper's final drained frames are kept.
  expect(last(f.capture)).toEqual({ type: "capture.stop", ...f.captureStart() });
  expect(f.provider).toContainEqual({ type: "cancel", ...live });
  expect(f.owner.snapshot()).toMatchObject({
    phase: "processing",
    message: expect.stringContaining("Deepgram key changed"),
  });
  f.frame(2);
  f.stopped(3);
  expect(f.sent(live.attempt)).toEqual([0, 1]);
  expect(f.owner.snapshot()).toMatchObject({
    phase: "failed",
    notice: "incomplete",
    practiceText: "",
    recovery: [
      expect.objectContaining({
        text: "Keep this thought.",
        transcription: "incomplete",
        hasAudio: true,
        delivery: "undelivered",
      }),
    ],
  });
  // The old attempt is invalid: its late result changes nothing and nothing is resent.
  f.event({ type: "complete", ...live, text: "Old key result.", samples: 960 });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.owner.snapshot().recovery[0]?.text).toBe("Keep this thought.");
  expect(f.starts()).toHaveLength(1);
  const id = f.owner.snapshot().recovery[0]!.id;
  await f.execute({ type: "recovery.retry", id });
  await vi.advanceTimersByTimeAsync(0);
  const retry = f.stream();
  expect(f.sent(retry.attempt)).toEqual([0, 1, 2]);
  f.event({ type: "complete", ...retry, text: "Keep this thought, please.", samples: 960 });
  expect(f.owner.snapshot().recovery[0]).toMatchObject({
    text: "Keep this thought, please.",
    transcription: "complete",
  });
  expect(f.captureStarts()).toHaveLength(1);
  f.owner.close();
});

it("removing the key during finalization or a Retry ends provider work, keeps the source, and blocks Retry until a key returns", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  await f.begin("dictation");
  await f.record(0, 2);
  f.owner.execute({ type: "session.stop" });
  f.stopped(2);
  const live = f.stream();
  expect(last(f.provider)).toMatchObject({ type: "stop", ...live });
  await f.execute({ type: "credential.remove" });
  expect(f.provider).toContainEqual({ type: "cancel", ...live });
  expect(f.owner.snapshot()).toMatchObject({
    phase: "failed",
    retryBlocker: "setup",
    recovery: [expect.objectContaining({ hasAudio: true, transcription: "incomplete" })],
  });
  f.event({ type: "complete", ...live, text: "Too late.", samples: 640 });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.inserted).toEqual([]);
  const id = f.owner.snapshot().recovery[0]!.id;
  // Without a key Retry sends nothing and says why.
  await f.execute({ type: "recovery.retry", id });
  expect(f.starts()).toHaveLength(1);
  expect(f.owner.snapshot().recoveryMessage).toContain("saved Deepgram key");

  await f.execute({ type: "credential.set", key: "synthetic-replacement" });
  expect(f.owner.snapshot().retryBlocker).toBeNull();
  await f.execute({ type: "recovery.retry", id });
  await vi.advanceTimersByTimeAsync(0);
  const retry = f.stream();
  f.event({ type: "stable", ...retry, text: "Replay beginning" });
  await f.execute({ type: "credential.remove" });
  expect(f.provider).toContainEqual({ type: "cancel", ...retry });
  expect(f.owner.snapshot()).toMatchObject({
    phase: "failed",
    retrying: null,
    recovery: [expect.objectContaining({ id, hasAudio: true, transcription: "incomplete" })],
  });
  f.event({ type: "complete", ...retry, text: "Late replay.", samples: 640 });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.owner.snapshot().recovery[0]?.transcription).toBe("incomplete");
  expect(f.starts()).toHaveLength(2);
  expect(f.captureStarts()).toHaveLength(1);
  f.owner.close();
});

it("a key change while the automatic replay waits for backoff cancels that replay", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  await f.begin();
  await f.record(0, 1);
  f.owner.execute({ type: "session.stop" });
  f.stopped(1);
  f.event({ type: "failed", ...f.stream(), reason: "rate-limit", retryAfter: 2_000 });
  expect(f.owner.snapshot()).toMatchObject({ phase: "processing", notice: "rate-limit" });
  await f.execute({ type: "credential.set", key: "synthetic-replacement" });
  expect(f.owner.snapshot()).toMatchObject({
    phase: "failed",
    recovery: [expect.objectContaining({ hasAudio: true })],
  });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.starts()).toHaveLength(1);
  f.owner.close();
});

it.each(["rejected", "quota"] as const)(
  "%s access found after Start stops capture, finalization, or Retry and waits for explicit repair",
  async (reason) => {
    vi.useFakeTimers();
    const f = await fixture();
    // During capture: the microphone stops at once, and later frames reach no provider.
    await f.begin();
    await f.record(0, 2);
    const live = f.stream();
    f.event({ type: "stable", ...live, text: "Account text." });
    f.event({ type: "failed", ...live, reason });
    expect(f.access).toEqual([reason]);
    expect(last(f.capture)).toEqual({ type: "capture.stop", ...f.captureStart() });
    expect(isCapturing(f.owner.snapshot())).toBe(false);
    f.frame(2);
    f.stopped(3);
    expect(f.sent(live.attempt)).toEqual([0, 1]);
    expect(f.owner.snapshot()).toMatchObject({
      phase: "failed",
      notice: "setup",
      recovery: [expect.objectContaining({ text: "Account text.", hasAudio: true })],
    });
    expect(f.setup.snapshot().blockers).toEqual([
      reason === "rejected" ? "key-rejected" : "quota-exhausted",
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.starts()).toHaveLength(1);
    const first = f.owner.snapshot().recovery[0]!.id;
    await f.execute({ type: "recovery.discard", id: first });
    // Repair is explicit: a new key, or an explicit refresh after billing is fixed.
    if (reason === "rejected")
      await f.execute({ type: "credential.set", key: "synthetic-replacement" });
    else await f.execute({ type: "setup.refresh" });
    expect(f.setup.snapshot().blockers).toEqual([]);

    // During finalization: the session ends at once with its recording kept.
    await f.begin();
    await f.record(0, 1);
    f.owner.execute({ type: "session.stop" });
    f.stopped(1);
    f.event({ type: "failed", ...f.stream(), reason });
    expect(f.owner.snapshot()).toMatchObject({
      phase: "failed",
      recovery: [expect.objectContaining({ hasAudio: true })],
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.starts()).toHaveLength(2);

    // During Retry: no automatic retry follows an account failure, and the source stays.
    const id = f.owner.snapshot().recovery[0]!.id;
    await f.execute({ type: "recovery.retry", id });
    await vi.advanceTimersByTimeAsync(0);
    f.event({ type: "failed", ...f.stream(), reason });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.starts()).toHaveLength(3);
    expect(f.owner.snapshot()).toMatchObject({
      phase: "failed",
      retrying: null,
      recovery: [expect.objectContaining({ id, hasAudio: true })],
    });
    expect(f.captureStarts()).toHaveLength(2);
    f.owner.close();
  },
);

it("rate limits and connection loss keep capture running and never count as account failure", async () => {
  vi.useFakeTimers();
  for (const reason of ["rate-limit", "connection"] as const) {
    const f = await fixture();
    await f.begin();
    await f.record(0, 1);
    f.event({ type: "failed", ...f.stream(), reason });
    expect(f.owner.snapshot()).toMatchObject({ phase: "recording", notice: reason });
    expect(f.capture.map(({ type }) => type)).toEqual(["capture.start"]);
    expect(f.access.filter((kind) => kind === "rejected" || kind === "quota")).toEqual([]);
    expect(f.setup.snapshot().blockers).toEqual([]);
    f.owner.close();
  }
});

it.each([
  ["device", "setup", "microphone disconnected or changed"],
  ["permission", "setup", "Microphone access was revoked"],
  [undefined, "incomplete", "Microphone capture stopped"],
] as const)(
  "a %s capture failure while recording or draining stops listening and keeps audio and best text as incomplete",
  async (reason, notice, message) => {
    vi.useFakeTimers();
    const f = await fixture();
    for (const stage of ["recording", "draining"] as const) {
      await f.begin("dictation");
      await f.record(0, 2);
      const live = f.stream();
      f.event({ type: "partial", ...live, text: "Best words so far" });
      if (stage === "draining") f.owner.execute({ type: "session.stop" });
      f.owner.captureEvent({
        type: "capture.failed",
        ...f.captureStart(),
        ...(reason ? { reason } : {}),
      });
      const snapshot = f.owner.snapshot();
      expect(snapshot).toMatchObject({
        phase: "failed",
        notice,
        message: expect.stringContaining(message),
      });
      expect(isCapturing(snapshot)).toBe(false);
      expect(statusLabel(snapshot)).not.toContain("Recording");
      expect(snapshot.recovery.at(-1)).toMatchObject({
        text: "Best words so far",
        transcription: "incomplete",
        hasAudio: true,
        delivery: "undelivered",
      });
      expect(f.provider).toContainEqual({ type: "cancel", ...live });
      // A late provider success cannot turn the lost capture into a delivered result.
      f.event({ type: "complete", ...live, text: "Best words so far.", samples: 640 });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.inserted).toEqual([]);
    }
    expect(f.owner.snapshot().recovery).toHaveLength(2);
    expect(f.captureStarts()).toHaveLength(2);
    f.owner.close();
  },
);

it("a helper crash keeps recovery, and its replacement never starts capture or replays a held shortcut", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  f.owner.shortcut("hold.down");
  await vi.advanceTimersByTimeAsync(0);
  await f.record(0, 2);
  f.event({ type: "stable", ...f.stream(), text: "Held words." });
  // Main marks the helper failed; its capture ended with the process.
  f.helper.ready = false;
  f.owner.helperFailed();
  expect(f.owner.snapshot()).toMatchObject({
    phase: "failed",
    blocker: "setup",
    retryBlocker: "setup",
    message: expect.stringContaining("Native services stopped"),
    recovery: [expect.objectContaining({ text: "Held words.", hasAudio: true })],
  });
  expect(f.capture.map(({ type }) => type)).toEqual(["capture.start"]);
  // The key is still held while the helper is down, then released.
  f.owner.shortcut("hold.down");
  f.owner.shortcut("hold.up");
  // A replacement helper becomes ready: availability returns, and nothing starts by itself.
  f.helper.ready = true;
  f.owner.shortcut("hold.up");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.captureStarts()).toHaveLength(1);
  expect(f.owner.snapshot()).toMatchObject({ blocker: null, retryBlocker: null });
  // Only a fresh press starts the next session.
  f.owner.shortcut("hold.down");
  expect(f.captureStarts()).toHaveLength(2);
  await f.record(0, 1);
  f.owner.shortcut("hold.up");
  expect(last(f.capture)).toMatchObject({ type: "capture.stop" });
  f.owner.close();
});

it("work that no longer needs the helper survives its crash, dictation awaiting insertion is kept, and an in-flight paste becomes uncertain", async () => {
  vi.useFakeTimers();
  const pending = Promise.withResolvers<InsertionOutcome>();
  const f = await fixture({ insert: () => pending.promise });
  // A Retry streams from retained audio with the microphone off; it finishes into recovery.
  const id = await f.retained("Keep me.", 2);
  await f.execute({ type: "recovery.retry", id });
  await vi.advanceTimersByTimeAsync(0);
  f.helper.ready = false;
  f.owner.helperFailed();
  expect(f.owner.snapshot()).toMatchObject({ phase: "processing", retrying: id });
  f.event({ type: "complete", ...f.stream(), text: "Keep me, complete.", samples: 640 });
  expect(f.owner.snapshot()).toMatchObject({
    phase: "complete",
    recovery: [expect.objectContaining({ id, text: "Keep me, complete.", hasAudio: false })],
  });
  f.helper.ready = true;
  // Dictation still finalizing loses its target with the helper, so it goes to recovery.
  await f.begin("dictation");
  await f.record(0, 1);
  f.owner.execute({ type: "session.stop" });
  f.stopped(1);
  f.helper.ready = false;
  f.owner.helperFailed();
  expect(f.owner.snapshot()).toMatchObject({
    phase: "failed",
    recovery: [expect.anything(), expect.objectContaining({ hasAudio: true })],
  });
  f.event({ type: "complete", ...f.stream(), text: "Too late.", samples: 320 });
  expect(f.inserted).toEqual([]);
  f.helper.ready = true;
  await f.execute({ type: "recovery.discard", id: f.owner.snapshot().recovery[1]!.id });
  await f.execute({ type: "recovery.paste", id });
  f.owner.targetSelected({ type: "target.selected", session: id, status: "eligible" });
  expect(f.inserted).toEqual(["Keep me, complete."]);
  // Cancel cannot take back a paste already dispatched.
  await f.execute({ type: "session.cancel" });
  expect(f.owner.snapshot().armedPaste).toBe(id);
  f.helper.ready = false;
  f.owner.helperFailed();
  pending.reject(new Error("native-unavailable"));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.owner.snapshot()).toMatchObject({
    armedPaste: null,
    recoveryMessage: expect.stringContaining("Check your target"),
    recovery: [expect.objectContaining({ id, delivery: "uncertain" })],
  });
  f.owner.close();
});

it("a provider worker crash keeps capture running and is replaced only for the one replay, within the Stop deadline", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  await f.begin();
  await f.record(0, 2);
  const live = f.stream();
  f.event({ type: "stable", ...live, text: "Before the crash." });
  f.event({ type: "failed", ...live, reason: "worker" });
  const recording = f.owner.snapshot();
  expect(recording).toMatchObject({ phase: "recording", notice: "worker" });
  expect(statusLabel(recording)).toBe("Recording · transcription interrupted");
  // Capture callbacks never start a replacement worker.
  const commands = f.provider.length;
  await f.record(2, 4);
  expect(f.provider).toHaveLength(commands);
  f.owner.execute({ type: "session.stop" });
  f.stopped(4);
  await vi.advanceTimersByTimeAsync(0);
  const replay = f.stream();
  expect(replay.attempt).not.toBe(live.attempt);
  expect(f.sent(replay.attempt)).toEqual([0, 1, 2, 3]);
  // The replacement crashes too: there is no third attempt.
  f.event({ type: "failed", ...replay, reason: "worker" });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.starts()).toHaveLength(2);
  expect(f.owner.snapshot()).toMatchObject({
    phase: "failed",
    recovery: [expect.objectContaining({ text: "Before the crash.", hasAudio: true })],
  });

  // A crash after Stop gets its replay, but the deadline still counts from Stop.
  const g = await fixture();
  await g.begin();
  await g.record(0, 1);
  g.owner.execute({ type: "session.stop" });
  g.stopped(1);
  await vi.advanceTimersByTimeAsync(3_000);
  g.event({ type: "failed", ...g.stream(), reason: "worker" });
  await vi.advanceTimersByTimeAsync(0);
  expect(g.starts()).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(6_999);
  expect(g.owner.snapshot().phase).toBe("processing");
  await vi.advanceTimersByTimeAsync(1);
  expect(g.owner.snapshot()).toMatchObject({ phase: "failed" });
  g.event({ type: "complete", ...g.stream(), text: "Too late.", samples: 320 });
  expect(g.owner.snapshot().practiceText).toBe("");
  f.owner.close();
  g.owner.close();
});

it("a worker crash during Retry uses that Retry's single automatic retry and never starts capture", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const id = await f.retained("Retry source.", 3);
  await f.execute({ type: "recovery.retry", id });
  await vi.advanceTimersByTimeAsync(0);
  f.event({ type: "failed", ...f.stream(), reason: "worker" });
  await vi.advanceTimersByTimeAsync(0);
  const second = f.stream();
  expect(f.sent(second.attempt)).toEqual([0, 1, 2]);
  f.event({ type: "failed", ...second, reason: "worker" });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.starts()).toHaveLength(3);
  expect(f.owner.snapshot()).toMatchObject({
    phase: "failed",
    message: expect.stringContaining("transcription worker stopped"),
    recovery: [expect.objectContaining({ id, text: "Retry source.", hasAudio: true })],
  });
  expect(f.captureStarts()).toHaveLength(1);
  f.owner.close();
});

it("capture Cancel releases unfinished audio and Retry cancel keeps its source, whichever event wins", async () => {
  vi.useFakeTimers();
  // Cancel before the key read finishes: the stream never opens.
  const key = Promise.withResolvers<string>();
  const f = await fixture({ credential: () => key.promise });
  await f.begin();
  await f.execute({ type: "session.cancel" });
  key.resolve("synthetic");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.starts()).toHaveLength(0);
  expect(f.owner.snapshot()).toMatchObject({ phase: "cancelled", recovery: [] });
  f.owner.close();

  // Cancel after Stop, racing the provider's completion: produced text stays, audio is released.
  const g = await fixture();
  await g.begin("dictation");
  await g.record(0, 2);
  g.event({ type: "stable", ...g.stream(), text: "Produced text." });
  g.owner.execute({ type: "session.stop" });
  g.stopped(2);
  await g.execute({ type: "session.cancel" });
  g.event({ type: "complete", ...g.stream(), text: "Produced text.", samples: 640 });
  await vi.advanceTimersByTimeAsync(0);
  expect(g.inserted).toEqual([]);
  expect(g.owner.snapshot()).toMatchObject({
    phase: "cancelled",
    recovery: [expect.objectContaining({ text: "Produced text.", hasAudio: false })],
  });

  // A key change stopped capture first: a Cancel during the drain neither releases nor truncates
  // the recording, and a device loss while draining keeps the key change as the cause.
  await g.execute({ type: "recovery.discard", id: g.owner.snapshot().recovery[0]!.id });
  await g.begin();
  await g.record(0, 2);
  await g.execute({ type: "credential.set", key: "synthetic-replacement" });
  await g.execute({ type: "session.cancel" });
  expect(last(g.capture)).toEqual({ type: "capture.stop", ...g.captureStart() });
  g.frame(2);
  g.stopped(3);
  expect(g.owner.snapshot()).toMatchObject({
    phase: "failed",
    message: expect.stringContaining("Deepgram key changed"),
    recovery: [expect.objectContaining({ hasAudio: true })],
  });
  const id = g.owner.snapshot().recovery[0]!.id;
  await g.begin();
  await g.record(0, 1);
  await g.execute({ type: "credential.remove" });
  g.owner.captureEvent({ type: "capture.failed", ...g.captureStart(), reason: "device" });
  expect(g.owner.snapshot()).toMatchObject({
    phase: "failed",
    notice: "incomplete",
    message: expect.stringContaining("Deepgram key changed"),
  });
  await g.execute({ type: "recovery.discard", id: g.owner.snapshot().recovery[1]!.id });
  await g.execute({ type: "credential.set", key: "synthetic-replacement" });

  // Retry cancelled while it waits for a connection keeps the source; reconnecting sends nothing.
  g.network.online = false;
  await g.execute({ type: "recovery.retry", id });
  expect(g.owner.snapshot().message).toContain("Waiting for a connection");
  await g.execute({ type: "session.cancel" });
  g.network.online = true;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(g.starts()).toHaveLength(3);
  expect(g.owner.snapshot()).toMatchObject({
    phase: "cancelled",
    recovery: [expect.objectContaining({ id, hasAudio: true })],
  });
  // Retry cancelled as its replay completes keeps the source too.
  await g.execute({ type: "recovery.retry", id });
  await vi.advanceTimersByTimeAsync(0);
  const replay = g.stream();
  await g.execute({ type: "session.cancel" });
  g.event({ type: "complete", ...replay, text: "Late.", samples: 640 });
  expect(g.owner.snapshot().recovery).toEqual([
    expect.objectContaining({ id, hasAudio: true, transcription: "incomplete" }),
  ]);
  expect(g.captureStarts()).toHaveLength(3);
  g.owner.close();
});

it("a pending settings write never delays capture, and quit still warns after subordinate failures", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const locked = Promise.withResolvers<{ appearance: "light" | "dark" }>();
  const commands = createCommands({
    session: () => f.owner,
    isAuthorized: () => true,
    initialSettings: { appearance: "light" },
    storage: { set: () => locked.promise, restart: () => locked.promise },
    status: () => ({
      storage: "ready",
      helper: "ready",
      capture: "available",
      shortcuts: "listening",
    }),
  });
  // The storage worker is held by a database lock while the user starts a session.
  const write = commands.execute("window", { type: "settings.set", appearance: "dark" });
  await commands.execute("window", { type: "session.start", origin: "practice" });
  expect(f.captureStarts()).toHaveLength(1);
  await f.record(0, 2);
  expect(f.owner.snapshot().phase).toBe("recording");
  f.event({ type: "failed", ...f.stream(), reason: "worker" });
  f.helper.ready = false;
  f.owner.helperFailed();
  expect(f.owner.requestQuit()).toBe(true);
  expect(f.owner.snapshot()).toMatchObject({
    quitWarning: true,
    recovery: [expect.objectContaining({ hasAudio: true })],
  });
  expect(f.captureStarts()).toHaveLength(1);
  locked.resolve({ appearance: "dark" });
  await write;
  f.owner.close();
});
