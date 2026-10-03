import { readFileSync } from "node:fs";
import * as NodePath from "node:path";

import type { UpdateChannel } from "../shared/api.ts";

// Stable and Nightly share one data folder, so each channel keeps its auth session apart.
export const authStoragePrefix = (channel: UpdateChannel) => `voice.${channel}`;

/** The plugin cookie, Voice identity, and pending server sign-outs stay separate per channel. */
export function authStorageKeys(channel: UpdateChannel) {
  const prefix = authStoragePrefix(channel);
  return {
    cookie: `${prefix}.cookie`,
    identity: `${prefix}.identity`,
    serverSignOuts: `${prefix}.retired_auth_sessions`,
  };
}

// The plugin's storage is a Conf store in userData/config.json, and Conf nests dot paths, so
// `voice.nightly.cookie` is stored at voice > nightly > cookie. Reading the file directly keeps a
// launch with no stored auth session free of Conf, Better Auth and the Keychain.
// The plugin's own sign-out leaves an encrypted "{}" here, which counts as stored, so a sign-out
// must clear the channel through the client's `forget`.
function encryptedItemsStored(userData: string, storageKeys: readonly string[]): boolean {
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(NodePath.join(userData, "config.json"), "utf8"));
  } catch {
    return false;
  }
  return storageKeys.some((storageKey) => {
    const item = storageKey
      .split(".")
      .reduce<unknown>(
        (node, key) => (typeof node === "object" && node !== null ? Reflect.get(node, key) : null),
        config,
      );
    return typeof item === "string" && item !== "";
  });
}

export const authSessionStored = (userData: string, channel: UpdateChannel) =>
  encryptedItemsStored(userData, [authStorageKeys(channel).cookie]);

export const serverSignOutsStored = (userData: string, channel: UpdateChannel) =>
  encryptedItemsStored(userData, [authStorageKeys(channel).serverSignOuts]);

/** A single pre-load probe for either active auth or pending server sign-outs. */
export function authStored(userData: string, channel: UpdateChannel): boolean {
  const keys = authStorageKeys(channel);
  return encryptedItemsStored(userData, [keys.cookie, keys.serverSignOuts]);
}
