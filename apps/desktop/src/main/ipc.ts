import type { IpcMainInvokeEvent } from "electron";

import type { Channel } from "../shared/api.ts";

type UnknownTuple<Args extends readonly unknown[]> = { [Index in keyof Args]: unknown };

type Listeners<Api> = {
  [
    Member in keyof Api & keyof typeof Channel as Api[Member] extends (
      ...args: never[]
    ) => Promise<unknown>
      ? (typeof Channel)[Member]
      : never
  ]: Api[Member] extends (...args: never[]) => Promise<unknown>
    ? (
        event: IpcMainInvokeEvent,
        ...args: UnknownTuple<Parameters<Api[Member]>>
      ) => Awaited<ReturnType<Api[Member]>> | Promise<Awaited<ReturnType<Api[Member]>>>
    : never;
};

type RegistryCommands<Registry> = {
  handle<Command extends keyof Registry>(channel: Command, listener: Registry[Command]): void;
};

/** A window's own `webContents.ipc`, narrowed to the channels that window's bridge invokes. */
export type Commands<Api> = RegistryCommands<Listeners<Api>>;
