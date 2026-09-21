import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const directory = await mkdtemp(join(tmpdir(), "voice-dev-check-"));
const child = fork("scripts/dev.mjs", [`--voice-test-data=${directory}`], {
  stdio: ["inherit", "inherit", "inherit", "ipc"],
});
const closed = once(child, "exit");
const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
try {
  const [ready] = await Promise.race([
    once(child, "message"),
    closed.then(() => {
      throw new Error("Development exited before readiness");
    }),
  ]);
  assert.equal(ready.type, "ready");
  assert.equal(ready.capture, "unavailable");
  const response = await fetch(ready.url);
  assert.equal(response.status, 200);
  await response.text();
  child.kill("SIGTERM");
  const [code, signal] = await closed;
  assert.equal(signal, null);
  assert.ok(code === 0 || code === 143, `Unexpected development exit: ${code}`);
  for (const pid of [ready.pid, ready.helperPid]) assert.throws(() => process.kill(pid, 0));
  await assert.rejects(fetch(ready.url));
  console.log("Development readiness and owned-process/server teardown passed.");
} finally {
  clearTimeout(timeout);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await closed;
  }
  await rm(directory, { recursive: true, force: true });
}
