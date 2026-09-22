import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const executablePath = resolve(
  "out/Voice Development-darwin-arm64/Voice Development.app/Contents/MacOS/Voice Development",
);
function electronEnvironment() {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
  }
  return env;
}
async function launch(directory: string) {
  const env = electronEnvironment();
  const application = await electron.launch({
    env,
    executablePath,
    args: [`--voice-test-data=${directory}`, `--log-net-log=${join(directory, "network.json")}`],
  });
  const page = await application.firstWindow();
  // Host permission grants vary. Setup/status queries must keep the session idle.
  await expect
    .poll(() => page.evaluate(() => window.voice.command({ type: "status.get" })))
    .toMatchObject({
      ok: true,
      status: {
        helper: "ready",
        storage: "ready",
        capture: expect.stringMatching(/^(available|unavailable)$/),
      },
      session: { phase: "idle" },
    });
  return { application, page };
}
async function shutdown(application: ElectronApplication) {
  const pid = application.process().pid;
  const helperPid = await application.evaluate(({ app }) => {
    const { helper }: typeof import("../../apps/desktop/src/main/index") = process
      .getBuiltinModule("module")
      .createRequire(app.getAppPath() + "/package.json")("./electron/main.cjs");
    return helper?.child.pid;
  });
  await application.close();
  for (const ownedPid of [pid, helperPid]) {
    expect(ownedPid).toBeDefined();
    if (ownedPid) expect(() => process.kill(ownedPid, 0)).toThrow();
  }
}

