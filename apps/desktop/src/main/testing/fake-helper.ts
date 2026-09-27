#!/usr/bin/env node
import { createInterface } from "node:readline";
import { createServer } from "node:net";
import { unlinkSync } from "node:fs";

type Action = "down" | "up" | "cancel" | "exit" | "stall";
type Config = {
  transcript?: string;
  insert?: { method: string; reason?: string };
  asr?: string;
  permissions?: { microphone: string; accessibility: string };
  startMs?: number;
  script?: { at: number; action: Action }[];
  control?: string;
  version?: number;
};

const config: Config = JSON.parse(process.env.VOICE_FAKE_HELPER ?? "{}");
const startedAt = Date.now();
let recording: { since: number; levels: NodeJS.Timeout } | null = null;

function emit(event: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function stopLevels() {
  if (recording) clearInterval(recording.levels);
}

function act(action: Action) {
  if (action === "exit") process.exit(3);
  // Stops reading commands, so a large write from main is still in flight when a later exit
  // closes the pipe and the write fails with EPIPE.
  if (action === "stall") return process.stdin.pause();
  emit({ type: "hotkey", action });
}

function handle(command: Record<string, unknown>) {
  const id = String(command.id ?? "");
  switch (command.type) {
    case "hotkey.configure":
      emit({ type: "log", level: "info", message: `hotkey configured: ${String(command.key)}` });
      return;
    case "microphone.configure":
      emit({
        type: "microphones.changed",
        devices: [
          { uid: "builtin", name: "Built-in microphone" },
          { uid: "usb", name: "USB microphone" },
        ],
        defaultUid: "builtin",
      });
      return;
    case "permissions.check":
    case "permissions.request":
      emit({
        type: "permissions",
        microphone: "granted",
        accessibility: "granted",
        ...config.permissions,
      });
      return;
    case "asr.prepare":
      emit({ type: "asr.status", state: config.asr ?? "ready" });
      return;
    case "capture.start":
      setTimeout(() => {
        const startMs = config.startMs ?? 30;
        emit({ type: "capture.started", id, startMs });
        const levels = setInterval(
          () => emit({ type: "capture.level", id, level: Math.random() }),
          33,
        );
        recording = { since: Date.now(), levels };
      }, config.startMs ?? 30);
      return;
    case "capture.stop": {
      stopLevels();
      const audioMs = recording ? Date.now() - recording.since : 0;
      recording = null;
      setTimeout(
        () =>
          emit({
            type: "transcript",
            id,
            text: config.transcript ?? "hello world",
            audioMs,
            asrMs: 40,
          }),
        40,
      );
      return;
    }
    case "capture.cancel":
      stopLevels();
      recording = null;
      emit({ type: "capture.cancelled", id });
      return;
    case "insert":
      setTimeout(
        () => emit({ type: "insert.result", id, method: "accessibility", ...config.insert }),
        10,
      );
      return;
    default:
      emit({ type: "log", level: "error", message: `unknown command ${String(command.type)}` });
  }
}

for (const { at, action } of config.script ?? []) {
  setTimeout(() => act(action), Math.max(0, startedAt + at - Date.now()));
}

const ready = () => emit({ type: "ready", version: config.version ?? 4 });

if (config.control) {
  const path = config.control;
  try {
    unlinkSync(path);
  } catch {}
  const server = createServer((socket) => {
    createInterface({ input: socket }).on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed === "") return;
      if (trimmed.startsWith("{")) emit(JSON.parse(trimmed));
      else act(trimmed as Action);
    });
  });
  server.unref();
  server.listen(path, ready);
} else {
  ready();
}

createInterface({ input: process.stdin })
  .on("line", (line) => {
    if (line.trim() !== "") handle(JSON.parse(line));
  })
  .on("close", () => process.exit(0));
