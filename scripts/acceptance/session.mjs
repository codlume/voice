// Drives the packaged app through its real session path: helper synthetic capture plays a frozen
// WAV at real time, main's shortcut handler starts and stops the session, the provider worker
// streams to Deepgram or a loopback stand-in, and the helper validates and inserts into the target.
import { _electron as electron } from "@playwright/test";
import { WebSocketServer } from "ws";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { root } from "./fixtures.mjs";

const run = promisify(execFile);
export const executable = join(
  root,
  "out/Voice Development-darwin-arm64/Voice Development.app/Contents/MacOS/Voice Development",
);
const model = {
  model_uuid: "40bd3654-e622-47c4-a111-63a61b23bfe8",
  model_info: { version: "2025-04-17.21547" },
};
const now = () => Number(process.hrtime.bigint()) / 1e6;

// Deterministic Deepgram stand-in. `script.text` is the provider-final text for the next
// connection; `script.mode` injects a dropped first connection, a hold, or a rejected key.
export async function loopback() {
  const script = { text: "", mode: "echo" };
  let connections = 0;
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    verifyClient: (_info, done) => (script.mode === "reject" ? done(false, 401) : done(true)),
  });
  await once(server, "listening");
  server.on("connection", (socket) => {
    const index = connections++;
    let bytes = 0;
    socket.on("message", (data, binary) => {
      if (binary) {
        bytes += data.length;
        if (script.mode === "drop-first" && index === script.firstConnection && bytes > 32_000)
          socket.terminate();
        return;
      }
      if (JSON.parse(data.toString()).type !== "CloseStream" || script.mode === "hold") return;
      const seconds = bytes / 32_000;
      socket.send(
        JSON.stringify({
          type: "Results",
          start: 0,
          duration: seconds,
          is_final: true,
          channel_index: [0, 1],
          metadata: model,
          channel: { alternatives: [{ transcript: script.text }] },
        }),
      );
      socket.send(JSON.stringify({ type: "Metadata", duration: seconds, channels: 1 }));
      socket.close(1000);
    });
  });
  const { port } = server.address();
  return {
    url: `ws://127.0.0.1:${port}`,
    set(text, mode = "echo") {
      script.text = text;
      script.mode = mode;
      script.firstConnection = connections;
    },
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise((done) => server.close(() => done()));
    },
  };
}

const osascript = async (source) => (await run("osascript", ["-e", source])).stdout.trim();
// A scratch TextEdit document is the only external target. Its text is read back through
// Apple Events after each session, so confirmation comes from the target, not the provider.
export async function textEdit() {
  const directory = await mkdtemp(join(tmpdir(), "voice-acceptance-target-"));
  const file = join(directory, "scratch.txt");
  await writeFile(file, "");
  await run("open", ["-a", "TextEdit", file]);
  const focus = async () => {
    await osascript('tell application "TextEdit" to activate');
    await osascript('tell application "TextEdit" to set text of front document to ""');
  };
  return {
    kind: "textedit",
    focus,
    read: () => osascript('tell application "TextEdit" to get text of front document'),
    async close() {
      await osascript('tell application "TextEdit" to close front document saving no').catch(
        () => {},
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}
// Without a target the Voice window stays in front, so every result goes to recovery.
export const noTarget = {
  kind: "recovery",
  focus: async () => {},
  read: async () => "",
  close: async () => {},
};

export async function launch({ provider, directory }) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && key !== "ELECTRON_RUN_AS_NODE",
    ),
  );
  const startedAt = now();
  const app = await electron.launch({
    executablePath: executable,
    args: [`--voice-test-data=${directory}`],
    env: {
      ...env,
      VOICE_TEST_CAPTURE: "synthetic",
      ...(provider === "live"
        ? { VOICE_ACCEPTANCE_PROVIDER: "deepgram" }
        : { VOICE_TEST_PROVIDER_URL: provider }),
    },
  });
  const page = await app.firstWindow();
  const hook = (name, argument) =>
    app.evaluate(
      (_electron, [method, value]) => globalThis.voiceTest[method](value),
      [name, argument],
    );
  const command = (input) =>
    page.evaluate(async (value) => {
      const reply = await window.voice.command(value);
      if (!reply.ok) throw new Error(reply.error ?? "command failed");
      return reply;
    }, input);
  const status = () => command({ type: "status.get" });
  const until = async (predicate, timeoutMs) => {
    const deadline = now() + timeoutMs;
    for (;;) {
      const value = await status();
      if (predicate(value)) return value;
      if (now() > deadline) return undefined;
      await new Promise((done) => setTimeout(done, 25));
    }
  };
  // Ready is main's own mark after helper, storage, setup, and shortcuts are ready.
  let ready;
  for (;;) {
    ready = (await hook("timeline")).find((entry) => entry.mark === "ready");
    if (ready) break;
    await new Promise((done) => setTimeout(done, 25));
  }
  await command({
    type: "setup.save",
    inputDevice: null,
    shortcuts: { hold: "Fn", toggle: "Fn+Space", cancel: "Escape" },
    completed: true,
  });
  return { app, page, hook, command, status, until, launchToReadyMs: ready.at - startedAt };
}

