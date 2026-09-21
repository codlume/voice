import { _electron as electron, expect, test } from "@playwright/test";
import { WebSocketServer } from "ws";
import { once } from "node:events";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
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
  const appProcess = app.process();
  try {
    await app.evaluate(async ({ clipboard, ClipboardItem }) => {
      const previous = await Promise.all(
        (await clipboard.read())
          .filter((item) => item.types.length > 0)
          .map(
            async (item) =>
              new ClipboardItem(
                Object.fromEntries(
                  await Promise.all(
                    item.types.map(async (type) => [type, await item.getType(type)] as const),
                  ),
                ),
              ),
          ),
      );
      const scope = globalThis as typeof globalThis & {
        restoreTestClipboard?: () => Promise<void>;
      };
      scope.restoreTestClipboard = async () => {
        if ((await clipboard.readText()) !== "Hello, Priya. Do not deploy VX-204.") return;
        if (previous.length) await clipboard.write(previous);
        else clipboard.clear();
      };
    });
    let page = await app.firstWindow();
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
    let recovery = page.getByRole("region", { name: "Temporary recovery" });
    for (let index = 1; index < 5; index++) {
      const next = attempts.length;
      await start.click();
      await expect(status).toContainText("Recording.");
      await expect.poll(() => attempts[next]?.length ?? 0).toBeGreaterThan(10);
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await expect(status).toContainText("incomplete");
    }
    await expect(recovery.getByRole("article", { name: /^Recovery session/ })).toHaveCount(5);
    await expect(start).toBeDisabled();
    await page.reload();
    await expect(recovery.getByRole("article", { name: /^Recovery session/ })).toHaveCount(5);
    await expect(start).toBeDisabled();
    const first = recovery.getByRole("article", { name: "Recovery session 1", exact: true });
    await app.evaluate(({ clipboard }) => {
      const original = clipboard.writeText;
      clipboard.writeText = async () => {
        clipboard.writeText = original;
        throw new Error("Injected clipboard failure");
      };
    });
    await first.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(page.getByTestId("recovery-status")).toContainText("Copy failed");
    await expect(first.getByRole("textbox")).toHaveValue("Hello, Priya. Do not deploy VX-204.");
    await first.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(page.getByTestId("recovery-status")).toContainText("Copied available text");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      "Hello, Priya. Do not deploy VX-204.",
    );
    await expect(start).toBeDisabled();
    await first.screenshot({ path: "test-results/recovery-copied.png" });
    await first.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(start).toBeEnabled();
    await expect(recovery.getByRole("article", { name: /^Recovery session/ })).toHaveCount(4);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
    expect(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible()),
    ).toBe(false);
    await app.evaluate(({ app: application }) => application.emit("activate"));
    await expect(recovery.getByRole("article", { name: /^Recovery session/ })).toHaveCount(4);
    await app.evaluate(
      ({ BrowserWindow }) =>
        new Promise<void>((done) => {
          const contents = BrowserWindow.getAllWindows()[0]!.webContents;
          contents.once("render-process-gone", () => done());
          contents.forcefullyCrashRenderer();
        }),
    );
    const replacement = app.waitForEvent("window");
    await app.evaluate(({ app: application }) => application.quit());
    page = await replacement;
    recovery = page.getByRole("region", { name: "Temporary recovery" });
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("alertdialog").screenshot({ path: "test-results/recovery-quit.png" });
    await page.getByRole("button", { name: "Return to recovery", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(recovery.getByRole("article", { name: /^Recovery session/ })).toHaveCount(4);
    const snapshot = await page.evaluate(() => window.voice.command({ type: "status.get" }));
    expect(JSON.stringify(snapshot)).not.toContain("synthetic-fixture-key");
    const db = new DatabaseSync(join(directory, "Voice Test/settings.sqlite"));
    try {
      expect(JSON.stringify(db.prepare("select * from preferences").all())).not.toContain("Priya");
    } finally {
      db.close();
    }
    const files = await readdir(join(directory, "Voice Test"), {
      recursive: true,
      withFileTypes: true,
    });
    for (const file of files.filter((entry) => entry.isFile())) {
      const content = await readFile(join(file.parentPath, file.name));
      expect(content.includes(Buffer.from("Hello, Priya.")), file.name).toBe(false);
      expect(content.includes(pcm.subarray(0, 640)), file.name).toBe(false);
    }
    await app.evaluate(async () => {
      const scope = globalThis as typeof globalThis & {
        restoreTestClipboard?: () => Promise<void>;
      };
      await scope.restoreTestClipboard?.();
      delete scope.restoreTestClipboard;
    });
    await page.getByRole("button", { name: "Quit Voice", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    const exited = once(appProcess, "exit");
    await page.getByRole("button", { name: "Quit and discard", exact: true }).click();
    await exited;
    const reopened = await electron.launch({
      executablePath,
      args: [`--voice-test-data=${directory}`],
      env: {
        ...env,
        VOICE_TEST_CAPTURE: "synthetic",
        VOICE_TEST_PROVIDER_URL: `ws://127.0.0.1:${address.port}`,
      },
    });
    try {
      const fresh = await reopened.firstWindow();
      await expect(
        fresh.getByRole("button", { name: "Start practice", exact: true }),
      ).toBeEnabled();
      const state = await fresh.evaluate(() => window.voice.command({ type: "status.get" }));
      expect(state).toMatchObject({
        ok: true,
        session: { recovery: [], latestSuccessful: null, practiceText: "" },
      });
    } finally {
      await reopened.close();
    }
  } finally {
    if (appProcess.exitCode === null) {
      await app
        .evaluate(async () => {
          const scope = globalThis as typeof globalThis & {
            restoreTestClipboard?: () => Promise<void>;
          };
          await scope.restoreTestClipboard?.();
        })
        .catch(() => {});
      // Failed assertions must also tear down this isolated app, even if its renderer crashed.
      await app.evaluate(({ app: application }) => application.exit(0));
    }
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
