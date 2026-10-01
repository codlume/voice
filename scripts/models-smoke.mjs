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
  snapshotStream,
  stopChildren,
  stopChildrenOnSignal,
} from "./voice-app.mjs";

const port = 9341;
const shots = process.env.VOICE_SMOKE_SHOTS;
const names = Object.fromEntries(registry.map((model) => [model.id, model.name]));

const note = (message) => console.error(`[models-smoke] ${message}`);
const linked = (path) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

stopChildrenOnSignal();
const cache = modelsDir();
const userData = await prepareUserData("voice-models-smoke");
const models = join(userData, "models");
const { child } = launchVoice(userData, { port });

try {
  const page = await Page.connect(port, "hub.html");
  const snapshots = await snapshotStream(page);
  const untilModels = (predicate, label) =>
    snapshots
      .waitFor((s) => predicate(s.models), { timeoutMs: 180_000, label })
      .catch((error) => {
        throw new Error(`${error.message}: ${JSON.stringify(snapshots.items.at(-1)?.models)}`);
      });
  // Rechecks `condition`, a page expression, after every DOM change until it holds.
  const untilPage = async (condition, label) => {
    const met = await page.evaluate(`new Promise((resolve) => {
      const observer = new MutationObserver(() => check());
      const timer = setTimeout(() => done(false), 10000);
      const done = (value) => { observer.disconnect(); clearTimeout(timer); resolve(value); };
      const check = () => { if (${condition}) done(true); };
      observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
      check();
    })`);
    assert(met, label);
  };
  const button = (label) =>
    `document.querySelector(${JSON.stringify(`button[aria-label="${label}"]`)})`;
  const navButton = (text) =>
    `[...document.querySelectorAll("aside button")].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;
  const enabled = (find) => `(${find})?.disabled === false`;
  const click = (find, label) =>
    untilPage(
      `(() => { const el = ${find}; if (el?.disabled !== false) return false; el.click(); return true; })()`,
      label,
    );
  const mainText = "document.querySelector('main').innerText";
  const shot = async (name) => {
    if (!shots) return;
    const { data } = await page.call("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${shots}-${name}.png`, Buffer.from(data, "base64"));
  };
  const answerDialog = (choice) => {
    const script = `tell application "System Events" to tell (first process whose unix id is ${child.pid})
      repeat 50 times
        repeat with w in windows
          if (count of sheets of w) > 0 then
            click button "${choice}" of sheet 1 of w
            return "ok"
          end if
        end repeat
        delay 0.1
      end repeat
      return "none"
    end tell`;
    const answered = execFileSync("osascript", ["-e", script], { encoding: "utf8" }).trim();
    assert(answered === "ok", `no confirmation sheet to answer ${choice}`);
  };
  // Install reports 0% before it checks the file on disk, so any other download status is a fetch.
  const fetching = (status) => status.state === "downloading" && status.progress !== 0;

  await untilModels(
    (m) => m.asr.state === "ready" && m.cleanup.state === "ready",
    "both models loaded",
  );
  await click(button("Settings"), "Settings opens");
  await click(navButton("Models"), "Models page opens");
  await untilPage(`${mainText}.includes("Speech recognition")`, "Models page renders");
  await shot("installed");

  await page.evaluate("window.voice.updateSettings({ cleanup: { enabled: false } })");
  await untilModels((m) => m.cleanup.state === "installed", "cleanup off reports installed");
  await untilPage(`${mainText}.includes("Loads when text cleanup is on")`, "cleanup-off row text");
  await shot("cleanup-off");
  await page.evaluate("window.voice.updateSettings({ cleanup: { enabled: true } })");
  await untilModels((m) => m.cleanup.state === "ready", "cleanup on loads again");
  note("cleanup off unloads, on reloads");

  const uninstallCleanup = button(`Uninstall ${names.cleanup}`);
  const beforeCancel = snapshots.items.length;
  await click(uninstallCleanup, "cleanup Uninstall clickable");
  answerDialog("Cancel");
  await untilPage(enabled(uninstallCleanup), "cancelled uninstall settles");
  const afterCancel = await page.evaluate("window.voice.getSnapshot()");
  assert(
    [...snapshots.items.slice(beforeCancel), afterCancel].every(
      (s) => s.models.cleanup.state === "ready",
    ),
    "Cancel keeps the cleanup model loaded",
  );
  assert(linked(join(models, modelFiles.cleanup)), "Cancel keeps the cleanup file");
  note("cancel keeps the model");

  for (const id of ["cleanup", "asr"]) {
    await click(button(`Uninstall ${names[id]}`), `${id} Uninstall clickable`);
    answerDialog("Uninstall");
    await untilModels((m) => m[id].state === "missing", `${id} missing`);
    assert(!linked(join(models, modelFiles[id])), `${id} link removed`);
    assert(existsSync(join(cache, modelFiles[id])), `${id} cache left intact`);
    note(`${id} uninstalled, cache intact`);
  }
  await untilPage(`${mainText}.split("Not installed").length === 3`, "both rows say Not installed");
  await shot("uninstalled");

  await click(navButton("Back"), "Back clickable");
  await untilPage(`${mainText}.includes("Not downloaded")`, "Home checklist offers the download");
  await shot("home-uninstalled");
  await click(button("Settings"), "Settings opens again");
  await click(navButton("Models"), "Models page opens again");

  for (const id of ["cleanup", "asr"])
    symlinkSync(join(cache, modelFiles[id]), join(models, modelFiles[id]));
  for (const id of ["cleanup", "asr"]) {
    await click(button(`Install ${names[id]}`), `${id} Install clickable`);
    const { models: settled } = await untilModels(
      (m) => ["ready", "installed", "failed"].includes(m[id].state) || fetching(m[id]),
      `${id} reinstalled`,
    );
    assert(
      settled[id].state === "ready",
      `${id} loads again from the linked file, without a download: ${JSON.stringify(settled[id])}`,
    );
    note(`${id} reinstalled`);
  }
  await untilPage(`!${mainText}.includes("Not installed")`, "both rows installed again");
  await shot("reinstalled");
  page.close();
  note("ok");
} finally {
  await stopChildren();
  rmSync(userData, { recursive: true, force: true });
}
