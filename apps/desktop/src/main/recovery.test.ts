import { afterEach, expect, it } from "vite-plus/test";
import { createCommands } from "./commands";
import { createSession } from "./session";
import { decodeReply } from "@voice/contracts/desktop";
import type { CaptureCommand } from "@voice/contracts/session";

const owners: ReturnType<typeof createSession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.close();
});
function fixture(copy?: (text: string) => Promise<boolean>) {
  const captures: CaptureCommand[] = [];
  const clipboard = { text: "", fails: false };
  const quit = { confirmed: false };
  const owner = createSession({
    available: () => true,
    transcribable: () => true,
    online: () => true,
    device: () => null,
    credential: async () => "synthetic",
    capture: (command) => {
      captures.push(command);
    },
    provider: () => {},
    changed: () => {},
    access: () => {},
    target: {
      capture: async () => "eligible",
      arm: async () => {},
      insert: async () => ({ outcome: "inserted" }),
      release: () => {},
    },
    engaged: () => {},
    copy:
      copy ??
      (async (text) => {
        if (clipboard.fails) return false;
        clipboard.text = text;
        return true;
      }),
  });
  owners.push(owner);
  const commands = createCommands({
    quit: (confirmed) => {
      if (confirmed || !owner.requestQuit()) quit.confirmed = true;
    },
    session: () => owner,
    isAuthorized: (sender) => sender === "window",
    initialSettings: { appearance: "light" },
    storage: { set: async (value) => value, restart: async () => ({ appearance: "light" }) },
    status: () => ({
      storage: "ready",
      helper: "ready",
      capture: "available",
      shortcuts: "unavailable",
    }),
  });
  const execute = (payload: unknown) => commands.execute("window", payload);
  async function snapshot() {
    const reply = decodeReply(await execute({ type: "status.get" }));
    if (!reply.ok || !reply.session) throw new Error("Missing session");
    return reply.session;
  }
  async function start(text: string) {
    await execute({ type: "session.start", origin: "practice" });
    const { session, attempt } = captures.findLast((command) => command.type === "capture.start")!;
    owner.captureEvent({
      type: "capture.frame",
      session,
      attempt,
      sequence: 0,
      pcm: Buffer.alloc(640, 7).toString("base64"),
    });
    owner.providerEvent({ type: "stable", session, attempt, text });
    return { session, attempt };
  }
  async function fail(text: string) {
    const identity = await start(text);
    owner.captureEvent({ type: "capture.failed", ...identity });
    return identity;
  }
  return { owner, commands, captures, clipboard, quit, execute, snapshot, start, fail };
}

it("keeps nonempty failures separate and blocks concurrent Start admission at five entries", async () => {
  const f = fixture();
  for (const text of [
    "First thought.",
    "Do not deploy VX-204.",
    "Priya, September 21.",
    "Use example.com.",
    "Fifth thought.",
  ])
    await f.fail(text);
  const before = await f.snapshot();
  expect(before.recovery.map((entry) => entry.text)).toEqual([
    "First thought.",
    "Do not deploy VX-204.",
    "Priya, September 21.",
    "Use example.com.",
    "Fifth thought.",
  ]);
  expect(
    before.recovery.every((entry) => entry.hasAudio && entry.transcription === "incomplete"),
  ).toBe(true);
  await Promise.all([
    f.execute({ type: "session.start", origin: "practice" }),
    f.execute({ type: "session.start", origin: "practice" }),
  ]);
  expect((await f.snapshot()).blocker).not.toBeNull();
  expect(f.captures.filter((command) => command.type === "capture.start")).toHaveLength(5);
  expect((await f.snapshot()).recovery).toEqual(before.recovery);
});

it("reports Copy failure, resolves copied text, and preserves an incomplete audio source until Discard", async () => {
  const f = fixture();
  const identity = await f.fail("Keep the full recording.");
  f.clipboard.fails = true;
  await f.execute({ type: "recovery.copy", id: identity.session });
  expect((await f.snapshot()).recovery[0]).toMatchObject({ delivery: "failed", hasAudio: true });
  expect(f.clipboard.text).toBe("");
  f.clipboard.fails = false;
  await f.execute({ type: "recovery.copy", id: identity.session });
  expect(f.clipboard.text).toBe("Keep the full recording.");
  expect((await f.snapshot()).recovery[0]).toMatchObject({ delivery: "copied", hasAudio: true });
  expect((await f.snapshot()).recoveryMessage).toContain("Copied");
  await f.execute({ type: "recovery.discard", id: identity.session });
  f.owner.providerEvent({ type: "complete", ...identity, text: "Late text", samples: 320 });
  expect((await f.snapshot()).recovery).toEqual([]);
  expect((await f.snapshot()).practiceText).toBe("");
});

it("reopens capacity only after the unresolved source is discarded and rejects unauthorized recovery commands", async () => {
  const f = fixture();
  let id = "";
  for (let index = 0; index < 5; index++) id = (await f.fail(`Thought ${index}.`)).session;
  expect(await f.commands.execute("other", { type: "recovery.discard", id })).toEqual({
    ok: false,
    error: "unauthorized",
  });
  expect(await f.execute({ type: "recovery.copy", id, text: "injected" })).toEqual({
    ok: false,
    error: "invalid-command",
  });
  await f.execute({ type: "recovery.copy", id });
  expect((await f.snapshot()).blocker).not.toBeNull();
  await f.execute({ type: "recovery.discard", id });
  expect((await f.snapshot()).blocker).toBeNull();
  expect(f.captures.filter((command) => command.type === "capture.start")).toHaveLength(5);
  await Promise.all([
    f.execute({ type: "session.start", origin: "practice" }),
    f.execute({ type: "session.start", origin: "practice" }),
  ]);
  expect(f.captures.filter((command) => command.type === "capture.start")).toHaveLength(6);
});

