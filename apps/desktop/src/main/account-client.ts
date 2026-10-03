import { writeFileSync } from "node:fs";

import { electronClient } from "@better-auth/electron/client";
import { storage } from "@better-auth/electron/storage";
import { createAuthClient, type BetterAuthClientPlugin } from "better-auth/client";
import { cookieNameRegex, getSessionCookie } from "better-auth/cookies";
import { safeStorage, shell } from "electron";

import { VOICE_URL_SCHEME, type UpdateChannel } from "../shared/api.ts";
import type {
  AuthClient,
  AuthSessionCheck,
  Identity,
  RedeemResult,
  ServerSignOut,
} from "./account.ts";
import type { Log } from "./diagnostics-scrub.ts";
import { authStorageKeys, authStoragePrefix } from "./account-storage.ts";

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

// The plugin filters expired entries from request headers, but crash recovery needs their identity.
function storedSessionToken(stored: unknown): string | null {
  if (typeof stored !== "string" || !safeStorage.isEncryptionAvailable()) return null;
  try {
    const parsed: unknown = JSON.parse(safeStorage.decryptString(Buffer.from(stored, "base64")));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const entries: [string, unknown][] = Object.entries(parsed);
    const pairs: string[] = [];
    for (const [name, cookie] of entries) {
      if (
        cookieNameRegex.test(name) &&
        typeof cookie === "object" &&
        cookie !== null &&
        "value" in cookie &&
        typeof cookie.value === "string"
      ) {
        pairs.push(`${name}=${encodeURIComponent(cookie.value)}`);
      }
    }
    return getSessionCookie(new Headers({ cookie: pairs.join("; ") }));
  } catch {
    return null;
  }
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
  log,
  signInUrlFile,
}: {
  apiUrl: string;
  installedChannel: UpdateChannel;
  log: Log;
  /** Test mode: the plugin's `shell.openExternal` writes the sign-in URL here instead. */
  signInUrlFile?: string;
}): AuthClient {
  const keys = authStorageKeys(installedChannel);
  const store = storage();
  let generation = 0;
  function makeClient() {
    const current = generation;
    const plugin = electronClient({
      protocol: VOICE_URL_SCHEME,
      // Required by the plugin's types, read only for sign-in without a provider.
      signInURL: apiUrl,
      storagePrefix: authStoragePrefix(installedChannel),
      storage: {
        getItem: store.getItem,
        // A request started before local sign-out must not restore its cookie or identity.
        setItem: (key, value) => {
          if (current === generation) store.setItem(key, value);
        },
      },
      disableCache: true,
      userImageProxy: { enabled: false },
    }) as ElectronPlugin;
    return createAuthClient({ baseURL: apiUrl, plugins: [plugin] });
  }
  let client = makeClient();
  // Encrypted like the plugin's own items. Without encryption nothing is written, so the
  // identity, like the auth session, lasts only until quit.
  const saveIdentity = (user: Identity) => {
    if (!safeStorage.isEncryptionAvailable()) return;
    store.setItem(
      keys.identity,
      safeStorage.encryptString(JSON.stringify(user)).toString("base64"),
    );
  };

  const signOutsKey = keys.serverSignOuts;
  let serverSignOuts: string[] = [];
  const storedSignOuts = store.getItem(signOutsKey);
  if (typeof storedSignOuts === "string" && safeStorage.isEncryptionAvailable()) {
    try {
      const parsed: unknown = JSON.parse(
        safeStorage.decryptString(Buffer.from(storedSignOuts, "base64")),
      );
      if (!Array.isArray(parsed) || !parsed.every((cookie) => typeof cookie === "string")) {
        throw new Error("Invalid stored sign-outs.");
      }
      serverSignOuts = parsed;
    } catch {
      store.setItem(signOutsKey, null);
      log("account server sign-out queue discarded", {
        message: "account server sign-out queue discarded",
        level: "warn",
      });
    }
  }

  function saveServerSignOuts(next: string[]) {
    if (!safeStorage.isEncryptionAvailable()) return;
    store.setItem(
      signOutsKey,
      next.length ? safeStorage.encryptString(JSON.stringify(next)).toString("base64") : null,
    );
  }

  function queueServerSignOut(cookie: string) {
    if (!cookie || serverSignOuts.includes(cookie)) return;
    const next = [...serverSignOuts, cookie];
    saveServerSignOuts(next);
    serverSignOuts = next;
  }

  function forget() {
    generation += 1;
    store.setItem(keys.cookie, null);
    store.setItem(keys.identity, null);
    // The plugin also has private memory storage when encryption is unavailable.
    client = makeClient();
  }

  // A crash after enqueue but before forget finishes can leave its cookie or only its identity behind.
  // A different stored credential belongs to a newer sign-in and must survive, even if expired.
  if (serverSignOuts.length) {
    const stored = store.getItem(keys.cookie);
    const token = storedSessionToken(stored);
    if (
      stored === null ||
      stored === "" ||
      (token !== null &&
        serverSignOuts.some((cookie) => getSessionCookie(new Headers({ cookie })) === token))
    ) {
      forget();
    }
  }

  // The plugin overwrites a supplied Cookie header and clears active storage on /sign-out.
  // Raw fetch keeps revocation of an old cookie separate from the current signed-in session.
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
  async function drainServerSignOuts() {
    const attempted = new Set<string>();
    const answers: ServerSignOut[] = [];
    let cookie: string | undefined;
    // Pick up cookies queued during an await, but attempt each at most once in this drain.
    while ((cookie = serverSignOuts.find((value) => !attempted.has(value))) !== undefined) {
      attempted.add(cookie);
      const answer = await endAuthSession(cookie);
      answers.push(answer);
      if (answer.kind === "ended") {
        const remaining = serverSignOuts.filter((value) => value !== cookie);
        saveServerSignOuts(remaining);
        serverSignOuts = remaining;
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
        saveIdentity(user);
        return { kind: "signedIn", ...user };
      } catch (error) {
        // fetch rejects with a TypeError when the network fails; anything else came from the API.
        return { kind: error instanceof TypeError ? "offline" : "rejected", error };
      }
    },
    cachedUser: () => {
      const stored = store.getItem(keys.identity);
      if (typeof stored !== "string" || !safeStorage.isEncryptionAvailable()) return null;
      try {
        return userOf({
          user: JSON.parse(safeStorage.decryptString(Buffer.from(stored, "base64"))),
        });
      } catch {
        return null;
      }
    },
    checkAuthSession: async (signal): Promise<AuthSessionCheck> => {
      const checkedGeneration = generation;
      // Without encryption a restored cookie cannot be read, and the API would answer null to a
      // request that carried none.
      if (!safeStorage.isEncryptionAvailable() && client.getCookie() === "") {
        return { kind: "unknown", status: 0 };
      }
      let result: Awaited<ReturnType<typeof client.getSession>>;
      try {
        // Aborting rejects the request if it lands before the response body is read, and the
        // plugin's hooks, which write the cookie, never run. A body already read still reaches them.
        result = await client.getSession({ fetchOptions: { signal } });
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
      if (user === null) return { kind: "unknown", status: 200 };
      if (!signal.aborted && checkedGeneration === generation) saveIdentity(user);
      return { kind: "active", user };
    },
    forget,
    queueServerSignOut,
    hasAuthSession: () => {
      const stored = store.getItem(keys.cookie);
      return (typeof stored === "string" && stored !== "") || client.getCookie() !== "";
    },
    retireAuthSession: () => {
      queueServerSignOut(client.getCookie());
      forget();
    },
    endServerSignOuts: () => {
      ending ??= drainServerSignOuts().finally(() => {
        ending = null;
      });
      return ending;
    },
  };
}
