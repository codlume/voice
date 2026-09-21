import { expect, it } from "vite-plus/test";
import { createSetup } from "./setup";
import { defaultSetupPreferences, type NativeSetupStatus } from "@voice/contracts/setup";

it("blocks missing credentials, separates offline advice, and emits secret-free credential changes", async () => {
  const native: NativeSetupStatus = {
    permissions: { microphone: "granted", accessibility: "granted", inputMonitoring: "granted" },
    devices: [{ id: "synthetic-input", name: "Synthetic microphone" }],
    defaultDevice: "synthetic-input",
    shortcuts: { hold: "available", toggle: "available", cancel: "available" },
  };
  let present = false;
  const events: unknown[] = [];
  const setup = createSetup({
    native: async (command) => {
      if (command.type === "credential.set") present = true;
      if (command.type === "credential.remove") present = false;
      return command.type.startsWith("credential.")
        ? { type: "credential", presence: present ? "saved" : "missing" }
        : { type: "setup", status: native };
    },
    preferences: () => defaultSetupPreferences,
    save: async () => {},
    connectivity: () => "offline",
    credentialChanged: (event) => events.push(event),
  });
  await setup.refresh();
  expect(setup.snapshot()).toMatchObject({
    localCapture: "available",
    blockers: ["key-missing"],
    connectivity: "offline",
  });
  await setup.execute({ type: "credential.set", key: "synthetic-test-value" });
  expect(setup.snapshot()).toMatchObject({
    credential: { presence: "saved", verification: "unverified" },
    blockers: [],
    provider: "unknown",
  });
  expect(events).toEqual([{ type: "credential.changed", revision: 1, presence: "saved" }]);
  await setup.execute({ type: "credential.remove" });
  expect(setup.snapshot().blockers).toEqual(["key-missing"]);
  expect(events).toHaveLength(2);
});

it("distinguishes revoked permissions and a missing selected device from credential and provider failures", async () => {
  let preferences = {
    ...defaultSetupPreferences,
    inputDevice: "disconnected",
    grantedPermissions: ["microphone"] as const,
  };
  const setup = createSetup({
    native: async (command) =>
      command.type === "credential.status"
        ? { type: "credential", presence: "saved" }
        : {
            type: "setup",
            status: {
              permissions: {
                microphone: "denied",
                accessibility: "denied",
                inputMonitoring: "unavailable",
              },
              devices: [{ id: "other", name: "Other input" }],
              defaultDevice: "other",
              shortcuts: { hold: "unavailable", toggle: "conflict", cancel: "available" },
            },
          },
    preferences: () => preferences,
    save: async () => {},
    connectivity: () => "online",
    credentialChanged: () => {},
  });
  await setup.refresh();
  expect(setup.snapshot()).toMatchObject({
    native: {
      permissions: {
        microphone: "revoked",
        accessibility: "not-requested",
        inputMonitoring: "unavailable",
      },
    },
    localCapture: "unavailable",
  });
  expect(setup.snapshot().blockers).toContain("input-device");
  expect(preferences.inputDevice).toBe("disconnected");
  setup.updateAccess("unverified", "rate-limited");
  expect(setup.snapshot().blockers).not.toContain("quota-exhausted");
  expect(setup.snapshot().blockers).not.toContain("key-rejected");
  setup.updateAccess("rejected", "quota-exhausted");
  expect(setup.snapshot().blockers).toEqual(
    expect.arrayContaining(["key-rejected", "quota-exhausted"]),
  );
});

it("rejects malformed secrets and conflicting shortcuts, and reports Keychain failure without change events", async () => {
  const events: unknown[] = [];
  const setup = createSetup({
    native: async () => ({ type: "error", error: "keychain-unavailable" }),
    preferences: () => defaultSetupPreferences,
    save: async () => {},
    connectivity: () => "unknown",
    credentialChanged: (event) => events.push(event),
  });
  await expect(setup.execute({ type: "credential.set", key: "secret\nextra" })).rejects.toThrow();
  await expect(
    setup.execute({
      type: "setup.save",
      inputDevice: null,
      completed: false,
      shortcuts: { hold: "Fn", toggle: "Fn", cancel: "Escape" },
    }),
  ).rejects.toThrow("shortcut-conflict");
  await expect(
    setup.execute({ type: "credential.set", key: "synthetic-test-value" }),
  ).rejects.toThrow("keychain-unavailable");
  expect(events).toEqual([]);
  expect(setup.snapshot().credential.presence).toBe("unavailable");
});

it("marks a previously saved key unavailable when Keychain refuses a later operation", async () => {
  let failing = false;
  const changes: unknown[] = [];
  const setup = createSetup({
    native: async () =>
      failing
        ? { type: "error", error: "keychain-unavailable" }
        : { type: "credential", presence: "saved" },
    preferences: () => defaultSetupPreferences,
    save: async () => {},
    connectivity: () => "online",
    credentialChanged: (event) => changes.push(event),
  });
  await setup.execute({ type: "credential.set", key: "synthetic-test-value" });
  failing = true;
  await expect(setup.execute({ type: "credential.remove" })).rejects.toThrow(
    "keychain-unavailable",
  );
  expect(setup.snapshot().credential.presence).toBe("unavailable");
  expect(changes).toHaveLength(1);
});
