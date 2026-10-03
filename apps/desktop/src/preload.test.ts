import { describe, expect, test, vi } from "vite-plus/test";

import { Channel, type VoiceApi } from "./shared/api.ts";

const listened: string[] = [];
const invoked: unknown[][] = [];
let exposed: VoiceApi | undefined;

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: VoiceApi) => {
      exposed = api;
    },
  },
  ipcRenderer: {
    on: (channel: string) => listened.push(channel),
    off: () => {},
    invoke: (...args: unknown[]) => {
      invoked.push(args);
      return Promise.resolve();
    },
  },
}));
vi.mock("@sentry/electron/preload", () => ({}));

// The Better Auth plugin sends `better-auth:error` to the focused window on any failed auth
// request. It stays harmless only while no preload listens on that channel.
describe("preload", () => {
  test("listens only on Voice channels and never on the auth plugin's", async () => {
    await import("./preload.ts");
    if (!exposed) throw new Error("preload exposed nothing");
    exposed.onSnapshot(() => {});
    exposed.onLevel(() => {});
    exposed.onRestartRequest(() => {});
    const channels = new Set(listened);
    const known = new Set<string>(Object.values(Channel));
    expect([...channels].filter((channel) => !known.has(channel))).toEqual([]);
    expect([...channels].filter((channel) => channel.startsWith("better-auth"))).toEqual([]);
    expect(channels.has(Channel.snapshot)).toBe(true);
  });

  test("account calls invoke their channels with the code as the only payload", async () => {
    await import("./preload.ts");
    if (!exposed) throw new Error("preload exposed nothing");
    invoked.length = 0;
    await exposed.signIn();
    await exposed.submitSignInCode("abc");
    await exposed.cancelSignIn();
    await exposed.dismissAccountError();
    expect(invoked).toEqual([
      [Channel.signIn],
      [Channel.submitSignInCode, "abc"],
      [Channel.cancelSignIn],
      [Channel.dismissAccountError],
    ]);
  });
});
