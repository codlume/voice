import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";

for (const { name, signal, ignoreTermination } of [
  { name: "SIGINT stops the native build", signal: "SIGINT" },
  { name: "SIGTERM stops the native build", signal: "SIGTERM" },
  {
    name: "shutdown kills an unresponsive native build",
    signal: "SIGTERM",
    ignoreTermination: true,
  },
  { name: "native build failure exits unsuccessfully" },
]) {
  test(name, async () => {
    const directory = await mkdtemp(join(tmpdir(), "voice-dev-startup-"));
    let child;
    let buildPid;
    let closed;
    let lines;
    const watchdog = setTimeout(() => child?.kill("SIGKILL"), 10_000);
    try {
      await writeFile(
        join(directory, "swift"),
        `#!/usr/bin/env node
${ignoreTermination ? 'process.on("SIGTERM", () => {});' : ""}
// Simulate Electron's first-use setup log without downloading anything.
console.log("Downloading Electron binary...");
process.stdout.write("voice-test-native-ready:" + process.pid + "\\n");
${signal ? "setInterval(() => {}, 1000);" : "process.exit(42);"}
`,
        { mode: 0o755 },
      );
      child = spawn(process.execPath, ["scripts/dev.mjs"], {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          // Keep the CI color environment in the regression path.
          FORCE_COLOR: "1",
          NO_COLOR: undefined,
        },
        stdio: ["ignore", "pipe", "inherit"],
      });
      closed = once(child, "exit");
      lines = createInterface({ input: child.stdout });
      const ready = new Promise((resolve) => {
        lines.on("line", (line) => {
          const match = /^voice-test-native-ready:(\d+)$/.exec(line);
          if (match) resolve(Number(match[1]));
        });
      });
      buildPid = await Promise.race([
        ready,
        closed.then(() => {
          throw new Error("Development exited before the build started");
        }),
      ]);
      assert.ok(
        Number.isInteger(buildPid) && buildPid > 0,
        `Expected a native build PID, received ${buildPid}`,
      );
      if (signal) child.kill(signal);
      const [code, exitSignal] = await closed;
      assert.equal(exitSignal, null);
      assert.equal(code, signal ? 0 : 1);
      assert.throws(() => process.kill(buildPid, 0), "Native build survived development shutdown");
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await closed;
      }
      if (buildPid) {
        try {
          process.kill(buildPid, "SIGKILL");
        } catch {}
      }
      clearTimeout(watchdog);
      lines?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
