import { expect, it, vi, afterEach } from "vite-plus/test";
import { createSession } from "./session";
import type {
  CaptureCommand,
  InsertionOutcome,
  ProviderRequest,
  TargetStatus,
} from "@voice/contracts/session";

afterEach(() => vi.useRealTimers());
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture(
  overrides: {
    target?: TargetStatus;
    insert?: () => Promise<InsertionOutcome>;
  } = {},
) {
  const capture: CaptureCommand[] = [];
  const provider: ProviderRequest[] = [];
  const targets: string[] = [];
  const engaged: boolean[] = [];
  const owner = createSession({
    available: () => true,
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
      release: (id) => {
        targets.push(`release:${id}`);
      },
    },
    engaged: (active) => engaged.push(active),
  });
  const starts = () => capture.filter((command) => command.type === "capture.start");
  const identity = () => {
    const start = starts().at(-1);
    if (!start) throw new Error("No capture started");
    return { session: start.session, attempt: start.attempt };
  };
  const frame = (sequence = 0) =>
    owner.captureEvent({
      type: "capture.frame",
      ...identity(),
      sequence,
      pcm: Buffer.alloc(640, 1).toString("base64"),
    });
  const stopped = (frames = 1) =>
    owner.captureEvent({ type: "capture.stopped", ...identity(), frames, samples: frames * 320 });
  const complete = (text: string, frames = 1) =>
    owner.providerEvent({ type: "complete", ...identity(), text, samples: frames * 320 });
  // Hold, speak one frame, release, and finish transcription with the given text.
  async function dictate(text: string) {
    owner.shortcut("hold.down");
    await settle();
    frame();
    owner.shortcut("hold.up");
    stopped();
    complete(text);
    await settle();
  }
  return {
    owner,
    capture,
    provider,
    targets,
    engaged,
    starts,
    identity,
    frame,
    stopped,
    complete,
    dictate,
  };
}

it("hold-to-talk starts once per press, remembers the target before audio, and inserts on release", async () => {
  const { owner, targets, engaged, starts, identity, frame, stopped, complete } = fixture();
  owner.shortcut("hold.up");
  expect(starts()).toHaveLength(0);
  owner.shortcut("hold.down");
  owner.shortcut("hold.down");
  expect(starts()).toHaveLength(1);
  expect(owner.snapshot()).toMatchObject({ phase: "starting", origin: "dictation" });
  expect(targets).toEqual([`capture:${identity().session}`]);
  await settle();
  frame();
  expect(owner.snapshot().message).toBe("Recording. Release the shortcut to finish.");
  owner.shortcut("hold.up");
  expect(owner.snapshot().phase).toBe("processing");
  owner.shortcut("hold.down");
  expect(starts()).toHaveLength(1);
  stopped();
  complete("Hello, Priya. Do not deploy VX-204.");
  expect(owner.snapshot().phase).toBe("inserting");
  owner.execute({ type: "session.cancel" });
  expect(owner.snapshot().phase).toBe("inserting");
  await settle();
  expect(targets.at(-2)).toBe(`insert:${identity().session}:Hello, Priya. Do not deploy VX-204.`);
  expect(targets.at(-1)).toBe(`release:${identity().session}`);
  expect(owner.snapshot()).toMatchObject({
    phase: "complete",
    message: "Inserted.",
    recovery: [],
    latestSuccessful: { text: "Hello, Priya. Do not deploy VX-204." },
    canStart: true,
  });
  expect(engaged).toEqual([true, false]);
  complete("late duplicate");
  expect(targets.filter((entry) => entry.startsWith("insert:"))).toHaveLength(1);
  owner.close();
});

it("toggle runs hands-free, a hold press during it never restarts, and toggling again stops", async () => {
  const { owner, starts, frame } = fixture();
  owner.shortcut("toggle");
  await settle();
  frame();
  expect(owner.snapshot().message).toBe("Recording. Use the toggle shortcut or Stop to finish.");
  owner.shortcut("hold.down");
  owner.shortcut("hold.up");
  expect(starts()).toHaveLength(1);
  expect(owner.snapshot().phase).toBe("recording");
  owner.shortcut("toggle");
  expect(owner.snapshot().phase).toBe("processing");
  owner.shortcut("toggle");
  expect(starts()).toHaveLength(1);
  owner.close();
});

it("toggle while holding converts to hands-free so releasing the hold key keeps recording", async () => {
  const { owner, frame } = fixture();
  owner.shortcut("hold.down");
  await settle();
  frame();
  owner.shortcut("toggle");
  owner.shortcut("hold.up");
  expect(owner.snapshot().phase).toBe("recording");
  owner.execute({ type: "session.stop" });
  expect(owner.snapshot().phase).toBe("processing");
  owner.close();
});

