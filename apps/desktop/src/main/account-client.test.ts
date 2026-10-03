import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vite-plus/test";

import type { UpdateChannel } from "../shared/api.ts";
import { createVoiceAuthClient } from "./account-client.ts";
import { authSessionStored } from "./account-storage.ts";

// The real plugin and its Conf storage run against a fake Electron. safeStorage is a reversible
// stand-in, so the test never touches the login Keychain.
const electron = vi.hoisted(() => {
  const state = { userData: "", encryption: true };
  const api = {
    app: {
      getPath: () => state.userData,
      getName: () => "Voice",
      getVersion: () => "0.0.1",
      userAgentFallback: "Voice test",
    },
    safeStorage: {
      isEncryptionAvailable: () => state.encryption,
      encryptString: (text: string) => Buffer.from(`enc:${text}`),
      decryptString: (bytes: Buffer) => bytes.toString().replace(/^enc:/, ""),
    },
    shell: { openExternal: async () => {} },
    webContents: { getFocusedWebContents: () => null },
  };
  return { state, api };
});
vi.mock("electron", () => ({ default: electron.api, ...electron.api }));

const API = { stable: "https://api.example.com", nightly: "https://api-nightly.example.com" };
const USER = { name: "Ada Lovelace", email: "ada@example.com" };

type Sent = { url: string; cookie: string | null };
let sent: Sent[] = [];
let answer: (url: string) => Response | Promise<Response>;

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
const signedIn = (token: string) =>
  json(
    { session: { token }, user: USER },
    { headers: { "set-cookie": `better-auth.session_token=${token}; Max-Age=3600; Path=/` } },
  );
const client = (channel: UpdateChannel) =>
  createVoiceAuthClient({ apiUrl: API[channel], installedChannel: channel });

beforeAll(() => {
  // The plugin refuses to send requests outside Electron's main process.
  Object.assign(process, { type: "browser" });
});
afterAll(() => {
  Object.assign(process, { type: undefined });
});
beforeEach(() => {
  electron.state.userData = mkdtempSync(NodePath.join(tmpdir(), "voice-account-client-"));
  electron.state.encryption = true;
  sent = [];
  vi.stubGlobal("fetch", async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    sent.push({ url: request.url, cookie: request.headers.get("cookie") || null });
    return answer(request.url);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(electron.state.userData, { recursive: true, force: true });
});

describe("createVoiceAuthClient", () => {
  test("keeps each channel's auth session for its own API", async () => {
    answer = (url) => (url.startsWith(API.stable) ? signedIn("stable-token") : json(null));
    const stable = client("stable");
    expect(await stable.checkAuthSession()).toEqual({ kind: "active", user: USER });
    expect(authSessionStored(electron.state.userData, "stable")).toBe(true);
    expect(authSessionStored(electron.state.userData, "nightly")).toBe(false);

    expect(await client("nightly").checkAuthSession()).toEqual({ kind: "ended", status: 200 });
    await stable.checkAuthSession();

    expect(sent.map(({ url, cookie }) => [new URL(url).origin, cookie])).toEqual([
      [API.stable, null],
      [API.nightly, null],
      [API.stable, "better-auth.session_token=stable-token"],
    ]);
  });

  test("restores the identity of the last answer from storage, and forget clears it", async () => {
    answer = () => signedIn("token-1");
    await client("nightly").checkAuthSession();

    const restarted = client("nightly");
    expect(restarted.cachedUser()).toEqual(USER);
    restarted.forget();
    expect(restarted.cachedUser()).toBeNull();
    expect(authSessionStored(electron.state.userData, "nightly")).toBe(false);
    answer = () => json(null);
    await restarted.checkAuthSession();
    expect(sent.at(-1)?.cookie).toBeNull();
  });

  test.each([
    ["a revoked auth session (200 null)", () => json(null), { kind: "ended", status: 200 }],
    ["401", () => json({ code: "UNAUTHORIZED" }, { status: 401 }), { kind: "ended", status: 401 }],
    ["403", () => json({ code: "FORBIDDEN" }, { status: 403 }), { kind: "ended", status: 403 }],
    ["503", () => json({}, { status: 503 }), { kind: "unknown", status: 503 }],
    [
      "a captive portal page",
      () =>
        new Response("<html>Sign in to Wi-Fi</html>", { headers: { "content-type": "text/html" } }),
      { kind: "unknown", status: 200 },
    ],
  ])("reads %s from get-session", async (_name, respond, expected) => {
    answer = respond;
    expect(await client("nightly").checkAuthSession()).toEqual(expected);
  });

  test("a failed fetch is unreachable, not ended", async () => {
    answer = () => Promise.reject(new TypeError("fetch failed"));
    expect(await client("nightly").checkAuthSession()).toMatchObject({ kind: "unreachable" });
  });

  test("without encryption and nothing in memory, it does not ask the API", async () => {
    electron.state.encryption = false;
    answer = () => json(null);
    expect(await client("nightly").checkAuthSession()).toEqual({ kind: "unknown", status: 0 });
    expect(sent).toEqual([]);
  });
});
