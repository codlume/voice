import { expect, it } from "vite-plus/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider } from "./provider";
import type { ProviderEvent } from "@voice/contracts/session";

// Real worker threads with a stand-in entry: it reports its thread for each start and crashes on
// audio, so worker replacement is observable without a provider connection.
it("reports one worker failure per crashed attempt and starts a fresh worker only for the next attempt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-provider-"));
  const entry = join(directory, "worker.mjs");
  await writeFile(
    entry,
    `import { parentPort, threadId } from "node:worker_threads";
    parentPort.on("message", (command) => {
      if (command.type === "start")
        parentPort.postMessage({ type: "stable", session: command.session, attempt: command.attempt, text: String(threadId) });
      if (command.type === "audio") process.exit(1);
    });`,
  );
  const events: ProviderEvent[] = [];
  const waiters: (() => void)[] = [];
  const provider = createProvider(entry, (event) => {
    events.push(event);
    for (const waiter of waiters.splice(0)) waiter();
  });
  const until = (count: number) =>
    new Promise<void>((done) => {
      const check = () => (events.length >= count ? done() : waiters.push(check));
      check();
    });
  const first = { session: "one", attempt: "live" };
  const second = { session: "one", attempt: "replay" };
  try {
    provider.send({ type: "start", ...first, key: "synthetic" });
    await until(1);
    provider.send({ type: "audio", ...first, sequence: 0, pcm: new Uint8Array(640) });
    await until(2);
    expect(events[1]).toEqual({ type: "failed", ...first, reason: "worker" });
    provider.send({ type: "start", ...second, key: "synthetic" });
    await until(3);
    expect(events[2]).toMatchObject({ type: "stable", ...second });
    const threads = events.flatMap((event) => (event.type === "stable" ? [event.text] : []));
    expect(threads).toHaveLength(2);
    expect(threads[1]).not.toBe(threads[0]);
    // Cancelling retires the worker without reporting a failure for an attempt that ended.
    provider.send({ type: "cancel", ...second });
    const missing = createProvider(join(directory, "missing.mjs"), (event) => {
      events.push(event);
      for (const waiter of waiters.splice(0)) waiter();
    });
    missing.send({ type: "start", session: "two", attempt: "live", key: "synthetic" });
    await until(4);
    expect(events.slice(3)).toEqual([
      { type: "failed", session: "two", attempt: "live", reason: "worker" },
    ]);
    await missing.close();
  } finally {
    await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});