it("cancel stops delivery, and keys still held after cancel or the cap never create a session", async () => {
  vi.useFakeTimers();
  const { owner, starts, targets, identity, frame, stopped, complete } = fixture();
  owner.shortcut("hold.down");
  await vi.advanceTimersByTimeAsync(0);
  frame();
  owner.shortcut("cancel");
  expect(owner.snapshot().phase).toBe("cancelled");
  expect(targets).toContain(`release:${identity().session}`);
  owner.shortcut("hold.up");
  owner.shortcut("hold.down");
  expect(starts()).toHaveLength(1);
  stopped(0);
  complete("Never insert");
  expect(targets.some((entry) => entry.startsWith("insert:"))).toBe(false);
  owner.shortcut("hold.down");
  expect(starts()).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(0);
  frame();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(owner.snapshot().phase).toBe("processing");
  owner.shortcut("hold.up");
  owner.shortcut("hold.down");
  expect(starts()).toHaveLength(2);
  owner.close();
});

it("keeps the transcript in recovery when no eligible target was focused at the start", async () => {
  const { owner, targets, dictate } = fixture({ target: "none" });
  await dictate("Saved for later.");
  expect(targets.some((entry) => entry.startsWith("insert:"))).toBe(false);
  expect(owner.snapshot()).toMatchObject({
    phase: "failed",
    message: expect.stringContaining("No text field was focused"),
    recovery: [
      expect.objectContaining({
        text: "Saved for later.",
        transcription: "complete",
        delivery: "failed",
        hasAudio: false,
      }),
    ],
    latestSuccessful: null,
  });
  owner.close();
});

it("a focus change before delivery retains the transcript and never inserts elsewhere", async () => {
  const { owner, targets, dictate } = fixture({ insert: async () => "changed" });
  await dictate("Do not deploy.");
  expect(targets.filter((entry) => entry.startsWith("insert:"))).toHaveLength(1);
  expect(owner.snapshot()).toMatchObject({
    phase: "failed",
    message: expect.stringContaining("Focus moved away"),
    recovery: [expect.objectContaining({ text: "Do not deploy.", delivery: "failed" })],
  });
  owner.close();
});

it("uncertain insertion says Check your target, retains text, and makes no second attempt", async () => {
  const { owner, targets, dictate } = fixture({ insert: async () => "uncertain" });
  await dictate("Maybe delivered.");
  expect(owner.snapshot()).toMatchObject({
    phase: "failed",
    message: expect.stringContaining("Check your target"),
    recovery: [
      expect.objectContaining({
        text: "Maybe delivered.",
        delivery: "uncertain",
        cause: expect.stringContaining("Check your target"),
      }),
    ],
    latestSuccessful: null,
  });
  await settle();
  expect(targets.filter((entry) => entry.startsWith("insert:"))).toHaveLength(1);
  owner.close();
});

it("a helper failure during insertion becomes uncertain instead of a lost transcript", async () => {
  const { promise, reject } = Promise.withResolvers<InsertionOutcome>();
  const { owner, dictate } = fixture({ insert: () => promise });
  await dictate("In flight.");
  expect(owner.snapshot().phase).toBe("inserting");
  owner.helperFailed();
  reject(new Error("native-unavailable"));
  await settle();
  expect(owner.snapshot().recovery).toEqual([
    expect.objectContaining({ text: "In flight.", delivery: "uncertain" }),
  ]);
  owner.close();
});

it("an expired deadline prevents delivery even when the provider finishes later", async () => {
  vi.useFakeTimers();
  const { owner, targets, frame, stopped, complete } = fixture();
  owner.shortcut("hold.down");
  await vi.advanceTimersByTimeAsync(0);
  frame();
  owner.shortcut("hold.up");
  stopped();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(owner.snapshot().phase).toBe("failed");
  complete("Too late.");
  await vi.advanceTimersByTimeAsync(0);
  expect(targets.some((entry) => entry.startsWith("insert:"))).toBe(false);
  owner.close();
});

it("explicit Paste inserts once into the deliberately selected destination and resolves the entry", async () => {
  const { owner, targets, engaged, dictate } = fixture({ target: "none" });
  await dictate("Recovered text.");
  const [entry] = owner.snapshot().recovery;
  if (!entry) throw new Error("Expected a recovery entry");
  engaged.length = 0;
  await owner.execute({ type: "recovery.paste", id: entry.id });
  expect(owner.snapshot()).toMatchObject({ armedPaste: entry.id, canStart: false });
  expect(targets.at(-1)).toBe(`arm:${entry.id}`);
  expect(engaged).toEqual([true]);
  owner.shortcut("hold.down");
  await owner.execute({ type: "recovery.paste", id: entry.id });
  expect(targets.filter((item) => item.startsWith("arm:"))).toHaveLength(1);
  owner.targetSelected({
    type: "target.selected",
    session: "other",
    status: "eligible",
  });
  owner.targetSelected({ type: "target.selected", session: entry.id, status: "none" });
  expect(targets.some((item) => item.startsWith("insert:"))).toBe(false);
  owner.targetSelected({
    type: "target.selected",
    session: entry.id,
    status: "eligible",
  });
  await settle();
  expect(targets.at(-1)).toBe(`insert:${entry.id}:Recovered text.`);
  expect(owner.snapshot()).toMatchObject({
    armedPaste: null,
    recoveryMessage: "Inserted.",
    recovery: [],
    latestSuccessful: { id: entry.id, text: "Recovered text." },
    canStart: true,
  });
  expect(engaged).toEqual([true, false]);
  owner.targetSelected({
    type: "target.selected",
    session: entry.id,
    status: "eligible",
  });
  await settle();
  expect(targets.filter((item) => item.startsWith("insert:"))).toHaveLength(1);
  owner.close();
});

