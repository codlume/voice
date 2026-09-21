import { decodeCommand, type Settings, type Reply, type Status } from "@voice/contracts/desktop";

export function createCommands<Sender>(options: {
  isAuthorized: (sender: Sender) => boolean;
  initialSettings: Settings;
  status: () => Status;
  storage: { set: (settings: Settings) => Promise<Settings>; restart: () => Promise<Settings> };
}) {
  let settings = options.initialSettings;
  return {
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
        if (command.type === "settings.set") {
          if (options.status().storage !== "ready")
            return { ok: false, error: "storage-unavailable" };
          settings = await options.storage.set({ appearance: command.appearance });
        } else if (command.type === "storage.retry") {
          settings = await options.storage.restart();
        }
        return { ok: true, settings, status: options.status() };
      } catch {
        return { ok: false, error: "storage-unavailable" };
      }
    },
  };
}
