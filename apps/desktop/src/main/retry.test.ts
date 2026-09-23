import { afterEach, expect, it, vi } from "vite-plus/test";
import { WebSocketServer, type WebSocket } from "ws";
import { once } from "node:events";
import { createSession } from "./session";
import { statusLabel } from "./menu-bar";
import { startStream } from "@voice/providers/stream";
import { modelUuid, modelVersion } from "@voice/providers/asr";
import type {
  CaptureCommand,
  InsertionOutcome,
  ProviderEvent,
  ProviderRequest,
} from "@voice/contracts/session";

// Offline capture, the one automatic replay, and explicit Retry. Fake clocks drive every deadline;
// the adapter tests at the end run the real stream against a loopback WebSocket fixture.
afterEach(() => vi.useRealTimers());
const result = (start: number, duration: number, transcript: string) => ({
  type: "Results",
  channel_index: [0, 1],
  start,
  duration,
  is_final: true,
  metadata: { model_uuid: modelUuid, model_info: { version: modelVersion } },
  channel: { alternatives: [{ transcript }] },
});
type Start = Extract<ProviderRequest, { type: "start" }>;
function fixture(overrides: { insert?: () => Promise<InsertionOutcome> } = {}) {
  const capture: CaptureCommand[] = [];
  const provider: ProviderRequest[] = [];
  const inserted: string[] = [];
  const network = { online: true };
  const owner = createSession({
    available: () => true,
    transcribable: () => true,
    online: () => network.online,
    device: () => null,
    credential: async () => "synthetic",
    capture: (command) => capture.push(command),
    provider: (command) => provider.push(command),
    changed: () => {},
    copy: async () => true,
    access: () => {},
    target: {
      capture: async () => "eligible",
      arm: async () => {},
      insert: async (_id, text) => {
        inserted.push(text);
        return { outcome: overrides.insert ? await overrides.insert() : "inserted" };
      },
      release: () => {},
    },
    engaged: () => {},
  });
  const captureStart = () => {
    const start = capture.findLast((command) => command.type === "capture.start");
    if (!start) throw new Error("No capture started");
    return { session: start.session, attempt: start.attempt };
  };
  const starts = () => provider.filter((command): command is Start => command.type === "start");
  const stream = () => {
    const start = starts().at(-1);
    if (!start) throw new Error("No provider attempt started");
    return { session: start.session, attempt: start.attempt };
  };
  // Frames carry their sequence number so replay ordering is visible in the audio itself.
  const frame = (sequence: number, bytes = 640) =>
    owner.captureEvent({
      type: "capture.frame",
      ...captureStart(),
      sequence,
      pcm: Buffer.alloc(bytes, sequence % 256).toString("base64"),
    });
  async function record(frames: number, bytes = 640) {
    for (let sequence = 0; sequence < frames; sequence++) frame(sequence, bytes);
    await vi.advanceTimersByTimeAsync(0);
  }
  const stop = (frames: number, bytes = 640) => {
    owner.execute({ type: "session.stop" });
    owner.captureEvent({
      type: "capture.stopped",
      ...captureStart(),
      frames,
      samples: (frames * bytes) / 2,
    });
  };
  const sent = (attempt: string) =>
    provider.flatMap((command) =>
      command.type === "audio" && command.attempt === attempt
        ? [[command.sequence, command.pcm[0]]]
        : [],
    );
  const event = (input: ProviderEvent) => owner.providerEvent(input);
  // Starts a practice session and keeps it recording until the caller stops it.
  async function begin(origin: "practice" | "dictation" = "practice") {
    owner.execute({ type: "session.start", origin });
    await vi.advanceTimersByTimeAsync(0);
  }
  // A failed capture whose recording and text stay in recovery for an explicit Retry.
  async function retained(text: string, frames = 1, bytes = 640) {
    await begin();
    await record(frames, bytes);
    if (text) event({ type: "stable", ...stream(), text });
    owner.captureEvent({ type: "capture.failed", ...captureStart() });
    return captureStart().session;
  }
  return {
    owner,
    capture,
    provider,
    inserted,
    network,
    captureStart,
    starts,
    stream,
    frame,
    record,
    stop,
    sent,
    event,
    begin,
    retained,
  };
}

