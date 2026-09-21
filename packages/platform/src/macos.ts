import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { decodeNativeReply } from "@voice/contracts/native";

export function launchHelper(executable: string, failed: () => void) {
  const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  let shuttingDown = false;
  let exited = false;
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => {
      exited = true;
      resolve();
    }),
  );
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => fail(), 10_000);
    const fail = () => {
      clearTimeout(timeout);
      reject(new Error("Native helper unavailable"));
      if (!shuttingDown) failed();
    };
    child.once("error", fail);
    child.stdin.on("error", fail);
    child.once("close", fail);
    lines.on("line", (line) => {
      try {
        const reply = decodeNativeReply(JSON.parse(line));
        if (reply.type === "ready") {
          clearTimeout(timeout);
          resolve();
        }
        if (reply.type === "rejected") fail();
      } catch {
        fail();
      }
    });
    child.stdin.write(JSON.stringify({ type: "hello", version: 1 }) + "\n");
  });
  return {
    child,
    ready,
    async close() {
      shuttingDown = true;
      if (exited) return;
      child.stdin.end(JSON.stringify({ type: "shutdown", version: 1 }) + "\n");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 2_000);
      try {
        await closed;
      } finally {
        clearTimeout(timeout);
        lines.close();
      }
    },
  };
}