async function complete(f: ReturnType<typeof fixture>, text: string) {
  const identity = await f.start(text);
  await f.execute({ type: "session.stop" });
  f.owner.captureEvent({ type: "capture.stopped", ...identity, frames: 1, samples: 320 });
  f.owner.providerEvent({ type: "complete", ...identity, text, samples: 320 });
  return identity.session;
}

it("releases audio after complete transcription and confirms practice delivery without evicting older failures", async () => {
  const f = fixture();
  await f.fail("Earlier unfinished thought.");
  const first = await complete(f, "First complete transcript.");
  expect((await f.snapshot()).recovery[1]).toMatchObject({
    id: first,
    text: "First complete transcript.",
    transcription: "complete",
    hasAudio: false,
  });
  expect((await f.snapshot()).latestSuccessful).toBeNull();
  await f.execute({ type: "practice.delivered", id: first });
  const second = await complete(f, "Second complete transcript.");
  await f.execute({ type: "practice.delivered", id: first });
  expect((await f.snapshot()).recovery).toHaveLength(2);
  await f.execute({ type: "practice.delivered", id: second });
  expect((await f.snapshot()).latestSuccessful).toEqual({
    id: second,
    text: "Second complete transcript.",
  });
  expect((await f.snapshot()).recovery).toHaveLength(1);
  expect((await f.snapshot()).recovery[0]?.text).toBe("Earlier unfinished thought.");
});

it("retains complete text when the practice renderer disappears, and Copy resolves it", async () => {
  const f = fixture();
  const id = await complete(f, "Complete but undelivered.");
  f.owner.interrupted("Practice window closed.");
  await f.execute({ type: "practice.delivered", id });
  expect((await f.snapshot()).recovery[0]).toMatchObject({
    hasAudio: false,
    transcription: "complete",
    delivery: "uncertain",
  });
  expect((await f.snapshot()).latestSuccessful).toBeNull();
  await f.execute({ type: "recovery.copy", id });
  expect(f.clipboard.text).toBe("Complete but undelivered.");
  expect((await f.snapshot()).recovery).toEqual([]);
  expect((await f.snapshot()).latestSuccessful?.text).toBe("Complete but undelivered.");
});

it("Cancel releases unfinished new audio while preserving produced text, which Copy can resolve", async () => {
  const f = fixture();
  const identity = await f.start("Already produced words.");
  await f.execute({ type: "session.cancel" });
  f.owner.captureEvent({ type: "capture.stopped", ...identity, frames: 1, samples: 320 });
  expect((await f.snapshot()).recovery[0]).toMatchObject({
    text: "Already produced words.",
    hasAudio: false,
    transcription: "incomplete",
  });
  await f.execute({ type: "recovery.copy", id: identity.session });
  expect((await f.snapshot()).recovery).toEqual([]);
  expect(f.clipboard.text).toBe("Already produced words.");
});

it("warns before quit, returns to recovery without starting capture, and requires a pending warning to confirm", async () => {
  const f = fixture();
  await f.execute({ type: "app.quit.confirm" });
  expect(f.quit.confirmed).toBe(false);
  await f.fail("Retain this until I decide.");
  await f.execute({ type: "app.quit" });
  expect((await f.snapshot()).quitWarning).toBe(true);
  expect(f.quit.confirmed).toBe(false);
  await f.execute({ type: "session.start", origin: "practice" });
  expect(f.captures.filter((command) => command.type === "capture.start")).toHaveLength(1);
  await f.execute({ type: "app.quit.cancel" });
  expect((await f.snapshot()).quitWarning).toBe(false);
  expect((await f.snapshot()).recovery).toHaveLength(1);
  await f.execute({ type: "app.quit" });
  await f.execute({ type: "app.quit.confirm" });
  expect(f.quit.confirmed).toBe(true);
  f.owner.close();
  expect((await f.snapshot()).recovery).toEqual([]);
  expect((await f.snapshot()).latestSuccessful).toBeNull();
});

it("offers Copy and Discard for the latest successful transcript independently of undelivered work", async () => {
  const f = fixture();
  const failed = await f.fail("Keep this source.");
  const id = await complete(f, "Latest confirmed text.");
  await f.execute({ type: "practice.delivered", id });
  await f.execute({ type: "recovery.copy", id });
  expect(f.clipboard.text).toBe("Latest confirmed text.");
  await f.execute({ type: "recovery.discard", id });
  expect((await f.snapshot()).latestSuccessful).toBeNull();
  expect((await f.snapshot()).practiceText).toBe("");
  expect((await f.snapshot()).recovery[0]?.id).toBe(failed.session);
});

it("Discard invalidates a pending Copy result without reviving or resolving another entry", async () => {
  const pending = Promise.withResolvers<boolean>();
  const f = fixture(() => pending.promise);
  const id = await complete(f, "Do not resurrect this transcript.");
  f.owner.interrupted("Renderer disappeared.");
  const copying = f.execute({ type: "recovery.copy", id });
  await f.execute({ type: "recovery.discard", id });
  await f.fail("Keep the next source.");
  pending.resolve(true);
  await copying;
  expect((await f.snapshot()).recovery.map((entry) => entry.text)).toEqual([
    "Keep the next source.",
  ]);
  expect((await f.snapshot()).latestSuccessful).toBeNull();
  expect((await f.snapshot()).recoveryMessage).toContain("Discarded");
});