// One hold-to-talk session over a fixture. Returns the ledger fields it observed.
export async function dictate(voice, target, fixture, { path, deadlineMs, cancel = false }) {
  await voice.hook("captureSource", path);
  await target.focus();
  await voice.hook("timeline");
  await voice.hook("shortcut", "hold.down");
  if (cancel) await voice.hook("captured", 25);
  else await voice.hook("captured", fixture.seconds * 50);
  await voice.hook("shortcut", cancel ? "cancel" : "hold.up");
  const settled = await voice.until(
    ({ session }) => ["complete", "failed", "cancelled", "idle"].includes(session.phase),
    deadlineMs + 5_000,
  );
  const marks = await voice.hook("timeline");
  const at = (name, detail) =>
    marks.find((entry) => entry.mark === name && (detail === undefined || entry.detail === detail))
      ?.at;
  const down = at("shortcut", "hold.down");
  const stop = Math.min(...[at("shortcut", "hold.up"), at("capture.stopped")].filter(Boolean));
  const inserted = marks.find((entry) => entry.mark === "insertion");
  const requests = marks.filter((entry) => entry.mark === "provider-start").length;
  const session = settled?.session;
  const retained = session?.recovery.at(-1);
  const text = inserted ? (session?.latestSuccessful?.text ?? "") : (retained?.text ?? "");
  const document = await target.read();
  // Clear recovery so capacity never blocks the next slot; the ledger already holds the result.
  for (const item of session?.recovery ?? [])
    await voice.command({ type: "recovery.discard", id: item.id });
  return {
    phase: session?.phase ?? "runner-timeout",
    notice: session?.notice ?? null,
    outcome:
      inserted?.detail ??
      (retained ? `recovery-${retained.transcription}` : (session?.phase ?? "runner-timeout")),
    text,
    targetVerified: target.kind === "textedit" && !!text && document.includes(text),
    requests,
    replays: Math.max(0, requests - 1),
    providerFailures: marks
      .filter((entry) => entry.mark === "provider-failed")
      .map((entry) => entry.detail),
    // A completed provider result passed the pinned model UUID and version check in the adapter.
    models: marks.some((entry) => entry.mark === "provider-complete") ? [model.model_uuid] : [],
    shortcutToFirstFrameMs: down && at("first-frame") ? at("first-frame") - down : undefined,
    stopToInsertionMs: inserted && Number.isFinite(stop) ? inserted.at - stop : undefined,
    stopToSettledMs: Number.isFinite(stop) && marks.length ? marks.at(-1).at - stop : undefined,
    marks,
  };
}

// Warm start: shortcut to the first captured frame, then Cancel, which discards the audio.
export async function warmStart(voice, target) {
  await voice.hook("captureSource", null);
  await target.focus();
  await voice.hook("timeline");
  await voice.hook("shortcut", "hold.down");
  await voice.hook("captured", 1);
  await voice.hook("shortcut", "cancel");
  await voice.until(
    ({ session }) => session.phase !== "recording" && session.phase !== "starting",
    5_000,
  );
  const marks = await voice.hook("timeline");
  const down = marks.find((entry) => entry.mark === "shortcut" && entry.detail === "hold.down")?.at;
  const frame = marks.find((entry) => entry.mark === "first-frame")?.at;
  return {
    outcome: down && frame ? "measured" : "no-first-frame",
    shortcutToFirstFrameMs: down && frame ? frame - down : undefined,
    requests: 0,
    replays: 0,
  };
}

export async function osVersion() {
  const [os, hardware] = await Promise.all([
    run("sw_vers", ["-productVersion"]).then(({ stdout }) => stdout.trim()),
    run("sysctl", ["-n", "machdep.cpu.brand_string"]).then(({ stdout }) => stdout.trim()),
  ]);
  const memory = Number((await run("sysctl", ["-n", "hw.memsize"])).stdout.trim()) / 2 ** 30;
  return { os, hardware, memoryGiB: memory };
}
