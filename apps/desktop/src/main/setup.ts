import {
  decodeSetupCommand,
  decodeNativeSetupResult,
  decodeCredentialChanged,
  permissionNames,
  type SetupPreferences,
  type SetupBlocker,
  type SetupStatus,
  type NativeSetupCommand,
  type CredentialChanged,
} from "@voice/contracts/setup";

export function createSetup(options: {
  native: (command: NativeSetupCommand) => Promise<unknown>;
  preferences: () => SetupPreferences;
  save: (preferences: SetupPreferences) => Promise<void>;
  connectivity: () => SetupStatus["connectivity"];
  credentialChanged: (event: CredentialChanged) => void;
}) {
  let state: SetupStatus = {
    native: null,
    credential: { presence: "unavailable", verification: "unverified" },
    connectivity: "unknown",
    provider: "unknown",
    localCapture: "unavailable",
    blockers: [],
  };
  let revision = 0;
  // Serialize setup mutations, including native credential writes. Status reads never wait.
  let pending = Promise.resolve();
  const native = async (command: NativeSetupCommand) => {
    const result = decodeNativeSetupResult(await options.native(command));
    if (result.type === "error") {
      if (result.error === "keychain-unavailable")
        state = { ...state, credential: { presence: "unavailable", verification: "unverified" } };
      throw new Error(result.error);
    }
    return result;
  };
  function snapshot(): SetupStatus {
    const current = state.native;
    const preferences = options.preferences();
    const blockers: SetupBlocker[] = [];
    if (!current) blockers.push("native-unavailable");
    else {
      for (const name of permissionNames) {
        if (current.permissions[name] !== "granted") blockers.push(`permission-${name}`);
      }
      if (
        !current.devices.some(
          (device) => device.id === (preferences.inputDevice ?? current.defaultDevice),
        )
      )
        blockers.push("input-device");
      if (Object.values(current.shortcuts).some((value) => value !== "available"))
        blockers.push("shortcuts");
    }
    const localCapture = blockers.length === 0 ? "available" : "unavailable";
    if (state.credential.presence !== "saved") blockers.push(`key-${state.credential.presence}`);
    else if (state.credential.verification === "rejected") blockers.push("key-rejected");
    if (state.provider === "quota-exhausted") blockers.push("quota-exhausted");
    return { ...state, localCapture, blockers, connectivity: options.connectivity() };
  }
  async function refresh() {
    try {
      const result = await native({
        type: "setup.status",
        shortcuts: options.preferences().shortcuts,
      });
      if (result.type !== "setup") throw new Error("native-unavailable");
      const preferences = options.preferences();
      const permissions = { ...result.status.permissions };
      for (const name of permissionNames) {
        if (permissions[name] === "denied") {
          if (preferences.grantedPermissions.includes(name)) permissions[name] = "revoked";
          else if (name !== "microphone" && !preferences.requestedPermissions.includes(name))
            permissions[name] = "not-requested";
        }
      }
      state = { ...state, native: { ...result.status, permissions } };
      const grantedPermissions = [
        ...new Set([
          ...preferences.grantedPermissions,
          ...permissionNames.filter((name) => permissions[name] === "granted"),
        ]),
      ];
      if (grantedPermissions.length !== preferences.grantedPermissions.length)
        await options.save({ ...preferences, grantedPermissions });
      const credential = await native({ type: "credential.status" });
      if (credential.type !== "credential") throw new Error("keychain-unavailable");
      state = { ...state, credential: { ...state.credential, presence: credential.presence } };
    } catch (error) {
      if (error instanceof Error && error.message === "keychain-unavailable")
        state = { ...state, credential: { presence: "unavailable", verification: "unverified" } };
      else state = { ...state, native: null };
      throw error;
    }
  }
  async function execute(input: unknown) {
    const command = decodeSetupCommand(input);
    const operation = pending.then(async () => {
      if (command.type === "credential.set" || command.type === "credential.remove") {
        const result = await native(command);
        if (result.type !== "credential" || result.presence === "unavailable")
          throw new Error("keychain-unavailable");
        state = {
          ...state,
          credential: { presence: result.presence, verification: "unverified" },
          provider: "unknown",
        };
        options.credentialChanged(
          decodeCredentialChanged({
            type: "credential.changed",
            revision: ++revision,
            presence: result.presence,
          }),
        );
      } else if (command.type === "permission.request") {
        const preferences = options.preferences();
        await options.save({
          ...preferences,
          requestedPermissions: [
            ...new Set([...preferences.requestedPermissions, command.permission]),
          ],
        });
        await native(command);
        await refresh();
      } else if (command.type === "setup.save") {
        const bindings = Object.values(command.shortcuts);
        if (new Set(bindings).size !== bindings.length) throw new Error("shortcut-conflict");
        const result = await native({ type: "setup.status", shortcuts: command.shortcuts });
        if (result.type !== "setup") throw new Error("native-unavailable");
        if (Object.values(result.status.shortcuts).includes("conflict"))
          throw new Error("shortcut-conflict");
        await options.save({
          ...options.preferences(),
          inputDevice: command.inputDevice,
          shortcuts: command.shortcuts,
          completed: command.completed,
        });
        state = { ...state, native: result.status };
        await refresh();
      } else await refresh();
    });
    pending = operation.catch(() => {});
    return operation;
  }
  return {
    snapshot,
    execute,
    refresh: () => execute({ type: "setup.refresh" }),
    unavailable() {
      state = {
        ...state,
        native: null,
        credential: { presence: "unavailable", verification: "unverified" },
      };
    },
    // The future ASR adapter reports evidence, never infers authentication from key storage.
    updateAccess(
      credential: SetupStatus["credential"]["verification"],
      provider: SetupStatus["provider"],
    ) {
      state = { ...state, credential: { ...state.credential, verification: credential }, provider };
    },
  };
}
