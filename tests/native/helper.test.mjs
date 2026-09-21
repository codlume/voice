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

test(
  "setup protocol reads native status without capture and rejects unvalidated operations",
  { timeout: 10000 },
  async () => {
    const child = spawn(resolve("packages/platform/native/.build/debug/voice-helper"), [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    const closed = once(child, "exit");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
    const send = async (payload) => {
      const response = once(lines, "line");
      child.stdin.write(JSON.stringify(payload) + "\n");
      return JSON.parse((await response)[0]);
    };
    try {
      await send({ type: "hello", version: 1 });
      const reply = await send({
        type: "setup.request",
        version: 1,
        id: 1,
        command: {
          type: "setup.status",
          shortcuts: { hold: "Fn", toggle: "Fn+Space", cancel: "Escape" },
        },
      });
      assert.equal(reply.type, "setup.result");
      assert.equal(reply.result.type, "setup");
      assert.ok(Array.isArray(reply.result.status.devices));
      assert.deepEqual(Object.keys(reply.result.status.permissions).toSorted(), [
        "accessibility",
        "inputMonitoring",
        "microphone",
      ]);
      const conflict = await send({
        type: "setup.request",
        version: 1,
        id: 3,
        command: {
          type: "setup.status",
          shortcuts: { hold: "Fn", toggle: "Fn", cancel: "Escape" },
        },
      });
      assert.equal(conflict.result.status.shortcuts.hold, "conflict");
      assert.equal(conflict.result.status.shortcuts.toggle, "conflict");
      const invalidPermission = await send({
        type: "setup.request",
        version: 1,
        id: 4,
        command: { type: "permission.request", permission: "screen" },
      });
      assert.deepEqual(invalidPermission.result, { type: "error", error: "invalid-command" });
      const invalid = await send({
        type: "setup.request",
        version: 1,
        id: 2,
        command: { type: "credential.remove", service: "unrelated" },
      });
      assert.deepEqual(invalid.result, { type: "error", error: "invalid-command" });
      await send({ type: "shutdown", version: 1 });
      await closed;
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

for (const ending of ["stop", "cancel", "disconnect"]) {
  test(
    `controlled native capture emits ordered nonempty PCM and ends on ${ending}`,
    { timeout: 10_000 },
    async () => {
      const child = spawn(resolve("packages/platform/native/.build/debug/voice-helper"), [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          VOICE_TEST_KEYCHAIN_SERVICE: "com.codlume.voice.test.capture",
          VOICE_TEST_CAPTURE: "synthetic",
        },
      });
      const lines = createInterface({ input: child.stdout });
      const closed = once(child, "exit");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 8_000);
      const events = [];
      const firstFrames = Promise.withResolvers();
      const stopped = Promise.withResolvers();
      lines.on("line", (line) => {
        const event = JSON.parse(line);
        events.push(event);
        if (event.type === "capture.frame" && event.sequence === 4) firstFrames.resolve();
        if (event.type === "capture.stopped") stopped.resolve(event);
      });
      const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
      try {
        const ready = once(lines, "line");
        send({ type: "hello", version: 1 });
        await ready;
        assert.equal(
          events.some((event) => event.type === "capture.frame"),
          false,
        );
        send({ type: "capture.start", session: "synthetic", attempt: "one", device: null });
        await firstFrames.promise;
        if (ending === "disconnect") child.stdin.end();
        else send({ type: `capture.${ending}`, session: "synthetic", attempt: "one" });
        const result = await stopped.promise;
        const frames = events.filter((event) => event.type === "capture.frame");
        assert.deepEqual(
          frames.map((frame) => frame.sequence),
          frames.map((_, index) => index),
        );
        assert.equal(result.frames, frames.length);
        assert.equal(
          result.samples,
          frames.reduce((count, frame) => count + Buffer.from(frame.pcm, "base64").length / 2, 0),
        );
        assert.ok(Buffer.from(frames[0].pcm, "base64").some((byte) => byte !== 0));
        if (ending !== "disconnect") send({ type: "shutdown", version: 1 });
        await closed;
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

test(
  "native 48 kHz conversion drains the final impulse before stopped totals",
  { timeout: 10_000 },
  async () => {
    const child = spawn(resolve("packages/platform/native/.build/debug/voice-helper"), [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        VOICE_TEST_KEYCHAIN_SERVICE: "com.codlume.voice.test.resampling",
        VOICE_TEST_CAPTURE: "synthetic",
        VOICE_TEST_SAMPLE_RATE: "48000",
      },
    });
    const lines = createInterface({ input: child.stdout });
    const closed = once(child, "exit");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
    const stopped = Promise.withResolvers();
    const frames = [];
    lines.on("line", (line) => {
      const event = JSON.parse(line);
      if (event.type === "capture.frame") frames.push(Buffer.from(event.pcm, "base64"));
      if (event.type === "capture.stopped") stopped.resolve(event);
    });
    const send = (payload) => child.stdin.write(JSON.stringify(payload) + "\n");
    try {
      const ready = once(lines, "line");
      send({ type: "hello", version: 1 });
      await ready;
      send({ type: "capture.start", session: "resampling", attempt: "one", device: null });
      const result = await stopped.promise;
      const pcm = Buffer.concat(frames);
      // Ten 1024-sample buffers produce 3413 samples before EOS. The last impulse still
      // has nonzero filter output in the tail; merely matching emitted frame totals loses it.
      assert.ok(result.samples > 3413);
      assert.equal(result.samples, pcm.length / 2);
      assert.ok(pcm.subarray(3413 * 2).some((byte) => byte !== 0));
      send({ type: "shutdown", version: 1 });
      await closed;
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
