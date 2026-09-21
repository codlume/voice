import { _electron as electron, expect, test } from "@playwright/test";
import { WebSocketServer } from "ws";
import { once } from "node:events";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
const executablePath = resolve(
  "out/Voice Development-darwin-arm64/Voice Development.app/Contents/MacOS/Voice Development",
);
const model = {
  model_uuid: "40bd3654-e622-47c4-a111-63a61b23bfe8",
  model_info: { version: "2025-04-17.21547" },
};

test("packaged practice uses native PCM, the provider worker, and one final practice result; failures survive reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-practice-"));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  let mode: "complete" | "incomplete" | "silence" = "complete";
  const attempts: Buffer[][] = [];
  server.on("connection", (socket, request) => {
    expect(request.headers.authorization).toBe("Token synthetic-fixture-key");
    const frames: Buffer[] = [];
    attempts.push(frames);
    socket.on("message", (data, binary) => {
      if (binary) {
        frames.push(Buffer.from(data.toString("hex"), "hex"));
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
          channel: {
            alternatives: [
              { transcript: mode === "silence" ? "" : "Hello, Priya. Do not deploy VX-204." },
            ],
          },
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
  try {
    const page = await app.firstWindow();
    const start = page.getByRole("button", { name: "Start practice", exact: true });
    const status = page.getByTestId("practice-status");
    const field = page.getByRole("textbox", { name: "Practice transcript", exact: true });
    await expect(start).toBeEnabled();
    expect(attempts).toHaveLength(0);
    await start.click();
    await expect(status).toContainText("Recording.");
    await expect(field).toHaveValue("");
    await expect.poll(() => attempts[0]?.length ?? 0).toBeGreaterThan(10);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(status).toHaveText("Practice transcript ready.");
    await expect(field).toHaveValue("Hello, Priya. Do not deploy VX-204.");
    const pcm = Buffer.concat(attempts[0]!);
    expect(pcm.length).toBeGreaterThan(6400);
    expect(pcm.some((byte) => byte !== 0)).toBe(true);
    // Check the actual generated 16 kHz mono PCM16 samples across every frame boundary.
    for (let sample = 0; sample < pcm.length / 2; sample++)
      expect(pcm.readInt16LE(sample * 2)).toBe(
        Math.trunc(Math.sin((sample * 2 * Math.PI * 440) / 16000) * 8000) || 0,
      );
    await page
      .getByRole("region", { name: "Practice dictation" })
      .screenshot({ path: "test-results/practice-complete.png" });
    mode = "silence";
    await start.click();
    await expect(status).toContainText("Recording.");
    await expect.poll(() => attempts[1]?.length ?? 0).toBeGreaterThan(10);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(status).toHaveText("No speech detected");
    await expect(field).toHaveValue("Hello, Priya. Do not deploy VX-204.");
    mode = "incomplete";
    await start.click();
    await expect(status).toContainText("Recording.");
    await expect.poll(() => attempts[2]?.length ?? 0).toBeGreaterThan(20);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(status).toContainText("incomplete");
    await expect(
      page.getByRole("textbox", { name: "Available text, may be incomplete", exact: true }),
    ).toHaveValue("Hello, Priya. Do not deploy VX-204.");
    await page.reload();
    await expect(
      page.getByRole("textbox", { name: "Available text, may be incomplete", exact: true }),
    ).toHaveValue("Hello, Priya. Do not deploy VX-204.");
    await expect(start).toBeEnabled();
    expect(attempts).toHaveLength(3);
    await start.click();
    await expect(status).toContainText("Recording.");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(status).toContainText("Cancelled.");
    await expect(field).toHaveValue("Hello, Priya. Do not deploy VX-204.");
    const snapshot = await page.evaluate(() => window.voice.command({ type: "status.get" }));
    expect(JSON.stringify(snapshot)).not.toContain("synthetic-fixture-key");
    const db = new DatabaseSync(join(directory, "Voice Test/settings.sqlite"));
    try {
      expect(JSON.stringify(db.prepare("select * from preferences").all())).not.toContain("Priya");
    } finally {
      db.close();
    }
    expect(await readdir(join(directory, "Voice Test"))).not.toContain("audio");
  } finally {
    await app.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
