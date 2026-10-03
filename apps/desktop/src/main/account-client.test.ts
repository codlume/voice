import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { storage } from "@better-auth/electron/storage";
import { createVoiceAuthClient } from "./account-client.ts";
import { authSessionStored, retiredAuthSessionStored } from "./account-storage.ts";

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
    { token, session: { token }, user: USER },
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

describe("retired auth sessions", () => {
  const config = () => readFileSync(NodePath.join(electron.state.userData, "config.json"), "utf8");
  async function signedInClient(token = "old-token") {
    answer = () => signedIn(token);
    const active = client("nightly");
    await active.checkAuthSession();
    return active;
  }
  const confirmed = (url: string) =>
    url.endsWith("/sign-out") ? json({ success: true }) : json(null);

  test("clears active auth at once and stores only encrypted retry cookies", async () => {
    const active = await signedInClient();
    active.retireAuthSession();
    expect(authSessionStored(electron.state.userData, "nightly")).toBe(false);
    expect(active.cachedUser()).toBeNull();
    expect(retiredAuthSessionStored(electron.state.userData, "nightly")).toBe(true);
    expect(config()).not.toContain("old-token");
    answer = confirmed;
    expect(await active.endRetiredAuthSessions()).toEqual([{ kind: "ended", status: 200 }]);
    expect(sent.slice(-2).map(({ url, cookie }) => [url, cookie])).toEqual([
      [`${API.nightly}/api/auth/sign-out`, "better-auth.session_token=old-token"],
      [`${API.nightly}/api/auth/get-session`, "better-auth.session_token=old-token"],
    ]);
    expect(retiredAuthSessionStored(electron.state.userData, "nightly")).toBe(false);
  });

  test.each(["offline", "503"])(
    "retains %s sign-outs for a later launch and removes them only after confirmation",
    async (failure) => {
      const active = await signedInClient();
      active.retireAuthSession();
      answer =
        failure === "offline"
          ? () => Promise.reject(new TypeError("fetch failed"))
          : () => json({}, { status: 503 });
      expect((await active.endRetiredAuthSessions())[0]?.kind).toBe(
        failure === "offline" ? "unreachable" : "unknown",
      );
      expect(retiredAuthSessionStored(electron.state.userData, "nightly")).toBe(true);
      const restarted = client("nightly");
      expect(restarted.cachedUser()).toBeNull();
      answer = confirmed;
      expect(await restarted.endRetiredAuthSessions()).toEqual([{ kind: "ended", status: 200 }]);
      expect(retiredAuthSessionStored(electron.state.userData, "nightly")).toBe(false);
      expect(authSessionStored(electron.state.userData, "nightly")).toBe(false);
    },
  );

  test.each(["active", "HTML", "malformed JSON", "403"])(
    "retains the retry after %s rather than trusting POST success",
    async (failure) => {
      const active = await signedInClient();
      active.retireAuthSession();
      answer = (url) => {
        if (failure === "403") return json({ code: "INVALID_ORIGIN" }, { status: 403 });
        if (failure === "HTML") return new Response("<html>Sign in to Wi-Fi</html>");
        if (failure === "malformed JSON") return new Response("{");
        return url.endsWith("/sign-out") ? json({ success: true }) : signedIn("old-token");
      };
      expect((await active.endRetiredAuthSessions())[0]?.kind).not.toBe("ended");
      expect(retiredAuthSessionStored(electron.state.userData, "nightly")).toBe(true);
      expect(authSessionStored(electron.state.userData, "nightly")).toBe(false);
    },
  );

  test("a late get-session cannot write an old cookie or identity back after retirement", async () => {
    const active = await signedInClient();
    const pending = Promise.withResolvers<Response>();
    answer = () => pending.promise;
    const oldCheck = active.checkAuthSession();
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    active.retireAuthSession();
    answer = () => signedIn("new-token");
    await active.checkAuthSession();
    pending.resolve(signedIn("old-token"));
    await oldCheck;
    answer = confirmed;
    await active.endRetiredAuthSessions();
    expect(active.cachedUser()).toEqual(USER);
    expect(authSessionStored(electron.state.userData, "nightly")).toBe(true);
    answer = () => json(null);
    await active.checkAuthSession();
    expect(sent.at(-1)?.cookie).toBe("better-auth.session_token=new-token");
  });

  test("keeps multiple offline sign-outs and does not send them to another channel", async () => {
    const active = await signedInClient("token-a");
    active.retireAuthSession();
    answer = () => signedIn("token-b");
    await active.checkAuthSession();
    active.retireAuthSession();
    answer = confirmed;
    expect(await client("stable").endRetiredAuthSessions()).toEqual([]);
    const restarted = client("nightly");
    expect(await restarted.endRetiredAuthSessions()).toEqual([
      { kind: "ended", status: 200 },
      { kind: "ended", status: 200 },
    ]);
    expect(sent.slice(-4).map(({ cookie }) => cookie)).toEqual([
      "better-auth.session_token=token-a",
      "better-auth.session_token=token-a",
      "better-auth.session_token=token-b",
      "better-auth.session_token=token-b",
    ]);
    expect(retiredAuthSessionStored(electron.state.userData, "nightly")).toBe(false);
  });

  test("drains a sign-out added while another is in flight without overlapping retries", async () => {
    const active = await signedInClient("token-a");
    active.retireAuthSession();
    const pending = Promise.withResolvers<Response>();
    answer = () => pending.promise;
    const first = active.endRetiredAuthSessions();
    await vi.waitFor(() => expect(sent.at(-1)?.url).toContain("/sign-out"));
    answer = () => signedIn("token-b");
    await active.checkAuthSession();
    active.retireAuthSession();
    expect(active.endRetiredAuthSessions()).toBe(first);
    answer = confirmed;
    pending.resolve(json({ success: true }));
    expect(await first).toEqual([
      { kind: "ended", status: 200 },
      { kind: "ended", status: 200 },
    ]);
    expect(retiredAuthSessionStored(electron.state.userData, "nightly")).toBe(false);
    expect(sent.filter(({ url }) => url.endsWith("/sign-out")).map(({ cookie }) => cookie)).toEqual(
      ["better-auth.session_token=token-a", "better-auth.session_token=token-b"],
    );
  });

  test("unavailable encryption never overwrites an existing encrypted retry queue", async () => {
    const active = await signedInClient();
    active.retireAuthSession();
    const encrypted = storage().getItem("voice.nightly.retired_auth_sessions");
    electron.state.encryption = false;
    expect(await client("nightly").endRetiredAuthSessions()).toEqual([]);
    expect(storage().getItem("voice.nightly.retired_auth_sessions")).toBe(encrypted);
    electron.state.encryption = true;
    answer = confirmed;
    expect(await client("nightly").endRetiredAuthSessions()).toEqual([
      { kind: "ended", status: 200 },
    ]);
  });

  test("reconciles a crash after enqueueing, leaving a newer active cookie alone", async () => {
    await signedInClient();
    storage().setItem(
      "voice.nightly.retired_auth_sessions",
      electron.api.safeStorage
        .encryptString(JSON.stringify(["better-auth.session_token=old-token"]))
        .toString("base64"),
    );
    const restarted = client("nightly");
    expect(authSessionStored(electron.state.userData, "nightly")).toBe(false);
    expect(restarted.cachedUser()).toBeNull();
    answer = () => signedIn("new-token");
    await restarted.checkAuthSession();
    expect(client("nightly").cachedUser()).toEqual(USER);
    expect(authSessionStored(electron.state.userData, "nightly")).toBe(true);
  });

  test("with no encryption, clears private plugin memory and never persists a retry token", async () => {
    electron.state.encryption = false;
    const active = client("nightly");
    const { state } = await active.openBrowser();
    answer = () => signedIn("memory-token");
    const code = Buffer.from(JSON.stringify({ identifier: "test-code", state })).toString(
      "base64url",
    );
    expect(await active.redeem(code)).toMatchObject({ kind: "signedIn" });
    active.retireAuthSession();
    expect(authSessionStored(electron.state.userData, "nightly")).toBe(false);
    expect(await active.checkAuthSession()).toEqual({ kind: "unknown", status: 0 });
    expect(config()).not.toContain("memory-token");
    expect(retiredAuthSessionStored(electron.state.userData, "nightly")).toBe(false);
    answer = confirmed;
    expect(await active.endRetiredAuthSessions()).toEqual([{ kind: "ended", status: 200 }]);
    expect(sent.at(-1)?.cookie).toBe("better-auth.session_token=memory-token");
  });
});