it("starts capture offline with a shared warning, then replays the whole source once online", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.network.online = false;
  await f.begin();
  await f.record(3);
  expect(f.owner.snapshot()).toMatchObject({
    phase: "recording",
    notice: "connection",
    message: expect.stringContaining("Offline. Recording continues"),
  });
  expect(statusLabel(f.owner.snapshot())).toBe("Recording · offline");
  expect(f.starts()).toHaveLength(0);
  f.stop(3);
  expect(f.owner.snapshot()).toMatchObject({
    phase: "processing",
    notice: "connection",
    message: expect.stringContaining("Waiting for a connection"),
  });
  expect(statusLabel(f.owner.snapshot())).toBe("Transcribing · waiting for connection");
  await vi.advanceTimersByTimeAsync(4_000);
  expect(f.starts()).toHaveLength(0);
  f.network.online = true;
  await vi.advanceTimersByTimeAsync(500);
  const replay = f.stream();
  expect(replay.attempt).not.toBe(f.captureStart().attempt);
  expect(f.sent(replay.attempt)).toEqual([
    [0, 0],
    [1, 1],
    [2, 2],
  ]);
  expect(f.provider.at(-1)).toMatchObject({ type: "stop", frames: 3, samples: 960 });
  f.event({ type: "complete", ...replay, text: "Hello, Priya.", samples: 960 });
  expect(f.owner.snapshot()).toMatchObject({ phase: "complete", practiceText: "Hello, Priya." });
  expect(f.capture.filter((command) => command.type === "capture.start")).toHaveLength(1);
  f.owner.close();
});

it("keeps an offline capture recoverable at the deadline, and a later reconnect sends nothing", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.network.online = false;
  await f.begin();
  await f.record(1);
  f.stop(1);
  await vi.advanceTimersByTimeAsync(9_999);
  expect(f.owner.snapshot().phase).toBe("processing");
  await vi.advanceTimersByTimeAsync(1);
  expect(f.owner.snapshot()).toMatchObject({
    phase: "failed",
    notice: "connection",
    message: expect.stringContaining("No connection before the processing deadline"),
    recovery: [expect.objectContaining({ hasAudio: true, transcription: "incomplete" })],
  });
  f.network.online = true;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.starts()).toHaveLength(0);
  expect(f.capture.filter((command) => command.type === "capture.start")).toHaveLength(1);
  f.owner.close();
});

it("continues capture through midstream loss and replays every frame on a fresh stream after Stop", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.begin();
  await f.record(2);
  const live = f.stream();
  expect(live.attempt).toBe(f.captureStart().attempt);
  f.event({ type: "stable", ...live, text: "Old best text." });
  f.event({ type: "failed", ...live, reason: "connection" });
  expect(f.owner.snapshot()).toMatchObject({
    phase: "recording",
    notice: "connection",
    message: expect.stringContaining("Connection lost. Recording continues"),
  });
  // Capture keeps running; frames after the loss are retained but not sent to the dead stream.
  f.frame(2);
  f.frame(3);
  expect(f.sent(live.attempt)).toEqual([
    [0, 0],
    [1, 1],
  ]);
  expect(f.owner.snapshot().phase).toBe("recording");
  f.stop(4);
  await vi.advanceTimersByTimeAsync(0);
  const replay = f.stream();
  expect(replay.attempt).not.toBe(live.attempt);
  expect(f.sent(replay.attempt)).toEqual([
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 3],
  ]);
  // The superseded live attempt can no longer deliver or change the best text.
  f.event({ type: "complete", ...live, text: "Stale.", samples: 1280 });
  f.event({ type: "stable", ...live, text: "Stale partial." });
  // A replay partial never replaces the old best text on its own.
  f.event({ type: "stable", ...replay, text: "Replay beginning" });
  f.event({ type: "failed", ...replay, reason: "connection" });
  expect(f.owner.snapshot()).toMatchObject({
    phase: "failed",
    notice: "connection",
    practiceText: "",
    recovery: [
      expect.objectContaining({
        text: "Old best text.",
        hasAudio: true,
        transcription: "incomplete",
      }),
    ],
  });
  expect(f.starts()).toHaveLength(2);
  f.owner.close();
});

