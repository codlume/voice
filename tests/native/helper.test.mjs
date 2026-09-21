import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

for (const ending of ["shutdown", "disconnect"]) {
  test(
    `real helper handshakes, cancels without capture, and exits on ${ending}`,
    { timeout: 10_000 },
    async () => {
      const child = spawn(resolve("packages/platform/native/.build/debug/voice-helper"), [], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const lines = createInterface({ input: child.stdout });
      const closed = once(child, "exit");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 8_000);
      async function command(type) {
        const reply = once(lines, "line");
        child.stdin.write(JSON.stringify({ type, version: 1 }) + "\n");
        const [line] = await reply;
        return JSON.parse(line);
      }
      try {
        assert.deepEqual(await command("hello"), {
          type: "ready",
          version: 1,
          capture: "unavailable",
        });
        assert.deepEqual(await command("cancel"), {
          type: "cancelled",
          version: 1,
          capture: "unavailable",
        });
        if (ending === "shutdown")
          assert.deepEqual(await command("shutdown"), {
            type: "stopped",
            version: 1,
            capture: "unavailable",
          });
        else child.stdin.end();
        assert.deepEqual(await closed, [0, null]);
        assert.throws(() => process.kill(child.pid, 0));
      } finally {
        clearTimeout(timeout);
        lines.close();
        if (child.exitCode === null) {
          child.kill("SIGKILL");
          await closed;
        }
      }
    },
  );
}