test("unsigned package persists settings through the actual Electron worker and migrated restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-packaged-"));
  let running: ElectronApplication | undefined;
  try {
    let { application, page } = await launch(directory);
    running = application;
    await expect(page.getByRole("main")).toHaveCSS("background-color", "rgb(243, 246, 250)");
    expect(
      await page.evaluate(() => ({
        keys: Object.keys(window.voice).toSorted(),
        node: typeof Reflect.get(window, "require"),
      })),
    ).toEqual({ keys: ["command", "onChanged", "onReveal"], node: "undefined" });
    const paths = await application.evaluate(({ app }) => ({
      data: app.getPath("userData"),
      packaged: app.isPackaged,
      versions: process.versions,
    }));
    expect(paths.packaged).toBe(true);
    expect(paths.versions.electron).toBe("44.1.0");
    expect(paths.data).toBe(join(directory, "Voice Test"));
    await page.getByRole("radio", { name: "Dark" }).check();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status")).toHaveText("Saved.");
    await shutdown(application);
    running = undefined;
    const filename = join(directory, "Voice Test/settings.sqlite");
    const read = () => {
      const db = new DatabaseSync(filename);
      try {
        return {
          rows: db.prepare("select appearance from preferences").all(),
          migrations: db.prepare("select * from __drizzle_migrations").all(),
        };
      } finally {
        db.close();
      }
    };
    const saved = read();
    expect(saved.rows).toEqual([{ appearance: "dark" }]);
    expect(saved.migrations).toHaveLength(2);
    for (let restart = 0; restart < 2; restart += 1) {
      ({ application, page } = await launch(directory));
      running = application;
      await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();
      await expect(page.getByRole("main")).toHaveCSS("background-color", "rgb(23, 32, 46)");
      await shutdown(application);
      running = undefined;
      expect(read()).toEqual(saved);
    }
    const network = JSON.parse(await readFile(join(directory, "network.json"), "utf8"));
    const serialized = JSON.stringify(network.events);
    expect(serialized).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)/);
    expect((await readdir(directory)).toSorted()).toEqual(["Voice Test", "network.json"]);
  } finally {
    if (running) await running.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("packaged storage lock leaves main commands responsive, then worker crash is recoverable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-worker-fault-"));
  let running: ElectronApplication | undefined;
  let db: DatabaseSync | undefined;
  try {
    const { application, page } = await launch(directory);
    running = application;
    db = new DatabaseSync(join(directory, "Voice Test/settings.sqlite"));
    db.exec("BEGIN IMMEDIATE");
    await page.getByRole("radio", { name: "Dark" }).check();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("button", { name: "Saving…" })).toBeVisible();
    // The actual SQLite worker is blocked, while the main-owned cached command still answers.
    expect(await page.evaluate(() => window.voice.command({ type: "status.get" }))).toMatchObject({
      ok: true,
      settings: { appearance: "light" },
    });
    db.exec("COMMIT");
    db.close();
    db = undefined;
    await expect(page.getByRole("status")).toHaveText("Saved.");
    await application.evaluate(({ app }) => {
      const { storage }: typeof import("../../apps/desktop/src/main/index") = process
        .getBuiltinModule("module")
        .createRequire(app.getAppPath() + "/package.json")("./electron/main.cjs");
      return storage.worker?.terminate();
    });
    await expect(page.getByRole("alert")).toContainText("Settings storage is unavailable.");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("status")).toHaveText("Settings restored.");
    await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(await page.evaluate(() => window.voice.command({ type: "status.get" }))).toMatchObject({
      ok: true,
      status: { capture: expect.stringMatching(/^(available|unavailable)$/), storage: "ready" },
      session: { phase: "idle" },
    });
    const rejected = await page.evaluate(async () => {
      try {
        await Reflect.apply(window.voice.command, null, [
          { type: "settings.set", appearance: "invalid" },
        ]);
        return false;
      } catch {
        return true;
      }
    });
    expect(rejected).toBe(true);
    const unauthorized = await application.evaluate(async ({ BrowserWindow }) => {
      const other = new BrowserWindow({
        show: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
      });
      try {
        await other.loadURL("about:blank");
        return await other.webContents.executeJavaScript(
          "require('electron').ipcRenderer.invoke('voice:command', {type:'settings.get'})",
        );
      } finally {
        other.destroy();
      }
    });
    expect(unauthorized).toEqual({ ok: false, error: "unauthorized" });
  } finally {
    db?.close();
    if (running) await running.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a migration failure never reports storage ready and an explicit repair can retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-migration-fault-"));
  let running: ElectronApplication | undefined;
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(directory, "Voice Test"));
    const filename = join(directory, "Voice Test/settings.sqlite");
    const conflict = new DatabaseSync(filename);
    conflict.exec("CREATE TABLE preferences (unexpected TEXT)");
    conflict.close();
    const env = electronEnvironment();
    running = await electron.launch({
      env,
      executablePath,
      args: [`--voice-test-data=${directory}`, `--log-net-log=${join(directory, "network.json")}`],
    });
    const page = await running.firstWindow();
    await expect(page.getByRole("alert")).toContainText("Settings storage is unavailable.");
    expect(await page.evaluate(() => window.voice.command({ type: "status.get" }))).toMatchObject({
      ok: true,
      status: { storage: "failed", capture: expect.stringMatching(/^(available|unavailable)$/) },
      session: { phase: "idle" },
    });
    await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
    const repair = new DatabaseSync(filename);
    repair.exec("DROP TABLE preferences");
    repair.close();
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("status")).toHaveText("Settings restored.");
  } finally {
    if (running) await running.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("packaged onboarding and Settings persist preferences and manage only an isolated Keychain item", async () => {
  const { createHash, randomUUID } = await import("node:crypto");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execute = promisify(execFile);
  const directory = await mkdtemp(join(tmpdir(), "voice-setup-"));
  const service = `com.codlume.voice.test.${createHash("sha256").update(join(directory, "Voice Test")).digest("hex")}`;
  const readKeychainItem = async () =>
    (
      await execute(
        "/usr/bin/security",
        ["find-generic-password", "-s", service, "-a", "deepgram"],
        { timeout: 5000 },
      )
    ).stdout.trim();
  let running: ElectronApplication | undefined;
  try {
    let { application, page } = await launch(directory);
    running = application;
    await expect(page.getByRole("heading", { name: "Set up your first dictation" })).toBeVisible();
    await page.getByRole("button", { name: "Refresh setup status" }).click();
    await expect(page.getByText("Setup status refreshed.", { exact: true })).toBeVisible();
    const before = await page.evaluate(() => window.voice.command({ type: "status.get" }));
    expect(before).toMatchObject({
      ok: true,
      setup: {
        credential: { presence: "missing", verification: "unverified" },
        provider: "unknown",
      },
      status: { capture: expect.stringMatching(/^(available|unavailable)$/) },
      session: { phase: "idle" },
    });
    expect(before.ok && before.setup?.native).not.toBeNull();
    const key = randomUUID().replaceAll("-", "");
    await page.getByLabel("Deepgram API key", { exact: true }).fill(key);
    await expect(page.getByLabel("Deepgram API key", { exact: true })).toHaveAttribute(
      "type",
      "password",
    );
    await page.getByRole("button", { name: "Add key", exact: true }).click();
    await expect(
      page.getByText("Key saved in Keychain. Access is not verified.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Deepgram API key", { exact: true })).toHaveValue("");
    expect(await readKeychainItem()).toContain(service);
    const replacement = randomUUID().replaceAll("-", "");
    await page.getByLabel("Deepgram API key", { exact: true }).fill(replacement);
    await page.getByRole("button", { name: "Replace key", exact: true }).click();
    await expect(
      page.getByText("Key saved in Keychain. Access is not verified.", { exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => window.voice.command({ type: "status.get" }))).toMatchObject({
      ok: true,
      setup: { credential: { presence: "saved", verification: "unverified" } },
    });
    expect(await readKeychainItem()).toContain(service);
    await page.getByLabel("Hold to talk", { exact: true }).selectOption("Control+Option+Space");
    await page.getByLabel("Toggle dictation", { exact: true }).selectOption("Control+Shift+Space");
    await page.getByRole("button", { name: "Finish setup", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Dictation setup", exact: true })).toBeVisible();
    await shutdown(application);
    running = undefined;
    ({ application, page } = await launch(directory));
    running = application;
    await page.getByRole("button", { name: "Refresh setup status" }).click();
    await expect(page.getByText("Setup status refreshed.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Replace key", exact: true })).toBeVisible();
    expect(await readKeychainItem()).toContain(service);
    await expect(page.getByLabel("Hold to talk", { exact: true })).toHaveValue(
      "Control+Option+Space",
    );
    await expect(page.getByLabel("Toggle dictation", { exact: true })).toHaveValue(
      "Control+Shift+Space",
    );
    await page.getByRole("button", { name: "Remove key", exact: true }).click();
    await expect(page.getByText("Key removed from Keychain.", { exact: true })).toBeVisible();
    await expect(
      execute("/usr/bin/security", ["find-generic-password", "-s", service, "-a", "deepgram"], {
        timeout: 5000,
      }),
    ).rejects.toMatchObject({ code: 44, killed: false });
    const after = await page.evaluate(() => window.voice.command({ type: "status.get" }));
    expect(after).toMatchObject({
      ok: true,
      setup: { credential: { presence: "missing" } },
      status: { capture: expect.stringMatching(/^(available|unavailable)$/) },
      session: { phase: "idle" },
    });
    expect(JSON.stringify(after)).not.toContain(replacement);
    await page.screenshot({ path: "/tmp/voice-29-setup.png", fullPage: true });
    await shutdown(application);
    running = undefined;
    const db = new DatabaseSync(join(directory, "Voice Test/settings.sqlite"));
    try {
      const rows = db.prepare("select * from preferences").all();
      expect(JSON.stringify(rows)).not.toContain(key);
      expect(JSON.stringify(rows)).not.toContain(replacement);
      expect(rows).toHaveLength(1);
    } finally {
      db.close();
    }
  } finally {
    if (running) await running.close();
    // Exact service + account, never a broad Keychain cleanup.
    await execute(
      "/usr/bin/security",
      ["delete-generic-password", "-s", service, "-a", "deepgram"],
      { timeout: 5000 },
    ).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
