import { writeFileSync } from "node:fs";

import { electronClient } from "@better-auth/electron/client";
import { createAuthClient, type BetterAuthClientPlugin } from "better-auth/client";
import { shell } from "electron";

import { VOICE_URL_SCHEME, type UpdateChannel } from "../shared/api.ts";
import type { AuthClient } from "./account.ts";

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
  if (signInUrlFile) {
    // The plugin calls `shell.openExternal` itself, so the file is the only hook a script has.
    const openExternal = shell.openExternal.bind(shell);
    shell.openExternal = (url, options) => {
      if (!url.startsWith(apiUrl)) return openExternal(url, options);
      writeFileSync(signInUrlFile, url);
      return Promise.resolve();
    };
  }
  return {
    openBrowser: () => client.requestAuth({ provider: "google" }),
    redeem: async (code) =>
      signedInUser(await client.authenticate({ token: code, fetchOptions: { throw: true } })),
  };
}
