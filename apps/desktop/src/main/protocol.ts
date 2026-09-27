import type { Hotkey, PermissionKind, PermissionState } from "../shared/api.ts";
import type { InsertFailure, InsertMethod } from "./session.ts";

// Bump together with the helper's `ready` version whenever a line's shape changes.
export const HELPER_PROTOCOL_VERSION = 2;

export type HelperCommand =
  | { type: "hotkey.configure"; key: Hotkey }
  | { type: "capture.start"; id: string; muteWhileDictating: boolean }
  | { type: "capture.stop"; id: string }
  | { type: "capture.cancel"; id: string }
  | { type: "insert"; id: string; text: string }
  | { type: "permissions.check" }
  | { type: "permissions.request"; kind: PermissionKind }
  | { type: "asr.prepare"; download: boolean };

type AsrState = "missing" | "downloading" | "loading" | "ready" | "failed";

export type HelperEvent =
  | { type: "ready"; version: number }
  | { type: "hotkey"; action: "down" | "up" | "cancel" }
  | { type: "capture.started"; id: string; startMs: number }
  | { type: "capture.level"; id: string; level: number }
  | { type: "capture.failed"; id: string; message: string }
  | { type: "capture.cancelled"; id: string }
  | { type: "transcript"; id: string; text: string; audioMs: number; asrMs: number }
  | { type: "transcript.failed"; id: string; message: string }
  | { type: "insert.result"; id: string; method: InsertMethod; reason: InsertFailure | null }
  | { type: "permissions"; microphone: PermissionState; accessibility: PermissionState }
  | { type: "asr.status"; state: AsrState; message: string | null }
  | { type: "log"; level: "info" | "error"; message: string };

type Raw = Record<string, unknown>;

const str = (v: unknown): v is string => typeof v === "string";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const oneOf =
  <const T extends readonly string[]>(values: T) =>
  (v: unknown): v is T[number] =>
    str(v) && values.includes(v);

const permissionState = oneOf(["granted", "denied", "notDetermined"]);
const insertMethod = oneOf(["accessibility", "paste", "none"]);
const insertFailure = oneOf(["focusChanged", "noFocusedField", "secureInput", "failed"]);
const asrState = oneOf(["missing", "downloading", "loading", "ready", "failed"]);

export function parseHelperEvent(line: string): HelperEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Raw;
  switch (r.type) {
    case "ready":
      return num(r.version) ? { type: "ready", version: r.version } : null;
    case "hotkey":
      return oneOf(["down", "up", "cancel"])(r.action)
        ? { type: "hotkey", action: r.action }
        : null;
    case "capture.started":
      return str(r.id) && num(r.startMs)
        ? { type: "capture.started", id: r.id, startMs: r.startMs }
        : null;
    case "capture.level":
      return str(r.id) && num(r.level)
        ? { type: "capture.level", id: r.id, level: Math.min(1, Math.max(0, r.level)) }
        : null;
    case "capture.failed":
      return str(r.id) && str(r.message)
        ? { type: "capture.failed", id: r.id, message: r.message }
        : null;
    case "capture.cancelled":
      return str(r.id) ? { type: "capture.cancelled", id: r.id } : null;
    case "transcript":
      return str(r.id) && str(r.text) && num(r.audioMs) && num(r.asrMs)
        ? { type: "transcript", id: r.id, text: r.text, audioMs: r.audioMs, asrMs: r.asrMs }
        : null;
    case "transcript.failed":
      return str(r.id) && str(r.message)
        ? { type: "transcript.failed", id: r.id, message: r.message }
        : null;
    case "insert.result": {
      if (!str(r.id) || !insertMethod(r.method)) return null;
      const reason = insertFailure(r.reason) ? r.reason : null;
      return { type: "insert.result", id: r.id, method: r.method, reason };
    }
    case "permissions":
      return permissionState(r.microphone) && permissionState(r.accessibility)
        ? { type: "permissions", microphone: r.microphone, accessibility: r.accessibility }
        : null;
    case "asr.status":
      return asrState(r.state)
        ? { type: "asr.status", state: r.state, message: str(r.message) ? r.message : null }
        : null;
    case "log":
      return oneOf(["info", "error"])(r.level) && str(r.message)
        ? { type: "log", level: r.level, message: r.message }
        : null;
    default:
      return null;
  }
}
