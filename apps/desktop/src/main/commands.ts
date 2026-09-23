import type { createSession } from "./session";
import {
  decodeCommand,
  type Command,
  type Settings,
  type Reply,
  type Status,
  type View,
} from "@voice/contracts/desktop";
import type { SessionCommand } from "@voice/contracts/session";

import { defaultSetupPreferences, type SetupPreferences } from "@voice/contracts/setup";
import { sessionCommandTypes } from "@voice/contracts/session";
import type { createSetup } from "./setup";

const isSessionCommand = (command: Command): command is SessionCommand =>
  (sessionCommandTypes as readonly string[]).includes(command.type);
// The floating bar only controls the dictation session and opens the main window.
export const floatingBarPermits = (command: Command) =>
  command.type === "status.get" ||
  command.type === "session.stop" ||
  command.type === "session.cancel" ||
  command.type === "app.open" ||
  (command.type === "session.start" && command.origin === "dictation");
export function createCommands<Sender>(options: {
  quit?: (confirmed: boolean) => void;
  open?: (view: View) => void;
  session?: () => ReturnType<typeof createSession>;
  setup?: () => ReturnType<typeof createSetup>;
  isAuthorized: (sender: Sender) => boolean;
  // Narrows the command surface for a sender such as the floating bar.
  permitted?: (sender: Sender, command: Command) => boolean;
  initialSettings: Settings;
  status: () => Status;
  storage: { set: (settings: Settings) => Promise<Settings>; restart: () => Promise<Settings> };
}) {
  let settings = options.initialSettings;
  let writing = Promise.resolve();
  function write(change: (current: Settings) => Settings) {
    const operation = writing.then(async () => {
      if (options.status().storage !== "ready") throw new Error("storage-unavailable");
      settings = await options.storage.set(change(settings));
    });
    writing = operation.catch(() => {});
    return operation;
  }
  return {
    preferences: () => settings.setup ?? defaultSetupPreferences,
    saveSetup: (setup: SetupPreferences) => write((current) => ({ ...current, setup })),
    updateSettings(value: Settings) {
      settings = value;
    },
    async execute(sender: Sender, payload: unknown): Promise<Reply> {
      if (!options.isAuthorized(sender)) return { ok: false, error: "unauthorized" };
      let command;
      try {
        command = decodeCommand(payload);
      } catch {
        return { ok: false, error: "invalid-command" };
      }
      if (options.permitted && !options.permitted(sender, command))
        return { ok: false, error: "unauthorized" };
      try {
        if (command.type === "app.quit" || command.type === "app.quit.confirm") {
          if (command.type === "app.quit" || options.session?.().snapshot().quitWarning)
            options.quit?.(command.type === "app.quit.confirm");
        } else if (command.type === "app.open") {
          options.open?.(command.view);
        } else if (isSessionCommand(command)) {
          if (!options.session) return { ok: false, error: "native-unavailable" };
          await options.session().execute(command);
        } else if (command.type === "settings.set") {
          if (options.status().storage !== "ready")
            return { ok: false, error: "storage-unavailable" };
          await write((current) => ({ ...current, appearance: command.appearance }));
        } else if (command.type === "storage.retry") {
          settings = await options.storage.restart();
        } else if (command.type !== "settings.get" && command.type !== "status.get") {
          if (!options.setup) return { ok: false, error: "native-unavailable" };
          if (command.type === "credential.set" || command.type === "credential.remove")
            options
              .session?.()
              .interrupted(
                "Your Deepgram key changed, so Voice stopped this session. The recording and available text remain in recovery; Retry sends them only when you choose.",
              );
          await options.setup().execute(command);
          // An explicit, successful refresh after the user repaired billing lets the next session
          // find out again; setup's own refreshes keep what Deepgram last reported.
          if (command.type === "setup.refresh") options.setup().forgetQuota();
        }
        return {
          ok: true,
          settings,
          status: options.status(),
          ...(options.session ? { session: options.session().snapshot() } : {}),
          ...(options.setup ? { setup: options.setup().snapshot() } : {}),
        };
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message === "native-unavailable" ||
            error.message === "keychain-unavailable" ||
            error.message === "shortcut-conflict")
        )
          return { ok: false, error: error.message };
        return { ok: false, error: "storage-unavailable" };
      }
    },
  };
}
