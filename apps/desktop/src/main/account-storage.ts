import { readFileSync } from "node:fs";
import * as NodePath from "node:path";

import type { UpdateChannel } from "../shared/api.ts";

// Stable and Nightly share one data folder, so each channel keeps its auth session apart.
export const authStoragePrefix = (channel: UpdateChannel) => `voice.${channel}`;

// The plugin's storage is a Conf store in userData/config.json, and Conf nests dot paths, so
// `voice.nightly.cookie` is stored at voice > nightly > cookie. Reading the file directly keeps a
// launch with no stored auth session free of Conf, Better Auth and the Keychain.
// The plugin's own sign-out leaves an encrypted "{}" here, which counts as stored, so a sign-out
// must clear the channel through the client's `forget`.
function encryptedItemStored(
  userData: string,
  channel: UpdateChannel,
  storageKey: string,
): boolean {
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(NodePath.join(userData, "config.json"), "utf8"));
  } catch {
    return false;
  }
  const cookie = `${authStoragePrefix(channel)}.${storageKey}`
    .split(".")
    .reduce<unknown>(
      (node, key) => (typeof node === "object" && node !== null ? Reflect.get(node, key) : null),
      config,
    );
  return typeof cookie === "string" && cookie !== "";
}

export const authSessionStored = (userData: string, channel: UpdateChannel) =>
  encryptedItemStored(userData, channel, "cookie");

export const retiredAuthSessionStored = (userData: string, channel: UpdateChannel) =>
  encryptedItemStored(userData, channel, "retired_auth_sessions");
