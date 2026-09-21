import {
  decodeCaptureCommand,
  decodeCaptureEvent,
  type CaptureCommand,
  type CaptureEvent,
} from "@voice/contracts/session";
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

export function launchHelper(
  executable: string,
  failed: () => void,
  testKeychainService?: string,
  captureEvent?: (event: CaptureEvent) => void,
  syntheticCapture = false,
) {
  const child = spawn(executable, [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      VOICE_TEST_KEYCHAIN_SERVICE: testKeychainService ?? "",
      VOICE_TEST_CAPTURE: testKeychainService && syntheticCapture ? "synthetic" : "",
    },
  });
  const lines = createInterface({ input: child.stdout });
  let shuttingDown = false;
  let exited = false;
  let broken = false;
  let nextId = 0;
  const secrets = new Map<
    number,
    {
      resolve: (key: string) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  const decodeSecret = Schema.decodeUnknownSync(
    Schema.Struct({
      type: Schema.Literal("credential.secret"),
      id: Schema.Number,
      key: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
    }),
    { onExcessProperty: "error" },
  );
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
    if (broken) return;
    clearTimeout(timeout);
    broken = true;
    const error = new Error("native-unavailable");
    rejectReady(error);
    for (const request of requests.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    requests.clear();
    for (const request of secrets.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    secrets.clear();
    if (!shuttingDown) {
      child.kill("SIGTERM");
      failed();
    }
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
        typeof value.type === "string" &&
        value.type.startsWith("capture.")
      ) {
        captureEvent?.(decodeCaptureEvent(value));
      } else if (
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        value.type === "credential.secret"
      ) {
        const reply = decodeSecret(value);
        const pending = secrets.get(reply.id);
        if (pending) {
          secrets.delete(reply.id);
          clearTimeout(pending.timeout);
          if (reply.key) pending.resolve(reply.key);
          else pending.reject(new Error("keychain-unavailable"));
        }
      } else if (
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
    capture(input: CaptureCommand) {
      if (broken || shuttingDown) throw new Error("native-unavailable");
      child.stdin.write(JSON.stringify(decodeCaptureCommand(input)) + "\n");
    },
    async credential(): Promise<string> {
      await ready;
      if (broken || shuttingDown) throw new Error("native-unavailable");
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const secretTimeout = setTimeout(() => {
          secrets.delete(id);
          reject(new Error("keychain-unavailable"));
        }, 3_000);
        secrets.set(id, { resolve, reject, timeout: secretTimeout });
        child.stdin.write(JSON.stringify({ type: "credential.read", id }) + "\n");
      });
    },
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
          command.type === "permission.request" ||
            command.type === "credential.set" ||
            command.type === "credential.remove"
            ? 120_000
            : 10_000,
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
