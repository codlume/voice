import { readFileSync } from "node:fs";
import * as NodePath from "node:path";

import type { UpdateChannel } from "../shared/api.ts";

export const authStoragePrefix = (channel: UpdateChannel) => `voice.${channel}`;

export function authStorageKeys(channel: UpdateChannel) {
  const prefix = authStoragePrefix(channel);
  return {
    cookie: `${prefix}.cookie`,
    identity: `${prefix}.identity`,
    serverSignOuts: `${prefix}.retired_auth_sessions`,
  };
}

// Conf nests dot paths, so `voice.nightly.cookie` is stored at voice > nightly > cookie.
// The plugin's own sign-out leaves an encrypted "{}" here.
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

export function authStored(userData: string, channel: UpdateChannel): boolean {
  const keys = authStorageKeys(channel);
  return encryptedItemsStored(userData, [keys.cookie, keys.serverSignOuts]);
}
