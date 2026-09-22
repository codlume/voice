import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { WebSocketServer } from "ws";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

// Safety stops in the packaged app: the real helper, provider worker, and renderer, with synthetic
// capture and a loopback Deepgram stand-in. Faults are injected only into this isolated app:
// its own helper child is killed, its own worker thread ended, and its synthetic capture failed.
const executablePath = resolve(
  "out/Voice Development-darwin-arm64/Voice Development.app/Contents/MacOS/Voice Development",
);
const model = {
  model_uuid: "40bd3654-e622-47c4-a111-63a61b23bfe8",
  model_info: { version: "2025-04-17.21547" },
};
// Each connection answers with its own index, so a late result is attributable to its attempt.
async function fixtureServer() {
  let gate: Promise<void> = Promise.resolve();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const attempts: Buffer[][] = [];
  const closed: number[] = [];
  server.on("connection", (socket) => {
    const index = attempts.length;
    const frames: Buffer[] = [];
    attempts.push(frames);
    socket.on("close", () => closed.push(index));
    socket.on("message", (data, binary) => {
      if (binary) {
        frames.push(Buffer.from(data.toString("hex"), "hex"));
        return;
      }
      if (JSON.parse(data.toString()).type !== "CloseStream") return;
      void gate.then(() => {
        const seconds = Buffer.concat(frames).length / 32_000;
        socket.send(
          JSON.stringify({
            type: "Results",
            start: 0,
            duration: seconds,
            is_final: true,
            channel_index: [0, 1],
            metadata: model,
            channel: { alternatives: [{ transcript: `Attempt ${index} text.` }] },
          }),
        );
        socket.send(JSON.stringify({ type: "Metadata", duration: seconds, channels: 1 }));
        socket.close(1000);
      });
    });
  });
  return {
    attempts,
    closed,
    hold() {
      const { promise, resolve: open } = Promise.withResolvers<void>();
      gate = promise;
      return () => {
        gate = Promise.resolve();
        open();
      };
    },
    url: `ws://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
async function launch(directory: string, providerUrl: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== "ELECTRON_RUN_AS_NODE",
    ),
  );
  return electron.launch({
    executablePath,
    args: [`--voice-test-data=${directory}`],
    env: { ...env, VOICE_TEST_CAPTURE: "synthetic", VOICE_TEST_PROVIDER_URL: providerUrl },
  });
}
const hook = <T>(app: ElectronApplication, name: string, input?: unknown) =>
  app.evaluate(
    (_electron, [key, value]) =>
      (globalThis as unknown as { voiceTest: Record<string, (input: unknown) => T> }).voiceTest[
        key as string
      ]!(value),
    [name, input] as const,
  );
const state = (page: Page) =>
  page.evaluate(async () => {
    const reply = await window.voice.command({ type: "status.get" });
    if (!reply.ok || !reply.session) throw new Error("Session state unavailable");
    return { session: reply.session, status: reply.status };
  });
const menuStatus = async (app: ElectronApplication) =>
  (await hook<{ label: string }[]>(app, "menu"))[0]?.label;
// The helper's generated sine from sample 0, in order, with no gaps.
function expectFullSource(pcm: Buffer) {
  expect(pcm.length).toBeGreaterThan(640);
  for (let sample = 0; sample < pcm.length / 2; sample++)
    expect(pcm.readInt16LE(sample * 2)).toBe(
      Math.trunc(Math.sin((sample * 2 * Math.PI * 440) / 16000) * 8000) || 0,
    );
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("packaged worker and helper crashes keep recovery, restart without capture, and ignore a held shortcut", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "voice-safety-"));
  const server = await fixtureServer();
  const app = await launch(directory, server.url);
  const appProcess = app.process();
  try {
    const page = await app.firstWindow();
    const start = page.getByRole("button", { name: "Start practice", exact: true });
    const practice = page.getByRole("region", { name: "Practice dictation" });
    const status = page.getByTestId("practice-status");
    const dictation = page.getByTestId("dictation-status");
    const recovery = page.getByRole("region", { name: "Temporary recovery" });
    await expect(start).toBeEnabled();
    // Voice is frontmost, so shortcut sessions have no external target to insert into.
    await app.evaluate(({ app: application }) => application.focus({ steal: true }));

    // 1. The provider worker dies mid-capture: capture continues, and one fresh worker replays
    //    the whole source after Stop.
    await start.click();
    await expect(status).toContainText("Recording.");
    await expect.poll(() => server.attempts[0]?.length ?? 0).toBeGreaterThan(10);
    await hook(app, "killProvider");
    await expect(status).toContainText("The transcription worker stopped. Recording continues");
    await expect.poll(() => menuStatus(app)).toBe("Recording · transcription interrupted");
    expect((await state(page)).status.capture).toBe("active");
    await status.screenshot({ path: "test-results/practice-worker-interrupted.png" });
    await practice.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(status).toHaveText("Practice transcript ready.");
    expect(server.attempts).toHaveLength(2);
    expectFullSource(Buffer.concat(server.attempts[1]!));
    expect(await hook<number>(app, "captureStarts")).toBe(1);

    // 2. The helper dies during a held shortcut: capture ends with it, recovery keeps the audio,
    //    and a replacement helper becomes ready without starting capture.
    const before = await hook<{ state: string; pid: number }>(app, "helper");
    expect(before.state).toBe("ready");
    await hook(app, "shortcut", "hold.down");
    await expect(dictation).toContainText("Recording. Release the shortcut to finish.");
    await expect.poll(() => server.attempts[2]?.length ?? 0).toBeGreaterThan(10);
    await hook(app, "killHelper");
    await expect(dictation).toContainText("Native services stopped, so recording ended.");
    await expect.poll(async () => (await state(page)).status.capture).not.toBe("active");
    await expect
      .poll(async () => (await hook<{ state: string; pid: number }>(app, "helper")).state, {
        timeout: 10_000,
      })
      .toBe("ready");
    const after = await hook<{ state: string; pid: number }>(app, "helper");
    expect(after.pid).not.toBe(before.pid);
    expect(alive(before.pid)).toBe(false);
    // The released key after the restart, and a repeat of the stale press state, start nothing.
    await hook(app, "shortcut", "hold.up");
    expect(await hook<number>(app, "captureStarts")).toBe(2);
    expect((await state(page)).session.phase).toBe("failed");
    await expect(start).toBeEnabled();
    const entry = recovery.getByRole("article", { name: "Recovery session 1", exact: true });
    await expect(entry).toContainText("Native services stopped");
    await expect(entry.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
    await entry.screenshot({ path: "test-results/recovery-helper-restarted.png" });
    const source = (await state(page)).session.recovery[0];
    expect(source).toMatchObject({ hasAudio: true, transcription: "incomplete" });
    await entry.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(status).toHaveText(
      "Retry complete. The transcript is in recovery; Copy or Paste it.",
    );
    expectFullSource(Buffer.concat(server.attempts[3]!));
    expect(await hook<number>(app, "captureStarts")).toBe(2);

    // 3. A renderer reload during a shortcut session neither restarts nor duplicates capture.
    await hook(app, "shortcut", "toggle");
    await expect(dictation).toContainText("Recording. Use the toggle shortcut or Stop to finish.");
    await page.reload();
    await expect(dictation).toContainText("Recording. Use the toggle shortcut or Stop to finish.");
    expect(await hook<number>(app, "captureStarts")).toBe(3);
    await hook(app, "shortcut", "cancel");
    await expect(dictation).toContainText("Cancelled.");
    await page.reload();
    await expect(start).toBeEnabled();
    expect(await hook<number>(app, "captureStarts")).toBe(3);

    // 4. Quit still warns about the retained, undelivered Retry result.
    await app.evaluate(({ app: application }) => application.quit());
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: "Return to recovery", exact: true }).click();
    await expect(entry.getByRole("textbox")).toHaveValue("Attempt 3 text.");
  } finally {
    if (appProcess.exitCode === null) {
      const exited = once(appProcess, "exit");
      await app.evaluate(({ app: application }) => application.exit(0)).catch(() => {});
      await exited;
    }
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("packaged key changes, a lost device, and a revoked permission stop capture and keep recovery, and a stale result never reaches a fresh session", async () => {
  test.setTimeout(90_000);
  const execute = promisify(execFile);
  const directory = await mkdtemp(join(tmpdir(), "voice-safety-key-"));
  // The helper derives this isolated Keychain service from the test data directory.
  const service = `com.codlume.voice.test.${createHash("sha256").update(join(directory, "Voice Test")).digest("hex")}`;
  const server = await fixtureServer();
  const app = await launch(directory, server.url);
  const appProcess = app.process();
  try {
    const page = await app.firstWindow();
    const start = page.getByRole("button", { name: "Start practice", exact: true });
    const practice = page.getByRole("region", { name: "Practice dictation" });
    const status = page.getByTestId("practice-status");
    const field = page.getByRole("textbox", { name: "Practice transcript", exact: true });
    const recovery = page.getByRole("region", { name: "Temporary recovery" });
    const entries = recovery.getByRole("article", { name: /^Recovery session/ });
    const keyInput = page.getByLabel("Deepgram API key", { exact: true });
    const saveKey = async () => {
      await keyInput.fill(randomUUID().replaceAll("-", ""));
      await page.getByRole("button", { name: /^(Add|Replace) key$/ }).click();
      await expect(page.getByText("Key saved in Keychain. Access is not verified.")).toBeVisible();
    };
    await expect(start).toBeEnabled();

    // 1. Adding a key mid-capture stops capture and its stream at once and keeps the recording;
    //    nothing is resent until an explicit Retry.
    await start.click();
    await expect(status).toContainText("Recording.");
    await expect.poll(() => server.attempts[0]?.length ?? 0).toBeGreaterThan(10);
    await saveKey();
    await expect(status).toContainText("Deepgram key changed, so Voice stopped this session.");
    await expect.poll(() => server.closed).toContain(0);
    expect((await state(page)).status.capture).not.toBe("active");
    await expect(entries).toHaveCount(1);
    expect((await state(page)).session.recovery).toEqual([
      expect.objectContaining({ hasAudio: true, transcription: "incomplete" }),
    ]);
    await entries.first().screenshot({ path: "test-results/recovery-key-changed.png" });
    expect(server.attempts).toHaveLength(1);
    await entries.first().getByRole("button", { name: "Retry", exact: true }).click();
    await expect(status).toHaveText(
      "Retry complete. The transcript is in recovery; Copy or Paste it.",
    );
    expect(server.attempts).toHaveLength(2);
    const retried = Buffer.concat(server.attempts[1]!);
    expectFullSource(retried);
    expect(retried.length).toBeGreaterThanOrEqual(Buffer.concat(server.attempts[0]!).length);
    await entries.first().getByRole("button", { name: "Discard", exact: true }).click();
    await expect(entries).toHaveCount(0);

    // 2. A lost device stops capture and listening feedback and keeps the audio as incomplete.
    await start.click();
    await expect(status).toContainText("Recording.");
    await expect.poll(() => server.attempts[2]?.length ?? 0).toBeGreaterThan(10);
    await hook(app, "captureFailure", "device");
    await expect(status).toContainText("The microphone disconnected or changed");
    await expect.poll(() => menuStatus(app)).not.toContain("Recording");
    expect((await state(page)).status.capture).not.toBe("active");
    await status.screenshot({ path: "test-results/practice-device-lost.png" });
    await expect(entries).toHaveCount(1);

    // 3. Removing the key during that recording's Retry ends the Retry and keeps the source.
    const release = server.hold();
    await entries.first().getByRole("button", { name: "Retry", exact: true }).click();
    await expect.poll(() => server.attempts.length).toBe(4);
    await page.getByRole("button", { name: "Remove key", exact: true }).click();
    await expect(page.getByText("Key removed from Keychain.", { exact: true })).toBeVisible();
    await expect(status).toContainText("Deepgram key changed");
    await expect.poll(() => server.closed).toContain(3);
    release();
    expect((await state(page)).session).toMatchObject({
      retrying: null,
      recovery: [{ hasAudio: true, transcription: "incomplete" }],
    });

    // 4. A revoked permission stops capture the same way.
    await start.click();
    await expect(status).toContainText("Recording.");
    await expect.poll(() => server.attempts[4]?.length ?? 0).toBeGreaterThan(10);
    await hook(app, "captureFailure", "permission");
    await expect(status).toContainText("Microphone access was revoked");
    await expect(entries).toHaveCount(2);

    // 5. A session invalidated while its result is pending cannot leak into the next one.
    const hold = server.hold();
    await start.click();
    await expect(status).toContainText("Recording.");
    await expect.poll(() => server.attempts[5]?.length ?? 0).toBeGreaterThan(10);
    await practice.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(status).toHaveText("Finishing transcription…");
    await saveKey();
    await expect(status).toContainText("Deepgram key changed");
    await expect(entries).toHaveCount(3);
    await start.click();
    await expect(status).toContainText("Recording.");
    await expect.poll(() => server.attempts[6]?.length ?? 0).toBeGreaterThan(10);
    hold();
    await practice.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(status).toHaveText("Practice transcript ready.");
    await expect(field).toHaveValue("Attempt 6 text.");
    expect((await state(page)).session.recovery.map(({ text }) => text)).not.toContain(
      "Attempt 5 text.",
    );
    expect(await hook<number>(app, "captureStarts")).toBe(5);
  } finally {
    if (appProcess.exitCode === null) {
      const exited = once(appProcess, "exit");
      await app.evaluate(({ app: application }) => application.exit(0)).catch(() => {});
      await exited;
    }
    await server.close();
    // Exact service and account, never a broad Keychain cleanup.
    await execute(
      "/usr/bin/security",
      ["delete-generic-password", "-s", service, "-a", "deepgram"],
      { timeout: 5000 },
    ).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