it("delivers a complete replay once to the original dictation target, superseding old text", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.begin("dictation");
  await f.record(2);
  const live = f.stream();
  f.event({ type: "stable", ...live, text: "Partial" });
  f.event({ type: "failed", ...live, reason: "connection" });
  f.stop(2);
  await vi.advanceTimersByTimeAsync(0);
  f.event({ type: "complete", ...f.stream(), text: "Complete replay.", samples: 640 });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.inserted).toEqual(["Complete replay."]);
  expect(f.owner.snapshot()).toMatchObject({ phase: "complete", recovery: [] });
  f.owner.close();
});

it("counts a failed connection as the original attempt and never retries twice", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.begin();
  await f.record(1);
  f.event({ type: "failed", ...f.stream(), reason: "connection" });
  f.stop(1);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.starts()).toHaveLength(2);
  f.event({ type: "failed", ...f.stream(), reason: "connection" });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.starts()).toHaveLength(2);
  expect(f.owner.snapshot()).toMatchObject({
    phase: "failed",
    recovery: [expect.objectContaining({ hasAudio: true })],
  });
  f.owner.close();
});

it("honors rate-limit backoff only when it fits the remaining deadline", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.begin();
  await f.record(1);
  f.stop(1);
  await vi.advanceTimersByTimeAsync(3_000);
  f.event({ type: "failed", ...f.stream(), reason: "rate-limit", retryAfter: 2_000 });
  expect(f.owner.snapshot()).toMatchObject({ phase: "processing", notice: "rate-limit" });
  await vi.advanceTimersByTimeAsync(1_999);
  expect(f.starts()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.starts()).toHaveLength(2);
  // The replay still ends at the original deadline, 10 seconds after Stop.
  await vi.advanceTimersByTimeAsync(4_999);
  expect(f.owner.snapshot().phase).toBe("processing");
  await vi.advanceTimersByTimeAsync(1);
  expect(f.owner.snapshot()).toMatchObject({
    phase: "failed",
    message: expect.stringContaining("1.25× real time"),
  });

  const g = fixture();
  await g.begin();
  await g.record(1);
  g.stop(1);
  g.event({ type: "failed", ...g.stream(), reason: "rate-limit", retryAfter: 10_000 });
  expect(g.owner.snapshot()).toMatchObject({
    phase: "failed",
    notice: "rate-limit",
    message: expect.stringContaining("wait past the processing deadline"),
    recovery: [expect.objectContaining({ hasAudio: true })],
  });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(g.starts()).toHaveLength(1);
  f.owner.close();
  g.owner.close();
});

it("keeps capture running through a rate limit but never retries exhausted quota", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.begin();
  await f.record(1);
  f.event({ type: "failed", ...f.stream(), reason: "rate-limit" });
  expect(f.owner.snapshot()).toMatchObject({ phase: "recording", notice: "rate-limit" });

  const g = fixture();
  await g.begin();
  await g.record(1);
  g.event({ type: "failed", ...g.stream(), reason: "quota" });
  expect(g.owner.snapshot().phase).toBe("processing");
  g.owner.captureEvent({ type: "capture.stopped", ...g.captureStart(), frames: 1, samples: 320 });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(g.owner.snapshot()).toMatchObject({ phase: "failed", notice: "setup" });
  expect(g.starts()).toHaveLength(1);
  f.owner.close();
  g.owner.close();
});

it("Retry replays the retained source without the microphone and keeps the result in recovery", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const id = await f.retained("Available text.", 3);
  const captures = f.capture.length;
  await f.owner.execute({ type: "recovery.copy", id });
  await f.owner.execute({ type: "recovery.retry", id });
  expect(f.owner.snapshot()).toMatchObject({
    phase: "processing",
    retrying: id,
    blocker: "busy",
    message: expect.stringContaining("The microphone stays off"),
  });
  await vi.advanceTimersByTimeAsync(0);
  const replay = f.stream();
  expect(f.sent(replay.attempt)).toEqual([
    [0, 0],
    [1, 1],
    [2, 2],
  ]);
  await f.owner.execute({ type: "recovery.retry", id });
  f.owner.execute({ type: "session.stop" });
  f.owner.shortcut("hold.down");
  f.event({ type: "complete", ...replay, text: "Complete retried text.", samples: 960 });
  expect(f.capture).toHaveLength(captures);
  expect(f.starts()).toHaveLength(2);
  expect(f.inserted).toEqual([]);
  expect(f.owner.snapshot()).toMatchObject({
    phase: "complete",
    retrying: null,
    practiceText: "",
    lastTranscript: id,
    recovery: [
      expect.objectContaining({
        id,
        text: "Complete retried text.",
        transcription: "complete",
        hasAudio: false,
        delivery: "undelivered",
        cause: expect.stringContaining("already delivered"),
      }),
    ],
  });
  f.owner.close();
});

