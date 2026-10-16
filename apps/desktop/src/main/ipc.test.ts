import { describe, test } from "vite-plus/test";

import { Channel, type HubApi, type PillApi } from "../shared/api.ts";
import type { Commands } from "./ipc.ts";

const commands = <Api>(): Commands<Api> => ({ handle: () => {} });
const listener = () => {};

describe("Commands", () => {
  test("a channel registers only for the window whose bridge invokes it, checked by tsc", () => {
    const hub = commands<HubApi>();
    const pill = commands<PillApi>();
    hub.handle(Channel.updateSettings, listener);
    pill.handle(Channel.getPillSnapshot, listener);
    // @ts-expect-error the Flow Bar owns getPillSnapshot
    hub.handle(Channel.getPillSnapshot, listener);
    // @ts-expect-error updateSettings belongs to the Voice window
    pill.handle(Channel.updateSettings, listener);
    // @ts-expect-error main pushes snapshots; no renderer invokes them
    hub.handle(Channel.snapshot, listener);
    // @ts-expect-error main pushes levels to both windows
    pill.handle(Channel.level, listener);
  });
});
