import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { models as registry } from "../apps/desktop/src/shared/models.ts";
import { modelsDir } from "../native/voice-helper/scripts/helper.mjs";
import {
  assert,
  launchVoice,
  modelFiles,
  Page,
  prepareUserData,
  stopChildren,
  stopChildrenOnSignal,
} from "./voice-app.mjs";

const port = 9341;
const shots = process.env.VOICE_SMOKE_SHOTS ?? "/tmp/voice-models-smoke";
const names = Object.fromEntries(registry.map((model) => [model.id, model.name]));

const note = (message) => console.error(`[models-smoke] ${message}`);
const linked = (path) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

stopChildrenOnSignal();
const cache = modelsDir();
const userData = await prepareUserData("voice-models-smoke");
const models = join(userData, "models");
const { child } = launchVoice(userData, { port });

try {
  const page = await Page.connect(port, "hub.html");
  const snapshot = () => page.evaluate("window.voice.getSnapshot()");
  const until = async (predicate, label, timeoutMs = 180_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = await snapshot();
      if (predicate(s.models)) return s;
      await wait(200);
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify((await snapshot()).models)}`);
  };
  const click = (find) =>
    page.evaluate(
      `(() => { const el = ${find}; if (!el) throw new Error("missing element"); el.click(); return true })()`,
    );
  const button = (label) => `document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)})`;
  const navButton = (text) =>
    `[...document.querySelectorAll("aside button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;
  const mainText = () => page.evaluate("document.querySelector('main').innerText");
  const shot = async (name) => {
    const { data } = await page.call("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${shots}-${name}.png`, Buffer.from(data, "base64"));
  };
  const answerDialog = async (choice) => {
    const script = `tell application "System Events" to tell (first process whose unix id is ${child.pid})
      repeat with w in windows
        if (count of sheets of w) > 0 then
          click button "${choice}" of sheet 1 of w
          return "ok"
        end if
      end repeat
      return "none"
    end tell`;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (execFileSync("osascript", ["-e", script], { encoding: "utf8" }).trim() === "ok") return;
      await wait(100);
    }
    throw new Error(`no confirmation sheet to answer ${choice}`);
  };
  const installed = (state) => state === "ready" || state === "installed";

  await until((m) => m.asr.state === "ready" && installed(m.cleanup.state), "both models loaded");
  await click(button("Settings"));
  await click(navButton("Models"));
  await wait(300);
  assert((await mainText()).includes("Speech recognition"), "Models page renders");
  await shot("installed");

  await page.evaluate("window.voice.updateSettings({ cleanup: { enabled: false } })");
  await until((m) => m.cleanup.state === "installed", "cleanup off reports installed");
  await wait(300);
  assert((await mainText()).includes("Loads when text cleanup is on"), "cleanup-off row text");
  await shot("cleanup-off");
  await page.evaluate("window.voice.updateSettings({ cleanup: { enabled: true } })");
  await until((m) => m.cleanup.state === "ready", "cleanup on loads again");
  note("cleanup off unloads, on reloads");

  await click(button(`Uninstall ${names.cleanup}`));
  await answerDialog("Cancel");
  await wait(1000);
  assert(installed((await snapshot()).models.cleanup.state), "Cancel keeps the cleanup model");
  assert(linked(join(models, modelFiles.cleanup)), "Cancel keeps the cleanup file");
  note("cancel keeps the model");

  for (const id of ["cleanup", "asr"]) {
    await click(button(`Uninstall ${names[id]}`));
    await answerDialog("Uninstall");
    await until((m) => m[id].state === "missing", `${id} missing`);
    assert(!linked(join(models, modelFiles[id])), `${id} link removed`);
    assert(existsSync(join(cache, modelFiles[id])), `${id} cache left intact`);
    note(`${id} uninstalled, cache intact`);
  }
  const uninstalledText = await mainText();
  assert(uninstalledText.split("Not installed").length === 3, "both rows say Not installed");
  await shot("uninstalled");

  await click(navButton("Back"));
  await wait(300);
  assert((await mainText()).includes("Not downloaded"), "Home checklist offers the download");
  await shot("home-uninstalled");
  await click(button("Settings"));
  await click(navButton("Models"));

  for (const id of ["cleanup", "asr"])
    symlinkSync(join(cache, modelFiles[id]), join(models, modelFiles[id]));
  for (const id of ["cleanup", "asr"]) {
    await click(button(`Install ${names[id]}`));
    await until(
      (m) => (id === "asr" ? m.asr.state === "ready" : installed(m.cleanup.state)),
      `${id} reinstalled`,
    );
    note(`${id} reinstalled`);
  }
  await wait(300);
  assert(!(await mainText()).includes("Not installed"), "both rows installed again");
  await shot("reinstalled");
  page.close();
  note("ok");
} finally {
  await stopChildren();
  rmSync(userData, { recursive: true, force: true });
}
