import type { IpcMain } from "electron";

import type { Channel } from "../shared/api.ts";

type ChannelForApiMember<Api> = (typeof Channel)[Extract<keyof typeof Channel, keyof Api>];

/** A window's own `webContents.ipc`, narrowed to the channels that window's bridge invokes. */
export type Commands<Api> = {
  handle(channel: ChannelForApiMember<Api>, listener: Parameters<IpcMain["handle"]>[1]): void;
};
