import { writeFileSync } from "node:fs";

import { electronClient } from "@better-auth/electron/client";
import { storage } from "@better-auth/electron/storage";
import { createAuthClient, type BetterAuthClientPlugin } from "better-auth/client";
import { safeStorage, shell } from "electron";

import { VOICE_URL_SCHEME, type UpdateChannel } from "../shared/api.ts";
import type { AuthClient, AuthSessionCheck, Identity, RedeemResult } from "./account.ts";
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
  const plugin = electronClient({
    protocol: VOICE_URL_SCHEME,
    // Required by the plugin's types, read only for sign-in without a provider.
    signInURL: apiUrl,
    storagePrefix: prefix,
    storage: store,
    // The plugin would cache every get-session body, a captive portal's HTML included, and never
    // reads it back. Voice keeps its own copy of the last validated identity instead.
    disableCache: true,
    userImageProxy: { enabled: false },
  }) as ElectronPlugin;
  const identityKey = `${prefix}.identity`;
  // Encrypted like the plugin's own items. Without encryption nothing is written, so the
  // identity, like the auth session, lasts only until quit.
  const saveIdentity = (user: Identity) => {
    if (!safeStorage.isEncryptionAvailable()) return;
    store.setItem(identityKey, safeStorage.encryptString(JSON.stringify(user)).toString("base64"));
  };
  // The get-session in flight, aborted before a sign-in redeems a code, so that a stale answer
  // cannot overwrite the new auth session's cookie or identity.
  let check: AbortController | null = null;
  const client = createAuthClient({ baseURL: apiUrl, plugins: [plugin] });
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
      check?.abort();
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
      const stored = store.getItem(identityKey);
      if (typeof stored !== "string" || !safeStorage.isEncryptionAvailable()) return null;
      try {
        return userOf({
          user: JSON.parse(safeStorage.decryptString(Buffer.from(stored, "base64"))),
        });
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
      const controller = new AbortController();
      check = controller;
      let result: Awaited<ReturnType<typeof client.getSession>>;
      try {
        result = await client.getSession({ fetchOptions: { signal: controller.signal } });
      } catch (error) {
        return { kind: "unreachable", error };
      } finally {
        if (check === controller) check = null;
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
      if (!controller.signal.aborted) saveIdentity(user);
      return { kind: "active", user };
    },
    forget: () => {
      store.setItem(`${prefix}.cookie`, null);
      store.setItem(identityKey, null);
    },
  };
}
