import { expect, it } from "vite-plus/test";
import { createSession } from "./session";
import type {
  CaptureCommand,
  InsertionResult,
  ProviderRequest,
  TargetStatus,
} from "@voice/contracts/session";

// Session outcomes of the helper's clipboard-paste fallback. The helper owns the clipboard; main
// only learns the delivery result and whether the previous clipboard could be put back.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const transcript = "Hello, Priya. Do not deploy VX-204.";
function fixture(options: { target?: TargetStatus; insert?: () => Promise<InsertionResult> } = {}) {
  const capture: CaptureCommand[] = [];
  const provider: ProviderRequest[] = [];
  const inserts: string[] = [];
  const copies: string[] = [];
  const owner = createSession({
    available: () => true,
    transcribable: () => true,
    online: () => true,
    device: () => null,
    credential: async () => "synthetic",
    capture: (command) => capture.push(command),
    provider: (command) => provider.push(command),
    changed: () => {},
    copy: async (text) => {
      copies.push(text);
      return true;
    },
    access: () => {},
    target: {
      capture: async () => options.target ?? "eligible",
      arm: async () => {},
      insert: async (_id, text) => {
        inserts.push(text);
        return options.insert ? options.insert() : { outcome: "pasted" };
      },
      release: () => {},
    },
    engaged: () => {},
  });
  const identity = () => {
    const start = capture.findLast((command) => command.type === "capture.start");
    if (!start) throw new Error("No capture started");
    return { session: start.session, attempt: start.attempt };
  };
  async function dictate(text = transcript) {
    owner.shortcut("hold.down");
    await settle();
    owner.captureEvent({
      type: "capture.frame",
      ...identity(),
      sequence: 0,
      pcm: Buffer.alloc(640, 1).toString("base64"),
    });
    owner.shortcut("hold.up");
    owner.captureEvent({ type: "capture.stopped", ...identity(), frames: 1, samples: 320 });
    owner.providerEvent({ type: "complete", ...identity(), text, samples: 320 });
    await settle();
  }
  // Explicit Paste of a recovery entry into a field the user then selects.
  async function paste(id: string) {
    await owner.execute({ type: "recovery.paste", id });
    owner.targetSelected({ type: "target.selected", session: id, status: "eligible" });
    await settle();
  }
  const entry = () => {
    const [first] = owner.snapshot().recovery;
    if (!first) throw new Error("Expected a recovery entry");
    return first;
  };
  return { owner, inserts, copies, dictate, paste, entry };
}

it("a confirmed clipboard paste completes once, says the clipboard was used, and keeps nothing in recovery", async () => {
  const { owner, inserts, copies, dictate } = fixture();
  await dictate();
  expect(owner.snapshot()).toMatchObject({
    phase: "complete",
    message: "Inserted with a clipboard paste. Your clipboard still holds what you last copied.",
    notice: null,
    recovery: [],
    latestSuccessful: { text: transcript },
  });
  expect(inserts).toEqual([transcript]);
  expect(copies).toEqual([]);
  owner.close();
});

it("an unpreservable clipboard is left alone, keeps the text for explicit Copy, and Copy reports only copied", async () => {
  const { owner, inserts, copies, dictate, entry } = fixture({
    insert: async () => ({ outcome: "unpreserved" }),
  });
  await dictate();
  expect(owner.snapshot()).toMatchObject({
    phase: "failed",
    notice: "not-inserted",
    message: expect.stringMatching(
      /^Not inserted\. .*could not keep your current clipboard exactly, so it left the clipboard untouched\. Use Copy/,
    ),
    latestSuccessful: null,
  });
  expect(entry()).toMatchObject({ text: transcript, delivery: "failed" });
  // Main never writes the clipboard on its own; only the explicit Copy does.
  expect(copies).toEqual([]);
  await owner.execute({ type: "recovery.copy", id: entry().id });
  expect(copies).toEqual([transcript]);
  expect(owner.snapshot()).toMatchObject({
    recoveryMessage: "Copied.",
    recovery: [],
    latestSuccessful: { text: transcript },
  });
  expect(inserts).toHaveLength(1);
  owner.close();
});