it("failed or cancelled Retry keeps its source, and Discard releases it", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const id = await f.retained("Keep me.", 2);
  await f.owner.execute({ type: "recovery.retry", id });
  await vi.advanceTimersByTimeAsync(0);
  const first = f.stream();
  f.event({ type: "stable", ...first, text: "Replay partial" });
  // A transient Retry failure gets the one automatic retry; the second failure ends it.
  f.event({ type: "failed", ...first, reason: "connection" });
  await vi.advanceTimersByTimeAsync(0);
  const second = f.stream();
  expect(second.attempt).not.toBe(first.attempt);
  f.event({ type: "failed", ...second, reason: "connection" });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.starts()).toHaveLength(3);
  expect(f.owner.snapshot()).toMatchObject({
    phase: "failed",
    retrying: null,
    recovery: [expect.objectContaining({ id, text: "Keep me.", hasAudio: true })],
  });

  await f.owner.execute({ type: "recovery.retry", id });
  await vi.advanceTimersByTimeAsync(0);
  const cancelled = f.stream();
  f.owner.shortcut("cancel");
  f.event({ type: "complete", ...cancelled, text: "Late.", samples: 640 });
  expect(f.owner.snapshot()).toMatchObject({
    phase: "cancelled",
    recovery: [
      expect.objectContaining({
        text: "Keep me.",
        hasAudio: true,
        cause: expect.stringContaining("Retry cancelled"),
      }),
    ],
  });

  await f.owner.execute({ type: "recovery.retry", id });
  await vi.advanceTimersByTimeAsync(0);
  const discarded = f.stream();
  await f.owner.execute({ type: "recovery.discard", id });
  f.event({ type: "complete", ...discarded, text: "Late.", samples: 640 });
  expect(f.owner.snapshot()).toMatchObject({ retrying: null, recovery: [] });
  expect(f.capture.filter((command) => command.type === "capture.start")).toHaveLength(1);
  f.owner.close();
});

it("Retry uses the 10/30-second classes from its click and a partial never extends them", async () => {
  vi.useFakeTimers();
  for (const [frames, deadline] of [
    [1500, 10_000],
    [1501, 30_000],
  ] as const) {
    const f = fixture();
    const id = await f.retained("", frames);
    await vi.advanceTimersByTimeAsync(5_000);
    await f.owner.execute({ type: "recovery.retry", id });
    await vi.advanceTimersByTimeAsync(deadline - 1);
    f.event({ type: "stable", ...f.stream(), text: "Replayed beginning" });
    expect(f.owner.snapshot().phase).toBe("processing");
    await vi.advanceTimersByTimeAsync(1);
    // A replay that times out with no older text keeps its available text, marked incomplete.
    expect(f.owner.snapshot()).toMatchObject({
      phase: "failed",
      message: expect.stringContaining("needs at least"),
      recovery: [
        expect.objectContaining({
          text: "Replayed beginning",
          transcription: "incomplete",
          hasAudio: true,
        }),
      ],
    });
    f.event({
      type: "complete",
      ...f.stream(),
      text: "Too late.",
      samples: frames * 320,
    });
    expect(f.owner.snapshot().recovery[0]?.text).toBe("Replayed beginning");
    f.owner.close();
  }
});

