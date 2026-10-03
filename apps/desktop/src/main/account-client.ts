import { writeFileSync } from "node:fs";

import { electronClient } from "@better-auth/electron/client";
import { storage } from "@better-auth/electron/storage";
import { createAuthClient, type BetterAuthClientPlugin } from "better-auth/client";
import { safeStorage, shell } from "electron";

import { VOICE_URL_SCHEME, type UpdateChannel } from "../shared/api.ts";
import type {
  AuthClient,
  AuthSessionCheck,
  Identity,
  RedeemResult,
  ServerSignOut,
} from "./account.ts";
import { authStoragePrefix } from "./account-storage.ts";

// The token and `get-session` bodies both carry `{ user }`. They are external data, so the
// user is read from them like any other.
function userOf(body: unknown): Identity | null {
  const user = typeof body === "object" && body !== null && "user" in body ? body.user : null;
  if (
    typeof user === "object" &&
    user !== null &&
    "name" in user &&
    typeof user.name === "string" &&
    "email" in user &&
    typeof user.email === "string"
  ) {
    return { name: user.name, email: user.email };
  }
  return null;
}

// The plugin's declared fetch hooks do not satisfy better-auth's own plugin type under
// exactOptionalPropertyTypes (optional request fields typed without `| undefined`). Only that
// property is widened, so the client keeps the plugin's typed actions.
type ElectronPlugin = Omit<ReturnType<typeof electronClient>, "fetchPlugins"> &
  Pick<BetterAuthClientPlugin, "fetchPlugins">;

