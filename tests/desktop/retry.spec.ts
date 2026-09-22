import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { WebSocketServer } from "ws";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const executablePath = resolve(
  "out/Voice Development-darwin-arm64/Voice Development.app/Contents/MacOS/Voice Development",
);
const transcript = "Hello, Priya. Do not deploy VX-204.";
const model = {
  model_uuid: "40bd3654-e622-47c4-a111-63a61b23bfe8",
  model_info: { version: "2025-04-17.21547" },
};
// How the loopback Deepgram stand-in treats each new connection, in order.
type Mode = "complete" | "incomplete" | "drop";
const hook = <T>(app: ElectronApplication, name: string, input?: unknown) =>
  app.evaluate(
    (_electron, [key, value]) =>
      (globalThis as unknown as { voiceTest: Record<string, (input: unknown) => T> }).voiceTest[
        key as string
      ]!(value),
    [name, input] as const,
  );
// Every attempt must be the helper's generated sine from sample 0, in order, with no gaps, so a
// tail-only or reordered replay fails sample by sample.
function expectFullSource(pcm: Buffer) {
  expect(pcm.length).toBeGreaterThan(640);
  for (let sample = 0; sample < pcm.length / 2; sample++)
    expect(pcm.readInt16LE(sample * 2)).toBe(
      Math.trunc(Math.sin((sample * 2 * Math.PI * 440) / 16000) * 8000) || 0,
    );
}

test("packaged capture continues offline and through a dropped stream, replays the full source, and Retry never starts the microphone", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "voice-retry-"));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const modes: Mode[] = [];
  const attempts: Buffer[][] = [];
  server.on("connection", (socket) => {
    const mode = modes.shift() ?? "complete";
    const frames: Buffer[] = [];
    attempts.push(frames);
    socket.on("message", (data, binary) => {
      if (binary) {
        frames.push(Buffer.from(data.toString("hex"), "hex"));
        if (mode === "drop" && frames.length === 10) socket.terminate();
        return;
      }
      if (JSON.parse(data.toString()).type !== "CloseStream") return;
      const seconds = Buffer.concat(frames).length / 32_000;
      socket.send(
        JSON.stringify({
          type: "Results",
          start: 0,
          duration: mode === "incomplete" ? seconds / 2 : seconds,
          is_final: true,
          channel_index: [0, 1],
          metadata: model,
          channel: { alternatives: [{ transcript }] },
        }),
      );
      socket.send(JSON.stringify({ type: "Metadata", duration: seconds, channels: 1 }));
      socket.close(1000);
    });
  });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0] !== "ELECTRON_RUN_AS_NODE",
    ),
  );
  const app = await electron.launch({
    executablePath,
    args: [`--voice-test-data=${directory}`],
    env: {
      ...env,
      VOICE_TEST_CAPTURE: "synthetic",
      VOICE_TEST_PROVIDER_URL: `ws://127.0.0.1:${address.port}`,
    },
  });
  const appProcess = app.process();
  try {
    const page = await app.firstWindow();
    const start = page.getByRole("button", { name: "Start practice", exact: true });
    const practice = page.getByRole("region", { name: "Practice dictation" });
    const stop = practice.getByRole("button", { name: "Stop", exact: true });
    const status = page.getByTestId("practice-status");
    const field = page.getByRole("textbox", { name: "Practice transcript", exact: true });
    const menuStatus = async () => (await hook<{ label: string }[]>(app, "menu"))[0]?.label;
    await expect(start).toBeEnabled();

    // 1. Offline at Start: capture runs with the shared warning, and nothing reaches the provider.
    await hook(app, "offline", true);
    await start.click();
    await expect(status).toContainText("Offline. Recording continues");
    await expect.poll(menuStatus).toBe("Recording · offline");
    await status.screenshot({ path: "test-results/practice-offline-recording.png" });
    await stop.click();
    await expect(status).toContainText("Waiting for a connection");
    expect(attempts).toHaveLength(0);
    await hook(app, "offline", false);
    await expect(status).toHaveText("Practice transcript ready.");
    await expect(field).toHaveValue(transcript);
    expect(attempts).toHaveLength(1);
    expectFullSource(Buffer.concat(attempts[0]!));

    // 2. The live stream drops mid-capture: recording continues, then a fresh stream gets it all.
    modes.push("drop", "complete");
    await start.click();
    await expect(status).toContainText("Connection lost. Recording continues");
    const dropped = Buffer.concat(attempts[1]!).length;
    await stop.click();
    await expect(status).toHaveText("Practice transcript ready.");
    expect(attempts).toHaveLength(3);
    const replayed = Buffer.concat(attempts[2]!);
    expect(replayed.length).toBeGreaterThanOrEqual(dropped);
    expectFullSource(replayed);

    // 3. An incomplete result stays in recovery with its audio; Retry replays exactly that source.
    modes.push("incomplete");
    await start.click();
    await expect(status).toContainText("Recording.");
    await expect.poll(() => attempts[3]?.length ?? 0).toBeGreaterThan(10);
    await stop.click();
    await expect(status).toContainText("incomplete");
    const source = Buffer.concat(attempts[3]!);
    const recovery = page.getByRole("region", { name: "Temporary recovery" });
    const entry = recovery.getByRole("article", { name: "Recovery session 1", exact: true });
    await expect(recovery).toContainText("a five-minute recording at least 240 seconds");
    await entry.screenshot({ path: "test-results/recovery-retry-available.png" });
    const captures = await hook<number>(app, "captureStarts");
    await entry.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(status).toHaveText(
      "Retry complete. The transcript is in recovery; Copy or Paste it.",
    );
    await expect(
      entry.getByRole("textbox", { name: "Complete provider-final transcript", exact: true }),
    ).toHaveValue(transcript);
    await entry.screenshot({ path: "test-results/recovery-retry-complete.png" });
    expect(attempts).toHaveLength(5);
    expect(Buffer.concat(attempts[4]!)).toEqual(source);
    expect(await hook<number>(app, "captureStarts")).toBe(captures);
    // Retry never delivers on its own: the practice field keeps the earlier delivered text only.
    await expect(field).toHaveValue(transcript);
    const state = await page.evaluate(() => window.voice.command({ type: "status.get" }));
    expect(state).toMatchObject({
      ok: true,
      session: { retrying: null, recovery: [{ hasAudio: false, delivery: "undelivered" }] },
    });
    expect(state.ok && state.status.capture).not.toBe("active");
  } finally {
    if (appProcess.exitCode === null)
      await app.evaluate(({ app: application }) => application.exit(0)).catch(() => {});
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
