import { readFileSync } from "node:fs";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { VOICE_URL_SCHEME, type AccountState } from "../shared/api.ts";
import {
  API_URLS,
  OPEN_BROWSER_FAILED_MESSAGE,
  PASTE_CODE_MESSAGE,
  SIGN_IN_FAILED_MESSAGE,
  SIGN_IN_TIMEOUT_MS,
  createAccount,
  initialAccountState,
  parseCallbackUrl,
  parseSignInCode,
  resolveApiUrl,
  type AuthClient,
} from "./account.ts";
import type { DiagnosticLog } from "./diagnostics-scrub.ts";
import { idle } from "./session.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { createStore, toSnapshot } from "./store.ts";

const API_URL = "https://api-nightly.voice.codlume.com";
const USER = { name: "Ada Lovelace", email: "ada@example.com" };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const CODE = encode({ identifier: "electron_authorization_code_1", state: "state1" });
const callbackUrl = (token: string) => `${VOICE_URL_SCHEME}://auth/callback#token=${token}`;

type Call<T> = { options: T; resolve: () => void; reject: (error: Error) => void };

function fakeClient() {
  const requests: Call<{ provider: "google" }>[] = [];
  const exchanges: Call<{ token: string; fetchOptions: { throw: true } }>[] = [];
  let user = USER;
  const client: AuthClient = {
    requestAuth: (options) =>
      new Promise<void>((resolve, reject) => {
        requests.push({ options, resolve, reject });
      }),
    authenticate: (options) =>
      new Promise((resolve, reject) => {
        exchanges.push({ options, resolve: () => resolve({ user }), reject });
      }),
  };
  return {
    client,
    requests,
    exchanges,
    setUser: (next: typeof USER) => {
      user = next;
    },
  };
}

