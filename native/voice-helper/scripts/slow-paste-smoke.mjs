import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

import {
  assert,
  dictateFixture,
  helperBinary,
  prepareAsr,
  refuseIfVoiceIsRunning,
  withHelper,
} from "./helper.mjs";

const busyMs = Number(process.argv[2]);
assert(
  Number.isInteger(busyMs) && busyMs >= 0,
  `usage: slow-paste-smoke.mjs <busyMs> (got ${process.argv[2]})`,
);
refuseIfVoiceIsRunning();

const transcript = `Voice slow paste transcript ${randomUUID()}`;

const target = spawn(helperBinary("slow-paste-target"), [], {
  stdio: ["pipe", "pipe", "inherit"],
});
const targetExited = new Promise((resolve) => target.once("exit", resolve));
const targetEvents = [];
let wake = () => {};
createInterface({ input: target.stdout }).on("line", (line) => {
  console.error(`<< target ${line}`);
  targetEvents.push(JSON.parse(line));
  wake();
});
const tell = (command) => target.stdin.write(`${command}\n`);
function waitTarget(name, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wake = () => {};
      resolve(null);
    }, timeoutMs);
    wake = () => {
      const index = targetEvents.findIndex((event) => event.event === name);
      if (index < 0) return;
      clearTimeout(timer);
      wake = () => {};
      resolve(targetEvents.splice(index, 1)[0]);
    };
    wake();
  });
}

async function activateTarget() {
  tell("activate");
  const activated = await waitTarget("activated");
  assert(activated?.frontmost, `target is not frontmost: ${JSON.stringify(activated)}`);
}

try {
  const ready = await waitTarget("ready");
  assert(ready, "target never became ready");

  const env = busyMs === 0 ? { VOICE_HELPER_FORCE_RECOVERY: "1" } : {};
  await withHelper({ env }, async (helper) => {
    await prepareAsr(helper);
    await activateTarget();
    const id = `slow-paste-${busyMs}`;
    await dictateFixture(helper, "silence.wav", id);
    await activateTarget();
    tell(`busy ${busyMs}`);
    assert(await waitTarget("busyStart"), "target never reported busyStart");

    const insertAt = Date.now();
    helper.send({ type: "insert", id, text: transcript });
    const result = await helper.waitFor(
      (event) => event.type === "insert.result" && event.id === id,
      { label: "insert.result" },
    );
    const resultAt = Date.now();
    const resultMs = resultAt - insertAt;
    assert(
      result.method === "none" && result.reason === "failed" && resultMs < 5_000,
      `expected none/failed under 5000 ms, got ${result.method}/${result.reason ?? ""} at +${resultMs} ms`,
    );

    const exit = await helper.close();
    assert(exit.code === 0, `helper exited with ${exit.code ?? exit.signal}`);
    assert(await waitTarget("busyEnd", busyMs + 3_000), "target never reported busyEnd");
    tell("state");
    const state = await waitTarget("state");
    assert(state, "target never reported its state after draining queued events");
    assert(
      state.pasteAttempts === 0,
      `target handled ${state.pasteAttempts} unexpected paste attempts`,
    );
    assert(state.targetIsEmpty, "target changed after insertion was refused");
    assert(
      state.changeCount === ready.changeCount,
      `clipboard changeCount changed ${ready.changeCount} -> ${state.changeCount}`,
    );

    console.log(
      JSON.stringify({
        busyMs,
        method: result.method,
        reason: result.reason,
        resultMs,
        pasteAttempts: state.pasteAttempts,
        targetIsEmpty: state.targetIsEmpty,
        clipboardUnchanged: true,
        helperShutdownChecked: true,
      }),
    );
  });
} finally {
  if (target.exitCode === null && target.signalCode === null) {
    tell("quit");
    const quit = await waitTarget("quit", busyMs + 3_000);
    if (!quit) target.kill("SIGKILL");
  }
  await targetExited;
}
