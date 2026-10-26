import type { IpcMainInvokeEvent } from "electron";
import { describe, expectTypeOf, test } from "vite-plus/test";

import { Channel, type HubApi, type PillApi } from "../shared/api.ts";
import type { Commands } from "./ipc.ts";

const commands = <Api>(): Commands<Api> => ({ handle: () => {} });
const listener = () => {};
const trustsSettings = (
  _event: IpcMainInvokeEvent,
  _patch: Parameters<HubApi["updateSettings"]>[0],
) => {};
const unexpectedArgument = (_event: IpcMainInvokeEvent, _extra: unknown) => {};
const extraArgument = (
  _event: IpcMainInvokeEvent,
  _id: unknown,
  _version: unknown,
  _extra: unknown,
) => {};

describe("Commands", () => {
  test("a channel registers only for the window whose bridge invokes it, checked by tsc", () => {
    const hub = commands<HubApi>();
    const pill = commands<PillApi>();
    hub.handle(Channel.updateSettings, listener);
    pill.handle(Channel.getPillSnapshot, () => ({
      session: { kind: "idle" },
      alwaysShowPill: true,
    }));
    // @ts-expect-error the Flow Bar owns getPillSnapshot
    hub.handle(Channel.getPillSnapshot, listener);
    // @ts-expect-error updateSettings belongs to the Voice window
    pill.handle(Channel.updateSettings, listener);
    // @ts-expect-error main pushes snapshots; no renderer invokes them
    hub.handle(Channel.snapshot, listener);
    // @ts-expect-error main pushes levels to both windows
    pill.handle(Channel.level, listener);
  });

  test("derives raw argument tuples and awaited results from promise methods", () => {
    const hub = commands<HubApi>();
    hub.handle(Channel.copyHistoryEntry, (event, id, version) => {
      expectTypeOf(event).toEqualTypeOf<IpcMainInvokeEvent>();
      expectTypeOf(id).toEqualTypeOf<unknown>();
      expectTypeOf(version).toEqualTypeOf<unknown>();
    });
    hub.handle(Channel.clearHistory, async () => {});
    // @ts-expect-error renderer arguments must be parsed before they can be trusted
    hub.handle(Channel.updateSettings, trustsSettings);
    // @ts-expect-error a raw string still needs parsing
    hub.handle(Channel.copyHistoryEntry, (_event, _id: string, _version: unknown) => {});
    // @ts-expect-error clearHistory has no renderer arguments
    hub.handle(Channel.clearHistory, unexpectedArgument);
    // @ts-expect-error copyHistoryEntry has exactly two renderer arguments
    hub.handle(Channel.copyHistoryEntry, extraArgument);
    // @ts-expect-error getSnapshot must return a snapshot
    hub.handle(Channel.getSnapshot, () => "snapshot");
    // @ts-expect-error an asynchronous result must also match the API
    hub.handle(Channel.getSnapshot, async () => "snapshot");
    // @ts-expect-error command results cannot return unrelated data
    hub.handle(Channel.clearHistory, () => 42);
    const nonCommands = commands<{
      getSnapshot(): string;
      getHistory: boolean;
      onSnapshot(): () => void;
    }>();
    // @ts-expect-error only promise-returning methods are commands
    nonCommands.handle(Channel.getSnapshot, () => "snapshot");
    // @ts-expect-error properties are not commands
    nonCommands.handle(Channel.getHistory, listener);
  });
});
