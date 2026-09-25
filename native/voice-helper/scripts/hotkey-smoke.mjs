import { execFileSync } from "node:child_process";

import { assert, helperBinary, withHelper } from "./helper.mjs";

const key = process.argv[2] ?? "fn";

await withHelper({}, async (helper) => {
  await helper.waitFor(
    (event) => event.type === "log" && event.message === "hotkey tap installed",
    {
      label: "hotkey tap installed",
    },
  );
  if (key !== "fn") helper.send({ type: "hotkey.configure", key });
  const before = helper.events.length;
  execFileSync(helperBinary("fnpost"), [key], { stdio: "inherit" });
  const down = await helper.waitForType("hotkey", { timeoutMs: 3_000, label: "hotkey down" });
  assert(down.action === "down", `first hotkey action is ${down.action}`);
  const up = await helper.waitForType("hotkey", { timeoutMs: 3_000, label: "hotkey up" });
  assert(up.action === "up", `second hotkey action is ${up.action}`);
  const hotkeys = helper.eventsSince(before).filter((event) => event.type === "hotkey");
  assert(
    hotkeys.length === 2,
    `expected exactly two hotkey events, got ${JSON.stringify(hotkeys)}`,
  );
  console.log(JSON.stringify({ key, actions: hotkeys.map((event) => event.action) }));
});
