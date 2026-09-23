import { expect, it, vi, afterEach } from "vite-plus/test";
import { createSession } from "./session";
import type { CaptureCommand, ProviderRequest } from "@voice/contracts/session";
afterEach(() => vi.useRealTimers());
function fixture() {
  const capture: CaptureCommand[] = [];
  const provider: ProviderRequest[] = [];
  const owner = createSession({
    available: () => true,
    transcribable: () => true,
    online: () => true,
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
      insert: async () => ({ outcome: "inserted" }),
      release: () => {},
    },
    engaged: () => {},
  });
  return { owner, capture, provider };
}
it("starts explicitly, shows recording only on audio, and delivers one complete practice result", async () => {
  const { owner, capture, provider } = fixture();
  expect(capture).toEqual([]);
  owner.execute({ type: "session.start", origin: "practice" });
  const identity = capture[0]!;
  expect(owner.snapshot().phase).toBe("starting");
  owner.execute({ type: "session.start", origin: "practice" });
  owner.captureEvent({
    type: "capture.frame",
    session: identity.session,
    attempt: identity.attempt,
    sequence: 0,
    pcm: Buffer.alloc(640, 1).toString("base64"),
  });
  expect(owner.snapshot().phase).toBe("recording");
  await Promise.resolve();
  expect(provider.map((command) => command.type)).toEqual(["start", "audio"]);
  owner.providerEvent({
    type: "stable",
    session: identity.session,
    attempt: identity.attempt,
    text: "Hello, Priya.",
  });
  expect(owner.snapshot().recovery).toEqual([]);
  expect(owner.snapshot().practiceText).toBe("");
  owner.execute({ type: "session.stop" });
  owner.captureEvent({
    type: "capture.stopped",
    session: identity.session,
    attempt: identity.attempt,
    frames: 1,
    samples: 320,
  });
  owner.providerEvent({
    type: "complete",
    session: identity.session,
    attempt: identity.attempt,
    text: "Hello, Priya.",
    samples: 320,
  });
  expect(owner.snapshot()).toMatchObject({ phase: "complete", practiceText: "Hello, Priya." });
  owner.providerEvent({
    type: "complete",
    session: identity.session,
    attempt: identity.attempt,
    text: "duplicate",
    samples: 320,
  });
  expect(owner.snapshot().practiceText).toBe("Hello, Priya.");
  owner.close();
});
it("cancels without delivering late results and preserves stable text", async () => {
  const { owner, capture } = fixture();
  owner.execute({ type: "session.start", origin: "practice" });
  await Promise.resolve();
  const { session, attempt } = capture[0]!;
  owner.captureEvent({
    type: "capture.frame",
    session,
    attempt,
    sequence: 0,
    pcm: Buffer.alloc(640, 2).toString("base64"),
  });
  owner.providerEvent({ type: "stable", session, attempt, text: "Do not deploy." });
  owner.execute({ type: "session.cancel" });
  owner.providerEvent({ type: "complete", session, attempt, text: "Deploy.", samples: 320 });
  expect(owner.snapshot()).toMatchObject({
    phase: "cancelled",
    recovery: [expect.objectContaining({ text: "Do not deploy.", hasAudio: false })],
    practiceText: "",
  });
  owner.close();
});
it("warns at 4:30, caps at five minutes and never queues busy starts", async () => {
  vi.useFakeTimers();
  const { owner, capture } = fixture();
  owner.execute({ type: "session.start", origin: "practice" });
  await Promise.resolve();
  const { session, attempt } = capture[0]!;
  owner.captureEvent({
    type: "capture.frame",
    session,
    attempt,
    sequence: 0,
    pcm: Buffer.alloc(640, 2).toString("base64"),
  });
  await vi.advanceTimersByTimeAsync(270_000);
  expect(owner.snapshot()).toMatchObject({ phase: "recording", notice: "limit" });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(owner.snapshot().phase).toBe("processing");
  owner.execute({ type: "session.start", origin: "practice" });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(owner.snapshot()).toMatchObject({
    phase: "failed",
    recovery: [expect.objectContaining({ hasAudio: true })],
  });
  expect(capture.filter((command) => command.type === "capture.start")).toHaveLength(1);
  owner.close();
});
it("partial results never extend a stop deadline, and stale completion cannot deliver", async () => {
  vi.useFakeTimers();
  const { owner, capture } = fixture();
  owner.execute({ type: "session.start", origin: "practice" });
  await Promise.resolve();
  const { session, attempt } = capture[0]!;
  owner.captureEvent({
    type: "capture.frame",
    session,
    attempt,
    sequence: 0,
    pcm: Buffer.alloc(640, 1).toString("base64"),
  });
  owner.execute({ type: "session.stop" });
  owner.captureEvent({ type: "capture.stopped", session, attempt, frames: 1, samples: 320 });
  await vi.advanceTimersByTimeAsync(9_999);
  owner.providerEvent({ type: "stable", session, attempt, text: "Still processing." });
  await vi.advanceTimersByTimeAsync(1);
  owner.providerEvent({ type: "complete", session, attempt, text: "Too late.", samples: 320 });
  expect(owner.snapshot()).toMatchObject({
    phase: "failed",
    practiceText: "",
    recovery: [expect.objectContaining({ text: "Still processing." })],
  });
  owner.close();
});
it("does not evict failures when retention capacity is full", async () => {
  const { owner, capture } = fixture();
  for (let index = 0; index < 5; index++) {
    owner.execute({ type: "session.start", origin: "practice" });
    await Promise.resolve();
    const { session, attempt } = capture.findLast((command) => command.type === "capture.start")!;
    owner.captureEvent({
      type: "capture.frame",
      session,
      attempt,
      sequence: 0,
      pcm: Buffer.alloc(640, index).toString("base64"),
    });
    owner.helperFailed();
  }
  owner.execute({ type: "session.start", origin: "practice" });
  expect(owner.snapshot().blocker).not.toBeNull();
  expect(owner.snapshot().recovery).toHaveLength(5);
  expect(capture.filter((command) => command.type === "capture.start")).toHaveLength(5);
  owner.close();
});
it("rejects missing frames and stops when capture provides no first frame", async () => {
  vi.useFakeTimers();
  const { owner, capture } = fixture();
  owner.execute({ type: "session.start", origin: "practice" });
  await Promise.resolve();
  const { session, attempt } = capture[0]!;
  owner.captureEvent({
    type: "capture.frame",
    session,
    attempt,
    sequence: 1,
    pcm: Buffer.alloc(640, 1).toString("base64"),
  });
  expect(owner.snapshot().phase).toBe("failed");
  owner.execute({ type: "session.start", origin: "practice" });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(owner.snapshot().phase).toBe("failed");
  owner.close();
});
it("gives captures over 30 seconds a fixed 30-second processing deadline", async () => {
  vi.useFakeTimers();
  const { owner, capture } = fixture();
  owner.execute({ type: "session.start", origin: "practice" });
  await Promise.resolve();
  const { session, attempt } = capture[0]!;
  for (let sequence = 0; sequence < 1501; sequence++)
    owner.captureEvent({
      type: "capture.frame",
      session,
      attempt,
      sequence,
      pcm: Buffer.alloc(640, 1).toString("base64"),
    });
  owner.execute({ type: "session.stop" });
  owner.captureEvent({ type: "capture.stopped", session, attempt, frames: 1501, samples: 480320 });
  await vi.advanceTimersByTimeAsync(29_999);
  expect(owner.snapshot().phase).toBe("processing");
  await vi.advanceTimersByTimeAsync(1);
  expect(owner.snapshot()).toMatchObject({
    phase: "failed",
    recovery: [expect.objectContaining({ hasAudio: true })],
  });
  owner.close();
});
it("credential changes stop capture, preserve its final drained frames and ignore late delivery", async () => {
  const { owner, capture, provider } = fixture();
  owner.execute({ type: "session.start", origin: "practice" });
  await Promise.resolve();
  const { session, attempt } = capture[0]!;
  owner.captureEvent({
    type: "capture.frame",
    session,
    attempt,
    sequence: 0,
    pcm: Buffer.alloc(640, 1).toString("base64"),
  });
  owner.providerEvent({ type: "partial", session, attempt, text: "Retain the unfinished thought" });
  owner.interrupted("Credential changed.");
  owner.captureEvent({
    type: "capture.frame",
    session,
    attempt,
    sequence: 1,
    pcm: Buffer.alloc(640, 2).toString("base64"),
  });
  owner.captureEvent({ type: "capture.stopped", session, attempt, frames: 2, samples: 640 });
  owner.providerEvent({ type: "complete", session, attempt, text: "Never insert", samples: 640 });
  expect(provider.filter((command) => command.type === "audio")).toHaveLength(1);
  expect(owner.snapshot()).toMatchObject({
    phase: "failed",
    recovery: [expect.objectContaining({ hasAudio: true, text: "Retain the unfinished thought" })],
    practiceText: "",
  });
  owner.close();
});
it("selects the longer deadline when final drained frames cross 30 seconds, measured from Stop", async () => {
  vi.useFakeTimers();
  const { owner, capture } = fixture();
  owner.execute({ type: "session.start", origin: "practice" });
  await Promise.resolve();
  const { session, attempt } = capture[0]!;
  for (let sequence = 0; sequence < 1500; sequence++)
    owner.captureEvent({
      type: "capture.frame",
      session,
      attempt,
      sequence,
      pcm: Buffer.alloc(640, 1).toString("base64"),
    });
  owner.execute({ type: "session.stop" });
  await vi.advanceTimersByTimeAsync(100);
  owner.captureEvent({
    type: "capture.frame",
    session,
    attempt,
    sequence: 1500,
    pcm: Buffer.alloc(640, 1).toString("base64"),
  });
  owner.captureEvent({ type: "capture.stopped", session, attempt, frames: 1501, samples: 480320 });
  await vi.advanceTimersByTimeAsync(29_899);
  expect(owner.snapshot().phase).toBe("processing");
  await vi.advanceTimersByTimeAsync(1);
  expect(owner.snapshot().phase).toBe("failed");
  owner.close();
});
it("does not accept or queue a new Start until cancelled native capture acknowledges shutdown", async () => {
  const { owner, capture } = fixture();
  owner.execute({ type: "session.start", origin: "practice" });
  await Promise.resolve();
  const { session, attempt } = capture[0]!;
  owner.execute({ type: "session.cancel" });
  expect(owner.snapshot()).toMatchObject({ phase: "cancelled", blocker: "busy" });
  owner.execute({ type: "session.start", origin: "practice" });
  expect(capture.filter((command) => command.type === "capture.start")).toHaveLength(1);
  owner.captureEvent({ type: "capture.stopped", session, attempt, frames: 0, samples: 0 });
  expect(owner.snapshot().blocker).toBeNull();
  expect(capture.filter((command) => command.type === "capture.start")).toHaveLength(1);
  owner.execute({ type: "session.start", origin: "practice" });
  expect(capture.filter((command) => command.type === "capture.start")).toHaveLength(2);
  owner.close();
});
