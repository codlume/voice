import { expect, vi } from "vite-plus/test";

import { VOICE_URL_SCHEME, type AccountState } from "../shared/api.ts";
import {
  SIGN_IN_TIMEOUT_MS,
  createAccount,
  type AuthClient,
  type AuthSessionCheck,
  type Identity,
  type DeleteAccountResult,
  type ServerSignOut,
} from "./account.ts";
import type { DiagnosticLog } from "./diagnostics-scrub.ts";
import { idle } from "./session.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { createStore, toSnapshot } from "./store.ts";

export const API_URL = "https://api-nightly.voice.codlume.com";
export const USER = { name: "Ada Lovelace", email: "ada@example.com" };
export const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
export const CODE = encode({ identifier: "electron_authorization_code_1", state: "state1" });
export const SECOND_CODE = encode({ identifier: "electron_authorization_code_2", state: "state2" });
export const callbackUrl = (token: string) => `${VOICE_URL_SCHEME}://auth/callback#token=${token}`;

type Call = {
  signal: AbortSignal;
  resolve: () => void;
  reject: (error: Error) => void;
  fail: (kind: "offline" | "rejected", error: Error) => void;
};
type BrowserCall = { resolve: (state?: string) => void; reject: (error: Error) => void };
type Check = { answer: (value: AuthSessionCheck) => void; signal: AbortSignal };

export function fakeClient() {
  const requests: BrowserCall[] = [];
  const exchanges: (Call & { code: string })[] = [];
  const checks: Check[] = [];
  const deletions: { answer: (value: DeleteAccountResult) => void }[] = [];
  const revocations = vi.fn(async () => {});
  const signOuts: { answer: (value: ServerSignOut) => void }[] = [];
  let serverSignOuts = 0;
  let stored = false;
  let user = USER;
  let cached: Identity | null = USER;
  let forgotten = 0;
  const client: AuthClient = {
    openBrowser: () =>
      new Promise<{ state: string }>((resolve, reject) => {
        requests.push({ resolve: (state = "state1") => resolve({ state }), reject });
      }),
    redeem: (code, signal) =>
      new Promise((resolve) => {
        exchanges.push({
          code,
          signal,
          // As the real adapter: an aborted exchange persists nothing, whatever the API answers.
          resolve: () => {
            if (signal.aborted) {
              resolve({ kind: "abandoned" });
              return;
            }
            stored = true;
            cached = user;
            resolve({ kind: "signedIn", ...user });
          },
          reject: (error) => resolve({ kind: "rejected", error }),
          fail: (kind, error) => resolve({ kind, error }),
        });
      }),
    deleteAccount: () => new Promise((resolve) => deletions.push({ answer: resolve })),
    revokeOlderAuthSession: revocations,
    cachedUser: () => cached,
    hasAuthSession: () => stored,
    checkAuthSession: (signal) =>
      new Promise((resolve) => {
        checks.push({ answer: resolve, signal });
      }),
    forget: () => {
      forgotten += 1;
      cached = null;
      stored = false;
    },
    queueServerSignOut: () => {
      serverSignOuts += 1;
    },
    retireAuthSession: () => {
      if (stored) client.queueServerSignOut("fixture-cookie");
      client.forget();
    },
    endServerSignOuts: () =>
      serverSignOuts === 0
        ? Promise.resolve([])
        : new Promise((resolve) => {
            signOuts.push({
              answer: (value) => {
                if (value.kind === "ended") serverSignOuts = 0;
                resolve([value]);
              },
            });
          }),
  };
  return {
    client,
    requests,
    exchanges,
    checks,
    signOuts,
    deletions,
    revocations,
    get stored() {
      return stored;
    },
    setStored: (value: boolean) => {
      stored = value;
    },
    get serverSignOuts() {
      return serverSignOuts;
    },
    get forgotten() {
      return forgotten;
    },
    setUser: (next: typeof USER) => {
      user = next;
    },
    setCached: (next: Identity | null) => {
      cached = next;
    },
  };
}

export function harness(
  options: {
    apiUrl?: string | null;
    development?: boolean;
    hasStoredAuthSession?: () => boolean;
    hasStoredAuth?: () => boolean;
    createClient?: Parameters<typeof createAccount>[0]["createClient"];
    fake?: ReturnType<typeof fakeClient>;
  } = {},
) {
  const apiUrl = options.apiUrl === undefined ? API_URL : options.apiUrl;
  const fake = options.fake ?? fakeClient();
  if (!options.fake && options.hasStoredAuthSession) fake.setStored(options.hasStoredAuthSession());
  const createClient = vi.fn(options.createClient ?? (async () => fake.client));
  const logs: string[] = [];
  const entries: DiagnosticLog[] = [];
  const account = createAccount({
    apiUrl,
    development: options.development ?? false,
    hasStoredAuthSession: options.hasStoredAuthSession ?? (() => fake.stored),
    hasStoredAuth:
      options.hasStoredAuth ??
      (() => (options.hasStoredAuthSession?.() ?? fake.stored) || fake.serverSignOuts > 0),
    createClient,
    signInTimeoutMs: SIGN_IN_TIMEOUT_MS,
    onChange: (value) => store.update((s) => ({ ...s, account: value })),
    log: (message, entry) => {
      logs.push(message);
      if (entry) entries.push(entry);
    },
  });
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
    account: account.state,
    last: null,
  });
  const states: AccountState[] = [];
  store.subscribe((state) => states.push(toSnapshot(state).account));
  return {
    store,
    account,
    createClient,
    logs,
    entries,
    states,
    fake,
    requests: fake.requests,
    exchanges: fake.exchanges,
    checks: fake.checks,
    setUser: fake.setUser,
    get state() {
      return toSnapshot(store.state).account;
    },
  };
}

export async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

export async function startSignIn(h: ReturnType<typeof harness>, state = "state1") {
  const signIn = h.account.signIn();
  await flush();
  expect(h.state).toEqual({ kind: "signingIn", purpose: "signIn", phase: "browser" });
  h.requests.at(-1)?.resolve(state);
  await signIn;
}

export function expectNoSecrets(h: ReturnType<typeof harness>) {
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

export const withStoredAuthSession = () => true;

// Each resolves once the check is in flight, with the call's own promise wrapped so that
// awaiting the helper does not wait for the API's answer.
export async function restore(h: ReturnType<typeof harness>) {
  const done = h.account.restore();
  await flush();
  return { done };
}

export async function refresh(h: ReturnType<typeof harness>) {
  const done = h.account.refresh();
  await flush();
  return { done };
}