function harness(options: { apiUrl?: string | null } = {}) {
  const apiUrl = options.apiUrl === undefined ? API_URL : options.apiUrl;
  const initial = initialAccountState(apiUrl, false);
  const store = createStore({
    session: idle,
    permissions: { microphone: "granted", accessibility: "granted" },
    loginItem: "off",
    models: { asr: { state: "ready" }, cleanup: { state: "ready" } },
    settings: DEFAULT_SETTINGS,
    updates: {
      version: "0.0.1",
      installedChannel: "nightly",
      channel: "nightly",
      status: { kind: "disabled", reason: "Test" },
    },
    microphones: { kind: "loading" },
    microphoneTest: { kind: "off" },
    account: initial,
    last: null,
  });
  const fake = fakeClient();
  const createClient = vi.fn(async () => fake.client);
  const logs: string[] = [];
  const entries: DiagnosticLog[] = [];
  const states: AccountState[] = [];
  store.subscribe((state) => states.push(toSnapshot(state).account));
  const account = createAccount({
    apiUrl,
    initial,
    createClient,
    onChange: (value) => store.update((s) => ({ ...s, account: value })),
    log: (message, entry) => {
      logs.push(message);
      if (entry) entries.push(entry);
    },
  });
  return {
    store,
    account,
    createClient,
    logs,
    entries,
    states,
    ...fake,
    get state() {
      return toSnapshot(store.state).account;
    },
  };
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

async function startSignIn(h: ReturnType<typeof harness>) {
  const signIn = h.account.signIn();
  await flush();
  expect(h.state).toEqual({ kind: "signingIn" });
  h.requests.at(-1)?.resolve();
  await signIn;
}

function expectNoSecrets(h: ReturnType<typeof harness>) {
  const written = [...h.logs, ...h.entries.map((entry) => JSON.stringify(entry))];
  for (const text of written) {
    expect(text).not.toContain(USER.email);
    expect(text).not.toContain(CODE);
    expect(text).not.toContain("#token=");
    expect(text).not.toContain(API_URL);
  }
  for (const state of h.states) {
    expect(JSON.stringify(state)).not.toContain(CODE);
  }
}

describe("resolveApiUrl", () => {
  const release = { channel: "nightly" as const, updateUrl: "https://downloads.example.com" };

  test("a development build reads VOICE_API_URL only", () => {
    expect(
      resolveApiUrl({
        development: true,
        release,
        env: { VOICE_API_URL: "http://localhost:8787/" },
      }),
    ).toBe("http://localhost:8787");
    expect(resolveApiUrl({ development: true, release, env: {} })).toBeNull();
    expect(
      resolveApiUrl({ development: true, release: null, env: { VOICE_API_URL: "" } }),
    ).toBeNull();
    for (const value of [
      "localhost:8787",
      "ftp://localhost:8787",
      "http://user:secret@localhost:8787",
      "http://localhost:8787?token=x",
      "http://localhost:8787#x",
      "not a url",
    ]) {
      expect(
        resolveApiUrl({ development: true, release, env: { VOICE_API_URL: value } }),
      ).toBeNull();
    }
  });

  test("a packaged build uses its channel's entry and ignores the environment", () => {
    const env = { VOICE_API_URL: "http://localhost:8787" };
    expect(resolveApiUrl({ development: false, release, env })).toBe(API_URLS.nightly);
    expect(API_URLS.nightly).toBe(API_URL);
    expect(
      resolveApiUrl({ development: false, release: { ...release, channel: "stable" }, env }),
    ).toBeNull();
    expect(resolveApiUrl({ development: false, release: null, env })).toBeNull();
  });

  test("the initial state names the fix for a development build", () => {
    expect(initialAccountState(API_URL, true)).toEqual({ kind: "signedOut" });
    expect(initialAccountState(null, true)).toEqual({
      kind: "unavailable",
      reason: expect.stringContaining("VOICE_API_URL"),
    });
    expect(initialAccountState(null, false)).toEqual({
      kind: "unavailable",
      reason: "Accounts are unavailable in this build.",
    });
  });
});

describe("parseSignInCode", () => {
  test("accepts the cookie value, trimmed, padded or percent-encoded", () => {
    expect(parseSignInCode(CODE)).toBe(CODE);
    expect(parseSignInCode(`  ${CODE}\n`)).toBe(CODE);
    const padded = Buffer.from(JSON.stringify({ identifier: "i", state: "st" })).toString("base64");
    expect(padded.endsWith("=")).toBe(true);
    expect(parseSignInCode(padded)).toBe(padded);
    const encoded = encodeURIComponent(padded);
    expect(encoded).toContain("%3D");
    expect(parseSignInCode(encoded)).toBe(encoded);
  });

  test("rejects anything that is not base64url JSON with an identifier and a state", () => {
    for (const value of [
      "",
      "   ",
      "electron_authorization_code_1",
      encode({ identifier: "i" }),
      encode({ state: "s" }),
      encode({ identifier: 1, state: "s" }),
      encode("text"),
      encode(null),
      `${CODE}!`,
      "%E0%A4%A",
    ]) {
      expect(parseSignInCode(value)).toBeNull();
    }
  });
});

describe("parseCallbackUrl", () => {
  test("accepts only the app scheme, the callback path and a valid token", () => {
    expect(parseCallbackUrl(callbackUrl(CODE))).toBe(CODE);
    const padded = Buffer.from(JSON.stringify({ identifier: "i", state: "st" })).toString("base64");
    expect(parseCallbackUrl(callbackUrl(encodeURIComponent(padded)))).toBe(padded);
    for (const url of [
      `https://auth/callback#token=${CODE}`,
      `${VOICE_URL_SCHEME}://auth/other#token=${CODE}`,
      `${VOICE_URL_SCHEME}://other/callback#token=${CODE}`,
      `${VOICE_URL_SCHEME}://auth/callback`,
      `${VOICE_URL_SCHEME}://auth/callback#token=`,
      `${VOICE_URL_SCHEME}://auth/callback?token=${CODE}`,
      callbackUrl("electron_authorization_code_1"),
      callbackUrl("%E0%A4%A"),
      "not a url",
    ]) {
      expect(parseCallbackUrl(url)).toBeNull();
    }
  });
});

describe("createAccount", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("signs in through the callback URL and keeps the token out of the snapshot", async () => {
    const h = harness();
    expect(h.state).toEqual({ kind: "signedOut" });
    await startSignIn(h);
    expect(h.requests.map((call) => call.options)).toEqual([{ provider: "google" }]);
    h.account.handleCallbackUrl(callbackUrl(CODE));
    await flush();
    expect(h.exchanges.map((call) => call.options)).toEqual([
      { token: CODE, fetchOptions: { throw: true } },
    ]);
    h.exchanges[0]?.resolve();
    await flush();
    expect(h.state).toEqual({ kind: "signedIn", ...USER });
    expect(h.states).toEqual([{ kind: "signingIn" }, { kind: "signedIn", ...USER }]);
    expectNoSecrets(h);
  });

  test("signs in through a pasted code with surrounding whitespace", async () => {
    const h = harness();
    await startSignIn(h);
    const submitted = h.account.submitSignInCode(`  ${CODE}\n`);
    await flush();
    expect(h.exchanges[0]?.options.token).toBe(CODE);
    h.exchanges[0]?.resolve();
    await submitted;
    expect(h.state).toEqual({ kind: "signedIn", ...USER });
    expectNoSecrets(h);
  });

  test("a callback after cancel is ignored and never redeemed", async () => {
    const h = harness();
    await startSignIn(h);
    h.account.cancelSignIn();
    expect(h.state).toEqual({ kind: "signedOut" });
    h.account.handleCallbackUrl(callbackUrl(CODE));
    await h.account.submitSignInCode(CODE);
    await flush();
    expect(h.exchanges).toEqual([]);
    expect(h.state).toEqual({ kind: "signedOut" });
    await vi.advanceTimersByTimeAsync(SIGN_IN_TIMEOUT_MS);
    expect(h.states.filter((state) => state.kind === "signedOut")).toHaveLength(1);
    expectNoSecrets(h);
  });

  test("times out back to signed out and ignores a later callback", async () => {
    const h = harness();
    await startSignIn(h);
    await vi.advanceTimersByTimeAsync(SIGN_IN_TIMEOUT_MS - 1);
    expect(h.state).toEqual({ kind: "signingIn" });
    await vi.advanceTimersByTimeAsync(1);
    expect(h.state).toEqual({ kind: "signedOut" });
    expect(h.entries).toContainEqual({ message: "account sign-in timed out", level: "warn" });
    h.account.handleCallbackUrl(callbackUrl(CODE));
    await flush();
    expect(h.exchanges).toEqual([]);
    expect(h.state).toEqual({ kind: "signedOut" });
    expectNoSecrets(h);
  });

  test("a callback with nothing pending is ignored", async () => {
    const h = harness();
    h.account.handleCallbackUrl(callbackUrl(CODE));
    await flush();
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.exchanges).toEqual([]);
    expect(h.states).toEqual([]);
    expectNoSecrets(h);
  });

  test("malformed callbacks and pastes leave the attempt open", async () => {
    const h = harness();
    await startSignIn(h);
    for (const url of [
      `https://auth/callback#token=${CODE}`,
      `${VOICE_URL_SCHEME}://auth/other#token=${CODE}`,
      `${VOICE_URL_SCHEME}://auth/callback`,
      callbackUrl("electron_authorization_code_1"),
    ]) {
      h.account.handleCallbackUrl(url);
    }
    await expect(h.account.submitSignInCode("electron_authorization_code_1")).rejects.toThrow(
      PASTE_CODE_MESSAGE,
    );
    await flush();
    expect(h.exchanges).toEqual([]);
    expect(h.state).toEqual({ kind: "signingIn" });
    expect(h.logs.filter((line) => line === "account: malformed callback URL")).toHaveLength(4);
    expectNoSecrets(h);
  });

  test("a rejected exchange lands in error, which dismisses or retries from scratch", async () => {
    const h = harness();
    await startSignIn(h);
    h.account.handleCallbackUrl(callbackUrl(CODE));
    await flush();
    const failure = new Error("Code verifier not found.");
    failure.name = "BetterAuthError";
    h.exchanges[0]?.reject(failure);
    await flush();
    expect(h.state).toEqual({ kind: "error", message: SIGN_IN_FAILED_MESSAGE });
    expect(h.entries).toContainEqual({
      message: "account sign-in failed",
      level: "warn",
      attributes: { "error.type": "BetterAuthError" },
    });
    h.account.dismissError();
    expect(h.state).toEqual({ kind: "signedOut" });
    await startSignIn(h);
    h.account.handleCallbackUrl(callbackUrl(CODE));
    await flush();
    h.exchanges[1]?.reject(failure);
    await flush();
    expect(h.state.kind).toBe("error");
    await startSignIn(h);
    expect(h.requests).toHaveLength(3);
    expect(h.createClient).toHaveBeenCalledOnce();
    expectNoSecrets(h);
  });

  test("a browser that cannot open lands in error", async () => {
    const h = harness();
    const signIn = h.account.signIn();
    await flush();
    h.requests[0]?.reject(new Error("no handler"));
    await signIn;
    expect(h.state).toEqual({ kind: "error", message: OPEN_BROWSER_FAILED_MESSAGE });
    expectNoSecrets(h);
  });

  test("a result from an older attempt is dropped", async () => {
    const h = harness();
    await startSignIn(h);
    h.account.handleCallbackUrl(callbackUrl(CODE));
    await flush();
    h.account.cancelSignIn();
    await startSignIn(h);
    h.exchanges[0]?.resolve();
    await flush();
    expect(h.state).toEqual({ kind: "signingIn" });
    h.account.handleCallbackUrl(callbackUrl(CODE));
    await flush();
    h.setUser({ name: "Second", email: "second@example.com" });
    h.exchanges[1]?.resolve();
    await flush();
    expect(h.state).toEqual({ kind: "signedIn", name: "Second", email: "second@example.com" });
    expectNoSecrets(h);
  });

  test("a build without an API URL is unavailable and never builds a client", async () => {
    const h = harness({ apiUrl: null });
    expect(h.state).toEqual({
      kind: "unavailable",
      reason: "Accounts are unavailable in this build.",
    });
    await h.account.signIn();
    h.account.handleCallbackUrl(callbackUrl(CODE));
    await h.account.submitSignInCode(CODE);
    h.account.cancelSignIn();
    h.account.dismissError();
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.states).toEqual([]);
    expectNoSecrets(h);
  });

  test("builds the client on the first sign-in only", async () => {
    const h = harness();
    expect(h.createClient).not.toHaveBeenCalled();
    await startSignIn(h);
    expect(h.createClient).toHaveBeenCalledWith(API_URL);
    h.account.cancelSignIn();
    await startSignIn(h);
    expect(h.createClient).toHaveBeenCalledOnce();
    expect(h.requests).toHaveLength(2);
  });

  test("a failed client build lands in error and is retried on the next sign-in", async () => {
    const h = harness();
    h.createClient.mockRejectedValueOnce(new Error("import failed"));
    await h.account.signIn();
    expect(h.state).toEqual({ kind: "error", message: OPEN_BROWSER_FAILED_MESSAGE });
    await startSignIn(h);
    expect(h.createClient).toHaveBeenCalledTimes(2);
  });

  test("sign-in while signing in or signed in does nothing", async () => {
    const h = harness();
    await startSignIn(h);
    await h.account.signIn();
    expect(h.requests).toHaveLength(1);
    h.account.handleCallbackUrl(callbackUrl(CODE));
    await flush();
    h.exchanges[0]?.resolve();
    await flush();
    await h.account.signIn();
    expect(h.requests).toHaveLength(1);
    expect(h.state).toEqual({ kind: "signedIn", ...USER });
  });

  test("dispose drops a pending attempt without a late result", async () => {
    const h = harness();
    await startSignIn(h);
    h.account.handleCallbackUrl(callbackUrl(CODE));
    await flush();
    h.account.dispose();
    h.exchanges[0]?.resolve();
    await vi.advanceTimersByTimeAsync(SIGN_IN_TIMEOUT_MS);
    expect(h.states).toEqual([{ kind: "signingIn" }]);
  });
});

describe("URL scheme", () => {
  test("electron-builder registers the scheme the account module expects", () => {
    const yaml = readFileSync(
      NodePath.join(import.meta.dirname, "../../electron-builder.yml"),
      "utf8",
    );
    const schemes =
      /^protocols:\n(?:[ \t]+[^\n]*\n)*?[ \t]+schemes:\n((?:[ \t]+- [^\n]*\n)+)/m.exec(yaml)?.[1];
    expect(schemes).toBeDefined();
    expect([...(schemes ?? "").matchAll(/- (\S+)/g)].map((match) => match[1])).toEqual([
      VOICE_URL_SCHEME,
    ]);
  });
});
