import { execFileSync } from "node:child_process";

import { assert, helperBinary, refuseIfVoiceIsRunning, withHelper } from "./helper.mjs";

refuseIfVoiceIsRunning();
const key = process.argv[2] ?? "fn";
const mode = process.argv[3] ?? "hold";
assert(mode === "hold" || mode === "toggle", `mode is ${mode}, expected hold or toggle`);

await withHelper({}, async (helper) => {
  await helper.waitFor(
    (event) => event.type === "log" && event.message === "hotkey tap installed",
    {
      label: "hotkey tap installed",
    },
  );
  if (mode === "toggle") {
    const holdKey = key === "fn" ? "rightOption" : "fn";
    helper.send({ type: "hotkey.configure", key: holdKey, toggleKey: key });
  } else if (key !== "fn") {
    helper.send({ type: "hotkey.configure", key, toggleKey: null });
  }
  const before = helper.events.length;
  execFileSync(helperBinary("fnpost"), [key], { stdio: "inherit" });
  const down = await helper.waitForType("hotkey", { timeoutMs: 3_000, label: "hotkey down" });
  assert(down.action === "down", `first hotkey action is ${down.action}`);
  const up = await helper.waitForType("hotkey", { timeoutMs: 3_000, label: "hotkey up" });
  assert(up.action === "up", `second hotkey action is ${up.action}`);
  const hotkeys = helper.eventsSince(before).filter((event) => event.type === "hotkey");
  assert(
    hotkeys.length === 2 && hotkeys.every((event) => event.mode === mode),
    `expected exactly two hotkey events, got ${JSON.stringify(hotkeys)}`,
  );
  console.log(JSON.stringify({ key, mode, actions: hotkeys.map((event) => event.action) }));
});
