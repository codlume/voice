import { writeFileSync } from "node:fs";

import { electronClient } from "@better-auth/electron/client";
import { createAuthClient, type BetterAuthClientPlugin } from "better-auth/client";
import { shell } from "electron";

import { VOICE_URL_SCHEME, type UpdateChannel } from "../shared/api.ts";
import type { AuthClient, RedeemResult } from "./account.ts";

// With `throw: true` the plugin resolves to the token endpoint's body, not the `{ data, error }`
// pair its typings declare, so the user is read from the body like any other external data.
function signedInUser(body: unknown): { name: string; email: string } {
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
  throw new Error("The sign-in response carried no user.");
}

// The plugin's declared fetch hooks do not satisfy better-auth's own plugin type under
// exactOptionalPropertyTypes (optional request fields typed without `| undefined`). Only that
// property is widened, so the client keeps the plugin's typed actions.
type ElectronPlugin = Omit<ReturnType<typeof electronClient>, "fetchPlugins"> &
  Pick<BetterAuthClientPlugin, "fetchPlugins">;

// The only file that loads Better Auth. It is imported lazily on the first Sign in click.
// The auth session lives in memory for now; #129 swaps in the plugin's encrypted storage.
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
  const memory = new Map<string, unknown>();
  const plugin = electronClient({
    protocol: VOICE_URL_SCHEME,
    // Required by the plugin's types, read only for sign-in without a provider.
    signInURL: apiUrl,
    storagePrefix: `voice.${installedChannel}`,
    storage: {
      getItem: (name) => memory.get(name) ?? null,
      setItem: (name, value) => {
        memory.set(name, value);
      },
    },
    userImageProxy: { enabled: false },
  }) as ElectronPlugin;
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
      try {
        const user = signedInUser(
          await client.authenticate({ token: code, fetchOptions: { throw: true } }),
        );
        return { kind: "signedIn", ...user };
      } catch (error) {
        // fetch rejects with a TypeError when the network fails; anything else came from the API.
        return { kind: error instanceof TypeError ? "offline" : "rejected", error };
      }
    },
  };
}