it("an unconfirmed paste says Check your target, retains the text, and is never retried", async () => {
  const { owner, inserts, dictate, entry } = fixture({
    insert: async () => ({ outcome: "uncertain" }),
  });
  await dictate();
  expect(owner.snapshot()).toMatchObject({
    phase: "failed",
    notice: "uncertain",
    message: "Check your target. The transcript is in recovery.",
  });
  expect(entry()).toMatchObject({ text: transcript, delivery: "uncertain" });
  await settle();
  expect(inserts).toHaveLength(1);
  owner.close();
});

it("a paste that could not put the previous clipboard back says so on success and failure", async () => {
  let result: InsertionResult = { outcome: "pasted", clipboard: "unrestored" };
  const { owner, dictate } = fixture({ insert: async () => result });
  await dictate();
  expect(owner.snapshot()).toMatchObject({
    phase: "complete",
    message:
      "Inserted with a clipboard paste. Voice could not put back what was on your clipboard before.",
  });
  result = { outcome: "changed", clipboard: "unrestored" };
  await dictate();
  expect(owner.snapshot().message).toBe(
    "Not inserted. Focus moved away from the original field. The transcript is in recovery. Voice could not put back what was on your clipboard before.",
  );
  owner.close();
});

it("a helper that stops mid-delivery leaves an uncertain entry that warns about the clipboard", async () => {
  const pending = Promise.withResolvers<InsertionResult>();
  const { owner, inserts, dictate, entry } = fixture({ insert: () => pending.promise });
  await dictate();
  expect(owner.snapshot().phase).toBe("inserting");
  owner.helperFailed();
  pending.reject(new Error("native-unavailable"));
  await settle();
  expect(owner.snapshot()).toMatchObject({
    phase: "failed",
    notice: "uncertain",
    message: expect.stringContaining(
      "If Voice was pasting, your clipboard may still hold this transcript.",
    ),
  });
  expect(entry()).toMatchObject({ text: transcript, delivery: "uncertain" });
  expect(inserts).toHaveLength(1);
  owner.close();
});

it("Cancel cannot undo a paste that is already being delivered", async () => {
  const pending = Promise.withResolvers<InsertionResult>();
  const { owner, dictate } = fixture({ insert: () => pending.promise });
  await dictate();
  await owner.execute({ type: "session.cancel" });
  owner.shortcut("cancel");
  expect(owner.snapshot().phase).toBe("inserting");
  pending.resolve({ outcome: "pasted" });
  await settle();
  expect(owner.snapshot()).toMatchObject({ phase: "complete", recovery: [] });
  owner.close();
});

it("explicit Paste through the clipboard resolves its entry; an unpreservable clipboard keeps it for Copy", async () => {
  let result: InsertionResult = { outcome: "unpreserved" };
  const { owner, inserts, copies, dictate, paste, entry } = fixture({
    target: "none",
    insert: async () => result,
  });
  await dictate();
  const { id } = entry();
  await paste(id);
  expect(owner.snapshot()).toMatchObject({
    armedPaste: null,
    recoveryMessage: expect.stringMatching(/^Not pasted\. .*left the clipboard untouched/),
    recovery: [expect.objectContaining({ id, delivery: "failed" })],
  });
  result = { outcome: "pasted" };
  await paste(id);
  expect(owner.snapshot()).toMatchObject({
    recoveryMessage:
      "Inserted with a clipboard paste. Your clipboard still holds what you last copied.",
    recovery: [],
    latestSuccessful: { id, text: transcript },
  });
  expect(inserts).toEqual([transcript, transcript]);
  expect(copies).toEqual([]);
  owner.close();
});

it("an explicit Paste interrupted by a helper failure is uncertain and warns about the clipboard", async () => {
  const pending = Promise.withResolvers<InsertionResult>();
  let result: Promise<InsertionResult> = Promise.resolve({ outcome: "changed" });
  const { owner, inserts, dictate, paste, entry } = fixture({ insert: () => result });
  await dictate();
  const { id } = entry();
  result = pending.promise;
  await paste(id);
  owner.helperFailed();
  pending.reject(new Error("native-unavailable"));
  await settle();
  expect(owner.snapshot()).toMatchObject({
    armedPaste: null,
    recoveryMessage: expect.stringContaining("your clipboard may still hold this transcript"),
    recovery: [expect.objectContaining({ id, delivery: "uncertain" })],
  });
  expect(inserts).toHaveLength(2);
  owner.close();
});