it("accepts a replay completing just inside the Stop deadline and rejects one at it", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.begin();
  await f.record(1);
  f.event({ type: "failed", ...f.stream(), reason: "connection" });
  f.stop(1);
  await vi.advanceTimersByTimeAsync(0);
  const replay = f.stream();
  await vi.advanceTimersByTimeAsync(9_999);
  f.event({ type: "complete", ...replay, text: "Just in time.", samples: 320 });
  expect(f.owner.snapshot()).toMatchObject({ phase: "complete", practiceText: "Just in time." });

  const g = fixture();
  await g.begin();
  await g.record(1);
  g.stop(1);
  const live = g.stream();
  await vi.advanceTimersByTimeAsync(10_000);
  g.event({ type: "complete", ...live, text: "Too late.", samples: 320 });
  expect(g.owner.snapshot()).toMatchObject({ phase: "failed", practiceText: "" });
  f.owner.close();
  g.owner.close();
});

// The real adapter against a loopback WebSocket fixture. The first connection drops mid-capture;
// the replay connection must receive the entire source, in order, then CloseStream.
it("replays the complete source in order over a fresh loopback stream after the live one drops", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("missing address");
  const connections: { socket: WebSocket; frames: Buffer[] }[] = [];
  const connected = Promise.withResolvers<void>();
  const replayed = Promise.withResolvers<Buffer[]>();
  server.on("connection", (socket) => {
    const frames: Buffer[] = [];
    connections.push({ socket, frames });
    socket.on("message", (data, binary) => {
      if (binary) {
        frames.push(Buffer.from(data.toString("hex"), "hex"));
        if (connections.length === 1 && frames.length === 2) connected.resolve();
        return;
      }
      if (JSON.parse(data.toString()).type !== "CloseStream") return;
      const seconds = Buffer.concat(frames).length / 32_000;
      socket.send(JSON.stringify(result(0, seconds, "Complete replay.")));
      socket.send(JSON.stringify({ type: "Metadata", duration: seconds, channels: 1 }));
      socket.close(1000);
      replayed.resolve(frames);
    });
  });
  const lost = Promise.withResolvers<void>();
  const done = Promise.withResolvers<void>();
  let stream: ReturnType<typeof startStream> | undefined;
  const capture: CaptureCommand[] = [];
  const owner = createSession({
    available: () => true,
    transcribable: () => true,
    online: () => true,
    device: () => null,
    credential: async () => "synthetic",
    capture: (command) => capture.push(command),
    provider: (command) => {
      if (command.type === "start") {
        stream?.cancel();
        stream = startStream(
          command,
          (event) => {
            owner.providerEvent(event);
            if (event.type === "failed") lost.resolve();
            if (event.type === "complete") done.resolve();
          },
          `ws://127.0.0.1:${address.port}`,
        );
      } else if (command.type === "audio") stream?.audio(command.sequence, command.pcm);
      else if (command.type === "stop") stream?.stop(command.frames, command.samples);
      else stream?.cancel();
    },
    changed: () => {},
    copy: async () => true,
    access: () => {},
    target: {
      capture: async () => "eligible",
      arm: async () => {},
      insert: async () => ({ outcome: "inserted" }),
      release: () => {},
    },
    engaged: () => {},
  });
  try {
    owner.execute({ type: "session.start", origin: "practice" });
    const identity = capture[0]!;
    const frame = (sequence: number) =>
      owner.captureEvent({
        type: "capture.frame",
        session: identity.session,
        attempt: identity.attempt,
        sequence,
        pcm: Buffer.alloc(640, sequence + 1).toString("base64"),
      });
    await Promise.resolve();
    frame(0);
    frame(1);
    await connected.promise;
    connections[0]!.socket.terminate();
    await lost.promise;
    expect(owner.snapshot()).toMatchObject({ phase: "recording", notice: "connection" });
    frame(2);
    frame(3);
    owner.execute({ type: "session.stop" });
    owner.captureEvent({
      type: "capture.stopped",
      session: identity.session,
      attempt: identity.attempt,
      frames: 4,
      samples: 1280,
    });
    const frames = await replayed.promise;
    await done.promise;
    expect(connections).toHaveLength(2);
    expect(Buffer.concat(frames)).toEqual(
      Buffer.concat([1, 2, 3, 4].map((fill) => Buffer.alloc(640, fill))),
    );
    expect(owner.snapshot()).toMatchObject({
      phase: "complete",
      practiceText: "Complete replay.",
    });
    expect(capture.filter((command) => command.type === "capture.start")).toHaveLength(1);
  } finally {
    owner.close();
    stream?.cancel();
    for (const client of server.clients) client.terminate();
    server.close();
  }
});
