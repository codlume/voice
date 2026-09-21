import { expect, it } from "vite-plus/test";
import { createCommands } from "./commands";

it("rejects unauthorized senders and stays responsive during a pending settings write", async () => {
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const commands = createCommands({
    isAuthorized: (sender) => sender === "settings-window",
    storage: {
      set: async (settings) => {
        await waiting;
        return settings;
      },
      restart: async () => ({ appearance: "light" }),
    },
    initialSettings: { appearance: "light" },
    status: () => ({ storage: "ready", helper: "ready", capture: "unavailable" }),
  });
  expect(await commands.execute("other-window", { type: "settings.get" })).toEqual({
    ok: false,
    error: "unauthorized",
  });
  const write = commands.execute("settings-window", { type: "settings.set", appearance: "dark" });
  expect(await commands.execute("settings-window", { type: "status.get" })).toMatchObject({
    ok: true,
    settings: { appearance: "light" },
  });
  release?.();
  expect(await write).toMatchObject({ ok: true, settings: { appearance: "dark" } });
});

it("reports invalid commands and failed storage without replacing the cached preference", async () => {
  const commands = createCommands({
    isAuthorized: () => true,
    storage: {
      set: async () => {
        throw new Error("disk full");
      },
      restart: async () => {
        throw new Error("migration failed");
      },
    },
    initialSettings: { appearance: "dark" },
    status: () => ({ storage: "ready", helper: "ready", capture: "unavailable" }),
  });
  expect(await commands.execute(null, { type: "settings.set", appearance: "rainbow" })).toEqual({
    ok: false,
    error: "invalid-command",
  });
  expect(await commands.execute(null, { type: "settings.set", appearance: "light" })).toEqual({
    ok: false,
    error: "storage-unavailable",
  });
  expect(await commands.execute(null, { type: "storage.retry" })).toEqual({
    ok: false,
    error: "storage-unavailable",
  });
  expect(await commands.execute(null, { type: "settings.get" })).toMatchObject({
    ok: true,
    settings: { appearance: "dark" },
  });
});