// The only file that loads Better Auth. It is imported lazily, on the first Sign in click or at
// launch when an auth session is stored. The plugin encrypts what it stores with safeStorage and
// keeps it in memory only when encryption is unavailable.
export function createVoiceAuthClient({
  apiUrl,
  installedChannel,
  signInUrlFile,
}: {
  apiUrl: string;
  installedChannel: UpdateChannel;
  /** Test mode: the plugin's `shell.openExternal` writes the sign-in URL here instead. */
  signInUrlFile?: string;
}): AuthClient {
  const prefix = authStoragePrefix(installedChannel);
  const store = storage();
  let generation = 0;
  function makeClient() {
    const current = generation;
    const plugin = electronClient({
      protocol: VOICE_URL_SCHEME,
      // Required by the plugin's types, read only for sign-in without a provider.
      signInURL: apiUrl,
      storagePrefix: prefix,
      storage: {
        getItem: store.getItem,
        // A request started before local sign-out must not restore its cookie or identity.
        setItem: (key, value) => {
          if (current === generation) store.setItem(key, value);
        },
      },
      userImageProxy: { enabled: false },
    }) as ElectronPlugin;
    return createAuthClient({ baseURL: apiUrl, plugins: [plugin] });
  }
  let client = makeClient();
  const retiredKey = `${prefix}.retired_auth_sessions`;
  let retired: string[] = [];
  const storedRetired = store.getItem(retiredKey);
  if (typeof storedRetired === "string" && safeStorage.isEncryptionAvailable()) {
    const parsed: unknown = JSON.parse(
      safeStorage.decryptString(Buffer.from(storedRetired, "base64")),
    );
    if (!Array.isArray(parsed) || !parsed.every((cookie) => typeof cookie === "string")) {
      throw new Error("Invalid stored sign-outs.");
    }
    retired = parsed;
  }

  function saveRetired(next: string[]) {
    if (!safeStorage.isEncryptionAvailable()) return;
    store.setItem(
      retiredKey,
      next.length ? safeStorage.encryptString(JSON.stringify(next)).toString("base64") : null,
    );
  }

  function forget() {
    generation += 1;
    store.setItem(`${prefix}.cookie`, null);
    store.setItem(`${prefix}.local_cache`, null);
    // The plugin also has private memory storage when encryption is unavailable.
    client = makeClient();
  }

  if (retired.length && (!client.getCookie() || retired.includes(client.getCookie()))) forget();

  async function endAuthSession(cookie: string): Promise<ServerSignOut> {
    const headers = { cookie, origin: `${VOICE_URL_SCHEME}:/`, "content-type": "application/json" };
    const request = (path: string, init: RequestInit = {}) =>
      fetch(`${apiUrl}/api/auth/${path}`, {
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers,
        ...init,
      });
    try {
      const response = await request("sign-out", { method: "POST", body: "{}" });
      if (!response.ok) return { kind: "unknown", status: response.status };
      const result: unknown = await response.json();
      if (
        typeof result !== "object" ||
        result === null ||
        !("success" in result) ||
        result.success !== true
      )
        return { kind: "unknown", status: response.status };
      // Better Auth catches a failed database deletion and still returns success. Confirm it.
      const checked = await request("get-session");
      if (checked.status === 401 || checked.status === 403) {
        return { kind: "ended", status: checked.status };
      }
      if (checked.ok && (await checked.json()) === null) {
        return { kind: "ended", status: checked.status };
      }
      return { kind: "unknown", status: checked.status };
    } catch (error) {
      return { kind: "unreachable", error };
    }
  }

  let ending: Promise<ServerSignOut[]> | null = null;
  async function drainRetired() {
    const attempted = new Set<string>();
    const answers: ServerSignOut[] = [];
    let cookie: string | undefined;
    while ((cookie = retired.find((value) => !attempted.has(value))) !== undefined) {
      attempted.add(cookie);
      const answer = await endAuthSession(cookie);
      answers.push(answer);
      if (answer.kind === "ended") {
        const remaining = retired.filter((value) => value !== cookie);
        saveRetired(remaining);
        retired = remaining;
      }
    }
    return answers;
  }
  // The plugin generates the OAuth state inside requestAuth and only hands it to the browser,
  // through `shell.openExternal`. Reading it off that URL is the one way to know which attempt a
  // code belongs to; in test mode the same hook writes the URL for the script that plays the browser.
  const opened: URL[] = [];
  const openExternal = shell.openExternal.bind(shell);
  shell.openExternal = (url, options) => {
    if (!url.startsWith(apiUrl)) return openExternal(url, options);
    opened.push(new URL(url));
    if (!signInUrlFile) return openExternal(url, options);
    writeFileSync(signInUrlFile, url);
    return Promise.resolve();
  };
  return {
    openBrowser: async () => {
      opened.length = 0;
      await client.requestAuth({ provider: "google" });
      const state = opened.at(-1)?.searchParams.get("state");
      if (!state) throw new Error("The sign-in request carried no state.");
      return { state };
    },
    redeem: async (code): Promise<RedeemResult> => {
      try {
        // With `throw: true` the plugin resolves to the token endpoint's body, not the
        // `{ data, error }` pair its typings declare.
        const user = userOf(
          await client.authenticate({ token: code, fetchOptions: { throw: true } }),
        );
        if (user === null) throw new Error("The sign-in response carried no user.");
        // The plugin caches the identity only from `get-session`, and an offline launch restores
        // from that cache.
        void client.getSession().catch(() => {});
        return { kind: "signedIn", ...user };
      } catch (error) {
        // fetch rejects with a TypeError when the network fails; anything else came from the API.
        return { kind: error instanceof TypeError ? "offline" : "rejected", error };
      }
    },
    // The plugin writes this cache on every `get-session` but never reads it back. Like its own
    // storage adapter, it stores base64 of safeStorage ciphertext.
    cachedUser: () => {
      const stored = store.getItem(`${prefix}.local_cache`);
      if (typeof stored !== "string" || !safeStorage.isEncryptionAvailable()) return null;
      try {
        return userOf(JSON.parse(safeStorage.decryptString(Buffer.from(stored, "base64"))));
      } catch {
        return null;
      }
    },
    checkAuthSession: async (): Promise<AuthSessionCheck> => {
      // Without encryption a restored cookie cannot be read, and the API would answer null to a
      // request that carried none.
      if (!safeStorage.isEncryptionAvailable() && client.getCookie() === "") {
        return { kind: "unknown", status: 0 };
      }
      let result: Awaited<ReturnType<typeof client.getSession>>;
      try {
        result = await client.getSession();
      } catch (error) {
        return { kind: "unreachable", error };
      }
      const { data, error } = result;
      if (error) {
        return error.status === 401 || error.status === 403
          ? { kind: "ended", status: error.status }
          : { kind: "unknown", status: error.status };
      }
      // Better Auth 1.7.7 answers 200 with null for an auth session it no longer has.
      if (data === null) return { kind: "ended", status: 200 };
      // A captive portal's HTML page also arrives as a 200, with a string for data.
      const user = userOf(data);
      return user ? { kind: "active", user } : { kind: "unknown", status: 200 };
    },
    forget,
    retireAuthSession: () => {
      const cookie = client.getCookie();
      if (cookie) {
        const next = [...new Set([...retired, cookie])];
        saveRetired(next);
        retired = next;
      }
      forget();
    },
    endRetiredAuthSessions: () => {
      ending ??= drainRetired().finally(() => {
        ending = null;
      });
      return ending;
    },
  };
}