it("Paste of the latest successful transcript keeps it, and uncertain or failed paste retains the entry", async () => {
  let outcome: InsertionOutcome = "uncertain";
  const { owner, targets, dictate } = fixture({ insert: async () => outcome });
  outcome = "inserted";
  await dictate("First.");
  const latest = owner.snapshot().latestSuccessful;
  if (!latest) throw new Error("Expected a latest transcript");
  await owner.execute({ type: "recovery.paste", id: latest.id });
  owner.targetSelected({
    type: "target.selected",
    session: latest.id,
    status: "eligible",
  });
  await settle();
  expect(targets.at(-1)).toBe(`insert:${latest.id}:First.`);
  expect(owner.snapshot().latestSuccessful).toEqual(latest);
  outcome = "uncertain";
  await dictate("Second.");
  const [entry] = owner.snapshot().recovery;
  if (!entry) throw new Error("Expected a recovery entry");
  outcome = "changed";
  await owner.execute({ type: "recovery.paste", id: entry.id });
  owner.targetSelected({
    type: "target.selected",
    session: entry.id,
    status: "eligible",
  });
  await settle();
  expect(owner.snapshot()).toMatchObject({
    recoveryMessage: expect.stringContaining("Not pasted"),
    recovery: [expect.objectContaining({ id: entry.id, text: "Second.", delivery: "failed" })],
  });
  outcome = "uncertain";
  await owner.execute({ type: "recovery.paste", id: entry.id });
  owner.targetSelected({
    type: "target.selected",
    session: entry.id,
    status: "eligible",
  });
  await settle();
  expect(owner.snapshot()).toMatchObject({
    recoveryMessage: expect.stringContaining("Check your target"),
    recovery: [expect.objectContaining({ id: entry.id, delivery: "uncertain" })],
  });
  owner.close();
});

it("Paste disarms on the cancel shortcut, Cancel, or timeout without authorizing a later paste", async () => {
  const { owner, targets, dictate } = fixture({ target: "none" });
  await dictate("Keep me.");
  vi.useFakeTimers();
  const [entry] = owner.snapshot().recovery;
  if (!entry) throw new Error("Expected a recovery entry");
  await owner.execute({ type: "recovery.paste", id: entry.id });
  owner.shortcut("cancel");
  expect(owner.snapshot()).toMatchObject({
    armedPaste: null,
    recoveryMessage: expect.stringContaining("Paste cancelled"),
  });
  expect(targets.at(-1)).toBe(`release:${entry.id}`);
  owner.targetSelected({
    type: "target.selected",
    session: entry.id,
    status: "eligible",
  });
  await owner.execute({ type: "recovery.paste", id: entry.id });
  await owner.execute({ type: "session.cancel" });
  expect(owner.snapshot().armedPaste).toBeNull();
  await owner.execute({ type: "recovery.paste", id: entry.id });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(owner.snapshot()).toMatchObject({
    armedPaste: null,
    recoveryMessage: expect.stringContaining("timed out"),
  });
  owner.targetSelected({
    type: "target.selected",
    session: entry.id,
    status: "eligible",
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(targets.some((item) => item.startsWith("insert:"))).toBe(false);
  expect(owner.snapshot().recovery).toHaveLength(1);
  owner.close();
});

it("window lifecycle leaves a shortcut session alone while credential changes stop it", async () => {
  const { owner, frame, identity } = fixture();
  owner.shortcut("hold.down");
  await settle();
  frame();
  owner.practiceInterrupted("The practice window closed.");
  expect(owner.snapshot().phase).toBe("recording");
  owner.interrupted("Credential changed.");
  expect(owner.snapshot().phase).toBe("processing");
  owner.captureEvent({ type: "capture.stopped", ...identity(), frames: 1, samples: 320 });
  expect(owner.snapshot()).toMatchObject({
    phase: "failed",
    recovery: [expect.objectContaining({ hasAudio: true })],
  });
  owner.close();
});
