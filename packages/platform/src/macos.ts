import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Schema } from "effect";
import { decodeNativeReply } from "@voice/contracts/native";
import {
  NativeSetupResult,
  decodeNativeSetupCommand,
  type NativeSetupCommand,
} from "@voice/contracts/setup";

const decodeResult = Schema.decodeUnknownSync(
  Schema.Struct({
    type: Schema.Literal("setup.result"),
    version: Schema.Literal(1),
    id: Schema.Number,
    result: NativeSetupResult,
  }),
  { onExcessProperty: "error" },
);

export function launchHelper(executable: string, failed: () => void, testKeychainService?: string) {
  const child = spawn(executable, [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      VOICE_TEST_KEYCHAIN_SERVICE: testKeychainService ?? "",
    },
  });
  const lines = createInterface({ input: child.stdout });
  let shuttingDown = false;
  let exited = false;
  let broken = false;
  let nextId = 0;
  const requests = new Map<
    number,
    {
      resolve: (result: typeof NativeSetupResult.Type) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => {
      exited = true;
      resolve();
    }),
  );
  const {
    promise: ready,
    resolve: resolveReady,
    reject: rejectReady,
  } = Promise.withResolvers<void>();
  const fail = () => {
    clearTimeout(timeout);
    broken = true;
    const error = new Error("native-unavailable");
    rejectReady(error);
    for (const request of requests.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    requests.clear();
    if (!shuttingDown) failed();
  };
  const timeout = setTimeout(fail, 10_000);
  child.once("error", fail);
  child.stdin.on("error", fail);
  child.once("close", fail);
  // Drain diagnostics without retaining or forwarding potentially sensitive OS output.
  child.stderr.resume();
  lines.on("line", (line) => {
    try {
      const value: unknown = JSON.parse(line);
      if (
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        value.type === "setup.result"
      ) {
        const reply = decodeResult(value);
        const pending = requests.get(reply.id);
        if (pending) {
          requests.delete(reply.id);
          clearTimeout(pending.timeout);
          pending.resolve(reply.result);
        }
      } else {
        const reply = decodeNativeReply(value);
        if (reply.type === "ready") {
          clearTimeout(timeout);
          resolveReady();
        }
        if (reply.type === "rejected") fail();
      }
    } catch {
      fail();
    }
  });
  child.stdin.write(JSON.stringify({ type: "hello", version: 1 }) + "\n");
  return {
    child,
    ready,
    async request(input: NativeSetupCommand): Promise<typeof NativeSetupResult.Type> {
      const command = decodeNativeSetupCommand(input);
      await ready;
      if (broken || shuttingDown) throw new Error("native-unavailable");
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const requestTimeout = setTimeout(
          () => {
            // A timed-out mutation has unknown outcome. Retire the helper rather than accept late writes.
            fail();
            child.kill("SIGTERM");
          },
          command.type === "permission.request" ? 120_000 : 10_000,
        );
        requests.set(id, { resolve, reject, timeout: requestTimeout });
        child.stdin.write(
          JSON.stringify({ type: "setup.request", version: 1, id, command }) + "\n",
        );
      });
    },
    async close() {
      shuttingDown = true;
      fail();
      if (exited) return;
      child.stdin.end(JSON.stringify({ type: "shutdown", version: 1 }) + "\n");
      const killTimeout = setTimeout(() => child.kill("SIGKILL"), 2_000);
      try {
        await closed;
      } finally {
        clearTimeout(killTimeout);
        lines.close();
      }
    },
  };
}
