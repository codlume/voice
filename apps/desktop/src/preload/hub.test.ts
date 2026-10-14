import { describe, expect, test, vi } from "vite-plus/test";

import { Channel, type HubApi } from "../shared/api.ts";

const listened: string[] = [];
const invoked: unknown[][] = [];
const exposures: { name: string; api: HubApi }[] = [];

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: HubApi) => {
      exposures.push({ name, api });
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

async function load() {
  await import("./hub.ts");
  const [exposed] = exposures;
  if (!exposed) throw new Error("hub preload exposed nothing");
  return exposed;
}

describe("hub preload", () => {
  test("exposes the Voice window's bridge under voice without the Flow Bar's members", async () => {
    const { api } = await load();
    expect(exposures.map(({ name }) => name)).toEqual(["voice"]);
    expect(Object.keys(api).toSorted()).toEqual([
      "cancelAccountDeletion",
      "cancelSignIn",
      "checkForUpdates",
      "clearHistory",
      "clearInsights",
      "confirmAccountDeletion",
      "copyHistoryEntry",
      "deleteHistoryEntry",
      "diagnosticsStartedAtLaunch",
      "dismissAccountError",
      "downloadUpdate",
      "getHistory",
      "getInsights",
      "getSnapshot",
      "installModel",
      "onHistory",
      "onInsights",
      "onLevel",
      "onRestartRequest",
      "onSnapshot",
      "openRelease",
      "requestAccountDeletion",
      "requestPermission",
      "restartForUpdate",
      "retryAccountDeletion",
      "setOpenAtLogin",
      "signIn",
      "signOut",
      "startMicrophoneTest",
      "stopMicrophoneTest",
      "submitSignInCode",
      "uninstallModel",
      "updateAccountName",
      "updateSettings",
    ]);
  });

  // The Better Auth plugin sends `better-auth:error` to the focused window on any failed auth
  // request. It stays harmless only while no preload listens on that channel.
  test("listens only on Voice channels and never on the auth plugin's", async () => {
    const { api } = await load();
    api.onSnapshot(() => {});
    api.onLevel(() => {});
    api.onRestartRequest(() => {});
    api.onInsights(() => {});
    api.onHistory(() => {});
    const channels = new Set(listened);
    const known = new Set<string>(Object.values(Channel));
    expect([...channels].filter((channel) => !known.has(channel))).toEqual([]);
    expect([...channels].filter((channel) => channel.startsWith("better-auth"))).toEqual([]);
    expect(channels.has(Channel.snapshot)).toBe(true);
    expect(channels.has(Channel.history)).toBe(true);
    expect(channels.has(Channel.pillSnapshot)).toBe(false);
  });

  test("account calls invoke their channels with the code or name as the only payload", async () => {
    const { api } = await load();
    invoked.length = 0;
    await api.signIn();
    await api.submitSignInCode("abc");
    await api.cancelSignIn();
    await api.dismissAccountError();
    await api.updateAccountName({ firstName: "Ada", lastName: "Lovelace" });
    expect(invoked).toEqual([
      [Channel.signIn],
      [Channel.submitSignInCode, "abc"],
      [Channel.cancelSignIn],
      [Channel.dismissAccountError],
      [Channel.updateAccountName, { firstName: "Ada", lastName: "Lovelace" }],
    ]);
  });
});
