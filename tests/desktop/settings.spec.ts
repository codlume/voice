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
  await expect
    .poll(() => page.evaluate(() => window.voice.command({ type: "status.get" })))
    .toMatchObject({
      ok: true,
      status: { helper: "ready", storage: "ready", capture: "unavailable" },
    });
  return { application, page };
}
async function shutdown(application: ElectronApplication) {
  const pid = application.process().pid;
  await application.close();
  if (pid) expect(() => process.kill(pid, 0)).toThrow();
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
    ).toEqual({ keys: ["command", "onChanged"], node: "undefined" });
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
    expect(saved.migrations).toHaveLength(1);
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
      status: { capture: "unavailable", storage: "ready" },
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
      status: { storage: "failed", capture: "unavailable" },
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
