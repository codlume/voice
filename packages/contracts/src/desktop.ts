import { Schema } from "effect";

export const Appearance = Schema.Literals(["light", "dark"]);
export const Settings = Schema.Struct({ appearance: Appearance });
export type Settings = typeof Settings.Type;
export const defaultSettings: Settings = { appearance: "light" };
export const Command = Schema.Union([
  Schema.Struct({ type: Schema.Literal("settings.get") }),
  Schema.Struct({ type: Schema.Literal("settings.set"), appearance: Appearance }),
  Schema.Struct({ type: Schema.Literal("status.get") }),
  Schema.Struct({ type: Schema.Literal("storage.retry") }),
]);
export type Command = typeof Command.Type;
export const Status = Schema.Struct({
  storage: Schema.Literals(["starting", "ready", "failed"]),
  helper: Schema.Literals(["starting", "ready", "failed"]),
  capture: Schema.Literal("unavailable"),
});
export type Status = typeof Status.Type;
export const Reply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), settings: Settings, status: Status }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Literals(["invalid-command", "unauthorized", "storage-unavailable"]),
  }),
]);
export type Reply = typeof Reply.Type;
export interface DesktopApi {
  command: (command: Command) => Promise<Reply>;
}
export const decodeCommand = Schema.decodeUnknownSync(Command, { onExcessProperty: "error" });
export const decodeReply = Schema.decodeUnknownSync(Reply, { onExcessProperty: "error" });
export const decodeSettings = Schema.decodeUnknownSync(Settings, { onExcessProperty: "error" });
export const commandChannel = "voice:command";
