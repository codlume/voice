import { SessionCommand, SessionSnapshot } from "./session";
import { Schema } from "effect";
import { SetupPreferences, SetupCommand, SetupStatus } from "./setup";

export const Appearance = Schema.Literals(["light", "dark"]);
export const View = Schema.Literals(["recovery", "setup"]);
export type View = typeof View.Type;
export const Settings = Schema.Struct({
  appearance: Appearance,
  setup: Schema.optionalKey(SetupPreferences),
});
export type Settings = typeof Settings.Type;
export const defaultSettings: Settings = { appearance: "light" };
export const Command = Schema.Union([
  SetupCommand,
  SessionCommand,
  Schema.Struct({ type: Schema.Literals(["app.quit", "app.quit.confirm"]) }),
  // Brings the main window forward at a section. Only an explicit user action sends this.
  Schema.Struct({ type: Schema.Literal("app.open"), view: View }),
  Schema.Struct({ type: Schema.Literal("settings.get") }),
  Schema.Struct({ type: Schema.Literal("settings.set"), appearance: Appearance }),
  Schema.Struct({ type: Schema.Literal("status.get") }),
  Schema.Struct({ type: Schema.Literal("storage.retry") }),
]);
export type Command = typeof Command.Type;
export const Status = Schema.Struct({
  storage: Schema.Literals(["starting", "ready", "failed"]),
  helper: Schema.Literals(["starting", "ready", "failed"]),
  capture: Schema.Literals(["unavailable", "available", "active"]),
  shortcuts: Schema.Literals(["unavailable", "listening"]),
});
export type Status = typeof Status.Type;
export const Reply = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    settings: Settings,
    status: Status,
    setup: Schema.optionalKey(SetupStatus),
    session: Schema.optionalKey(SessionSnapshot),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Literals([
      "invalid-command",
      "unauthorized",
      "storage-unavailable",
      "native-unavailable",
      "keychain-unavailable",
      "shortcut-conflict",
    ]),
  }),
]);
export type Reply = typeof Reply.Type;
export interface DesktopApi {
  command: (command: Command) => Promise<Reply>;
}
// The narrow preload API, the renderer's only route to main.
export type PreloadApi = DesktopApi & {
  onChanged: (listener: () => void) => () => void;
  onReveal: (listener: (view: View) => void) => () => void;
};
export const decodeCommand = Schema.decodeUnknownSync(Command, { onExcessProperty: "error" });
export const decodeReply = Schema.decodeUnknownSync(Reply, { onExcessProperty: "error" });
export const decodeSettings = Schema.decodeUnknownSync(Settings, { onExcessProperty: "error" });
export const commandChannel = "voice:command";
export const revealChannel = "voice:reveal";
export const decodeView = Schema.decodeUnknownSync(View);
