import {
  decodeBarPointerEvent,
  decodeCaptureCommand,
  decodeCaptureEvent,
  decodeShortcutEvent,
  decodeTargetSelected,
  type BarPointerEvent,
  type CaptureCommand,
  type CaptureEvent,
  type ShortcutEvent,
  type TargetSelected,
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
  options: {
    testKeychainService?: string;
    syntheticCapture?: boolean;
    // Isolated live acceptance only: synthetic capture reads the real key from the test Keychain.
    testCredential?: boolean;
    captureEvent?: (event: CaptureEvent) => void;
    shortcut?: (event: ShortcutEvent) => void;
    barPointer?: (event: BarPointerEvent) => void;
    targetSelected?: (event: TargetSelected) => void;
  } = {},
) {
  const { testKeychainService, captureEvent } = options;
  const child = spawn(executable, [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      VOICE_TEST_KEYCHAIN_SERVICE: testKeychainService ?? "",
      VOICE_TEST_CAPTURE: testKeychainService && options.syntheticCapture ? "synthetic" : "",
      VOICE_TEST_CREDENTIAL: testKeychainService && options.testCredential ? "keychain" : "",
    },
  });
  const lines = createInterface({ input: child.stdout });
  let shuttingDown = false;
  let exited = false;
  let broken = false;
  let nextId = 0;
  let captureStopTimer: ReturnType<typeof setTimeout> | undefined;
  let captureIdentity: { session: string; attempt: string } | undefined;
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
    clearTimeout(captureStopTimer);
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
        const event = decodeCaptureEvent(value);
        if (
          event.type !== "capture.frame" &&
          captureIdentity?.session === event.session &&
          captureIdentity.attempt === event.attempt
        ) {
          clearTimeout(captureStopTimer);
          captureStopTimer = undefined;
          captureIdentity = undefined;
        }
        captureEvent?.(event);
      } else if (
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        value.type === "shortcut"
      ) {
        options.shortcut?.(decodeShortcutEvent(value));
      } else if (
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        value.type === "bar.pointer"
      ) {
        options.barPointer?.(decodeBarPointerEvent(value));
      } else if (
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        value.type === "target.selected"
      ) {
        options.targetSelected?.(decodeTargetSelected(value));
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
      const command = decodeCaptureCommand(input);
      if (command.type === "capture.start") {
        if (captureIdentity) throw new Error("native-unavailable");
        captureIdentity = { session: command.session, attempt: command.attempt };
      } else if (
        captureIdentity?.session === command.session &&
        captureIdentity.attempt === command.attempt
      ) {
        captureStopTimer ??= setTimeout(fail, 3_000);
      }
      child.stdin.write(JSON.stringify(command) + "\n");
    },
    // Isolated synthetic capture only: makes the running capture fail as a lost input device or a
    // revoked microphone permission would, through the helper's real stop path.
    simulateCaptureFailure(failure: "device" | "permission") {
      if (broken || shuttingDown || !testKeychainService || !options.syntheticCapture) return;
      child.stdin.write(JSON.stringify({ type: "capture.simulate", failure }) + "\n");
    },
    // Isolated synthetic capture only: later captures play this 16 kHz mono PCM16 WAV at real
    // time and then silence, or the default tone when null. A refused file fails the next start.
    captureSource(path: string | null) {
      if (broken || shuttingDown || !testKeychainService || !options.syntheticCapture) return;
      child.stdin.write(JSON.stringify({ type: "capture.source", path }) + "\n");
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
