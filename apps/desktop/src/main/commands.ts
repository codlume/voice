import type { createSession } from "./session";
import { decodeCommand, type Settings, type Reply, type Status } from "@voice/contracts/desktop";

import { defaultSetupPreferences, type SetupPreferences } from "@voice/contracts/setup";
import type { createSetup } from "./setup";

export function createCommands<Sender>(options: {
  quit?: (confirmed: boolean) => void;
  session?: () => ReturnType<typeof createSession>;
  setup?: () => ReturnType<typeof createSetup>;
  isAuthorized: (sender: Sender) => boolean;
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
      try {
        if (command.type === "app.quit" || command.type === "app.quit.confirm") {
          if (command.type === "app.quit" || options.session?.().snapshot().quitWarning)
            options.quit?.(command.type === "app.quit.confirm");
        } else if (
          command.type === "session.start" ||
          command.type === "session.stop" ||
          command.type === "session.cancel" ||
          command.type === "recovery.copy" ||
          command.type === "recovery.discard" ||
          command.type === "practice.delivered" ||
          command.type === "app.quit.cancel"
        ) {
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
                "Credential changed. Available work remains in memory; start again explicitly after repair.",
              );
          await options.setup().execute(command);
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
