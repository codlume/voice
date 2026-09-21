import { expect, it, vi, afterEach } from "vite-plus/test";
import { createSession } from "./session";
import type { CaptureCommand, ProviderRequest } from "@voice/contracts/session";
afterEach(() => vi.useRealTimers());
function fixture() {
  const capture: CaptureCommand[] = [];
  const provider: ProviderRequest[] = [];
  const owner = createSession({
    available: () => true,
    device: () => null,
    credential: async () => "synthetic",
    capture: (command) => capture.push(command),
    provider: (command) => provider.push(command),
    changed: () => {},
    access: () => {},
  });
  return { owner, capture, provider };
}
it("starts explicitly, shows recording only on audio, and delivers one complete practice result", async () => {
  const { owner, capture, provider } = fixture();
  expect(capture).toEqual([]);
  owner.execute({ type: "session.start" });
  const identity = capture[0]!;
  expect(owner.snapshot().phase).toBe("starting");
  owner.execute({ type: "session.start" });
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
  expect(owner.snapshot().retainedText).toBe("");
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
  owner.execute({ type: "session.start" });
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
    retainedText: "Do not deploy.",
    retainedCount: 1,
    practiceText: "",
  });
  owner.close();
});
it("warns at 4:30, caps at five minutes and never queues busy starts", async () => {
  vi.useFakeTimers();
  const { owner, capture } = fixture();
  owner.execute({ type: "session.start" });
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
  expect(owner.snapshot()).toMatchObject({ phase: "recording", warning: true });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(owner.snapshot().phase).toBe("processing");
  owner.execute({ type: "session.start" });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(owner.snapshot()).toMatchObject({ phase: "failed", retainedCount: 1 });
  expect(capture.filter((command) => command.type === "capture.start")).toHaveLength(1);
  owner.close();
});
it("partial results never extend a stop deadline, and stale completion cannot deliver", async () => {
  vi.useFakeTimers();
  const { owner, capture } = fixture();
  owner.execute({ type: "session.start" });
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
    retainedText: "Still processing.",
  });
  owner.close();
});
it("does not evict failures when retention capacity is full", async () => {
  const { owner, capture } = fixture();
  for (let index = 0; index < 5; index++) {
    owner.execute({ type: "session.start" });
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
  owner.execute({ type: "session.start" });
  expect(owner.snapshot()).toMatchObject({ canStart: false, retainedCount: 5 });
  expect(capture.filter((command) => command.type === "capture.start")).toHaveLength(5);
  owner.close();
});
it("rejects missing frames and stops when capture provides no first frame", async () => {
  vi.useFakeTimers();
  const { owner, capture } = fixture();
  owner.execute({ type: "session.start" });
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
  owner.execute({ type: "session.start" });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(owner.snapshot().phase).toBe("failed");
  owner.close();
});
it("gives captures over 30 seconds a fixed 30-second processing deadline", async () => {
  vi.useFakeTimers();
  const { owner, capture } = fixture();
  owner.execute({ type: "session.start" });
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
  expect(owner.snapshot()).toMatchObject({ phase: "failed", retainedCount: 1 });
  owner.close();
});
it("credential changes stop capture, preserve its final drained frames and ignore late delivery", async () => {
  const { owner, capture, provider } = fixture();
  owner.execute({ type: "session.start" });
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
    retainedCount: 1,
    retainedText: "Retain the unfinished thought",
    practiceText: "",
  });
  owner.close();
});
