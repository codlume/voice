import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";
import { storage } from "@better-auth/electron/storage";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vite-plus/test";
import type { UpdateChannel } from "../shared/api.ts";
import { createVoiceAuthClient } from "./account-client.ts";
import { harness } from "./account.test-harness.ts";
import { authSessionStored, authStorageKeys, authStored } from "./account-storage.ts";

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
export { electron };

export const API = {
  stable: "https://api.example.com",
  nightly: "https://api-nightly.example.com",
};
export const USER = { id: "ada-id", name: "Ada Lovelace", email: "ada@example.com" };
export const GRACE = { id: "grace-id", name: "Grace Hopper", email: "grace@example.com" };

type Sent = { url: string; cookie: string | null; body: string };
export const log = vi.fn();
export const http: { sent: Sent[]; answer: (url: string) => Response | Promise<Response> } = {
  sent: [],
  answer: () => {
    throw new Error("Unexpected auth request");
  },
};

export const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
export const signedIn = (token: string, user: Record<string, unknown> = USER) =>
  json(
    { token, session: { token }, user },
    { headers: { "set-cookie": `better-auth.session_token=${token}; Max-Age=3600; Path=/` } },
  );
export const client = (channel: UpdateChannel) =>
  createVoiceAuthClient({ apiUrl: API[channel], installedChannel: channel, log });

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
  http.sent = [];
  log.mockClear();
  vi.stubGlobal("fetch", async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    http.sent.push({
      url: request.url,
      cookie: request.headers.get("cookie") || null,
      body: await request.text(),
    });
    return new Promise<Response>((resolve, reject) => {
      // As real fetch does, an aborted signal rejects, before or during the request. The caller's
      // own signal, because the copy a Request makes follows it only weakly and can be collected.
      const signal = init?.signal ?? request.signal;
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason));
      Promise.resolve(http.answer(request.url)).then(resolve, reject);
    });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(electron.state.userData, { recursive: true, force: true });
});

/** Each request so far as its path and Cookie header. */
export const requests = () =>
  http.sent.map(({ url, cookie }) => [new URL(url).pathname, cookie] as const);

export const config = () =>
  readFileSync(NodePath.join(electron.state.userData, "config.json"), "utf8");
export const storedIdentity = (channel: UpdateChannel) =>
  (JSON.parse(config()) as Record<string, Record<string, Record<string, unknown>>>).voice?.[channel]
    ?.identity;
export const writeCachedIdentity = (identity: unknown) =>
  storage().setItem(
    authStorageKeys("nightly").identity,
    electron.api.safeStorage.encryptString(JSON.stringify(identity)).toString("base64"),
  );

/** Plays a whole sign-in: the browser opens, then the landing page's code is redeemed. */
export async function signIn(auth: ReturnType<typeof client>) {
  const { state } = await auth.openBrowser();
  const code = Buffer.from(JSON.stringify({ identifier: "code-1", state })).toString("base64url");
  return auth.redeem(code, new AbortController().signal);
}

export async function signedInClient(token = "old-token") {
  http.answer = () => signedIn(token);
  const active = client("nightly");
  await active.checkAuthSession(new AbortController().signal);
  return active;
}

export function snapshotAccount(auth: ReturnType<typeof client>) {
  return harness({
    apiUrl: API.nightly,
    createClient: async () => auth,
    hasStoredAuthSession: () => authSessionStored(electron.state.userData, "nightly"),
    hasStoredAuth: () => authStored(electron.state.userData, "nightly"),
  });
}

export async function signInCode(h: ReturnType<typeof harness>, auth: ReturnType<typeof client>) {
  const opened = vi.spyOn(auth, "openBrowser");
  await h.account.signIn();
  const opening = opened.mock.results.at(-1);
  if (!opening) throw new Error("Sign-in did not open the browser");
  const { state } = await opening.value;
  return Buffer.from(JSON.stringify({ identifier: "reauth-code", state })).toString("base64url");
}
