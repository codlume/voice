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

test(
  "shortcut translation emits one action per transition and consumes only interpreted keys",
  { timeout: 10_000 },
  async () => {
    const child = spawn(resolve("packages/platform/native/.build/debug/voice-helper"), [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        VOICE_TEST_KEYCHAIN_SERVICE: "com.codlume.voice.test.shortcuts",
        VOICE_TEST_CAPTURE: "synthetic",
      },
    });
    const lines = createInterface({ input: child.stdout });
    const closed = once(child, "exit");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 8_000);
    const actions = [];
    const waiting = [];
    lines.on("line", (line) => {
      const event = JSON.parse(line);
      if (event.type === "shortcut") actions.push(event.action);
      else waiting.shift()?.(event);
    });
    const reply = (payload) =>
      new Promise((done) => {
        waiting.push(done);
        child.stdin.write(JSON.stringify(payload) + "\n");
      });
    const press = (key, down, flags = [], repeat = false) =>
      reply({ type: "shortcut.simulate", key, down, flags, repeat }).then(
        (event) => event.consumed,
      );
    try {
      await reply({ type: "hello", version: 1 });
      const configured = await reply({
        type: "setup.request",
        version: 1,
        id: 1,
        command: {
          type: "shortcut.configure",
          shortcuts: { hold: "Fn", toggle: "Fn+Space", cancel: "Escape" },
          active: false,
          bar: null,
        },
      });
      assert.equal(configured.result.type, "shortcuts");
      // Listening depends on the runner's Accessibility grant; the translation below does not.
      assert.equal(typeof configured.result.listening, "boolean");
      assert.equal(await press("fn", true), false);
      assert.equal(await press("fn", true), false);
      assert.equal(await press("space", true, ["fn"]), true);
      assert.equal(await press("space", true, ["fn"], true), true);
      assert.equal(await press("space", false, ["fn"]), true);
      assert.equal(await press("fn", false), false);
      assert.equal(await press("escape", true), false);
      assert.equal(await press("a", true, ["fn"]), false);
      assert.equal(await press("space", true), false);
      // Idle Escape belongs to the frontmost app and produces no action.
      assert.deepEqual(actions, ["hold.down", "toggle", "hold.up"]);
      await reply({
        type: "setup.request",
        version: 1,
        id: 2,
        command: {
          type: "shortcut.configure",
          shortcuts: {
            hold: "Control+Option+Space",
            toggle: "Control+Shift+Space",
            cancel: "Control+Option+Escape",
          },
          active: true,
          bar: null,
        },
      });
      assert.equal(await press("space", true, ["control", "option"]), true);
      assert.equal(await press("space", true, ["control", "option"], true), true);
      assert.equal(await press("space", false, ["control", "option"]), true);
      assert.equal(await press("space", true, ["control", "shift"]), true);
      assert.equal(await press("escape", true, ["control", "option"]), true);
      assert.equal(await press("escape", true), false);
      assert.deepEqual(actions.slice(3), ["hold.down", "hold.up", "toggle", "cancel"]);
      // A binding change while the hold key is down waits for its release.
      assert.equal(await press("space", true, ["control", "option"]), true);
      await reply({
        type: "setup.request",
        version: 1,
        id: 6,
        command: {
          type: "shortcut.configure",
          shortcuts: { hold: "Fn", toggle: "Fn+Space", cancel: "Escape" },
          active: true,
          bar: null,
        },
      });
      // The previous bindings stay in force until the held key is released.
      assert.equal(await press("escape", true, ["control", "option"]), true);
      assert.equal(await press("space", false, ["control", "option"]), true);
      assert.equal(await press("fn", true), false);
      assert.equal(await press("fn", false), false);
      assert.deepEqual(actions.slice(7), [
        "hold.down",
        "cancel",
        "hold.up",
        "hold.down",
        "hold.up",
      ]);
      const missing = await reply({
        type: "setup.request",
        version: 1,
        id: 3,
        command: { type: "target.insert", session: "nobody", text: "Hello" },
      });
      assert.deepEqual(missing.result, {
        type: "insertion",
        session: "nobody",
        outcome: "missing",
      });
      const released = await reply({
        type: "setup.request",
        version: 1,
        id: 4,
        command: { type: "target.release", session: "nobody" },
      });
      assert.deepEqual(released.result, { type: "released", session: "nobody" });
      const captured = await reply({
        type: "setup.request",
        version: 1,
        id: 5,
        command: { type: "target.capture", session: "probe" },
      });
      assert.equal(captured.result.type, "target");
      assert.ok(
        ["eligible", "none", "unsupported", "protected", "terminal", "unavailable"].includes(
          captured.result.status,
        ),
      );
      await reply({ type: "shutdown", version: 1 });
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

test(
  "floating-bar clicks are taken over by the tap and forwarded relative to the bar",
  { timeout: 10_000 },
  async () => {
    const child = spawn(resolve("packages/platform/native/.build/debug/voice-helper"), [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        VOICE_TEST_KEYCHAIN_SERVICE: "com.codlume.voice.test.pointer",
        VOICE_TEST_CAPTURE: "synthetic",
      },
    });
    const lines = createInterface({ input: child.stdout });
    const closed = once(child, "exit");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 8_000);
    const pointers = [];
    const pointerWaiters = [];
    const waiting = [];
    lines.on("line", (line) => {
      const event = JSON.parse(line);
      if (event.type === "bar.pointer") {
        pointers.push(event);
        pointerWaiters.shift()?.();
      } else waiting.shift()?.(event);
    });
    const reply = (payload) =>
      new Promise((done) => {
        waiting.push(done);
        child.stdin.write(JSON.stringify(payload) + "\n");
      });
    const pointer = (button, down, x, y, owned = true) =>
      reply({ type: "pointer.simulate", button, down, x, y, owned }).then(
        (event) => event.consumed,
      );
    const configure = (bar) =>
      reply({
        type: "setup.request",
        version: 1,
        id: 1,
        command: {
          type: "shortcut.configure",
          shortcuts: { hold: "Fn", toggle: "Fn+Space", cancel: "Escape" },
          active: false,
          bar,
        },
      });
    const forwarded = (count) =>
      pointers.length >= count
        ? Promise.resolve()
        : new Promise((done) => pointerWaiters.push(() => forwarded(count).then(done)));
    try {
      await reply({ type: "hello", version: 1 });
      await configure({ x: 100, y: 800, width: 480, height: 84, window: 42 });
      // A left click inside the bar is consumed and forwarded in screen points.
      assert.equal(await pointer(0, true, 150.5, 830), true);
      assert.equal(await pointer(0, false, 700, 20), true);
      // Right clicks inside are consumed without forwarding; clicks outside pass through.
      assert.equal(await pointer(1, true, 120, 810), true);
      assert.equal(await pointer(1, false, 120, 810), true);
      assert.equal(await pointer(0, true, 99, 830), false);
      assert.equal(await pointer(0, false, 99, 830), false);
      assert.equal(await pointer(0, true, 150, 884), false);
      assert.equal(await pointer(0, false, 150, 884), false);
      // A menu or alert drawn over the bar keeps its own click.
      assert.equal(await pointer(0, true, 150, 830, false), false);
      assert.equal(await pointer(0, false, 150, 830, false), false);
      // A hidden bar takes over nothing.
      await configure(null);
      assert.equal(await pointer(0, true, 150, 830), false);
      assert.equal(await pointer(0, false, 150, 830), false);
      await forwarded(2);
      assert.deepEqual(pointers, [
        { type: "bar.pointer", phase: "down", x: 150.5, y: 830 },
        { type: "bar.pointer", phase: "up", x: 700, y: 20 },
      ]);
      await reply({ type: "shutdown", version: 1 });
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
