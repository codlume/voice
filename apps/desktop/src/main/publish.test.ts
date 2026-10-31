import { describe, expect, test } from "vite-plus/test";

import { Channel, DEFAULT_SETTINGS } from "../shared/api.ts";
import { publish } from "./publish.ts";
import { createStore, type AppState } from "./store.ts";
import { idleRun } from "./transform-run.ts";

const identity = {
  id: "user-1",
  name: "Ada Lovelace",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
};

function fakeWindow() {
  const sent: { channel: string; value: unknown }[] = [];
  return {
    sent,
    isDestroyed: () => false,
    webContents: { send: (channel: string, value: unknown) => sent.push({ channel, value }) },
  };
}

function harness() {
  const store = createStore({
    updates: {
      version: "0.0.1",
      installedChannel: "stable",
      channel: "stable",
      status: { kind: "idle" },
    },
    session: { phase: "idle" },
    transform: idleRun,
    permissions: { microphone: "granted", accessibility: "granted", systemAudio: "notDetermined" },
    loginItem: "off",
    models: {
      asr: { state: "ready" },
      cleanup: { state: "ready" },
      transform: { state: "missing" },
    },
    settings: DEFAULT_SETTINGS,
    microphones: { kind: "loading" },
    microphoneTest: { kind: "off" },
    account: { kind: "signedIn", ...identity },
  });
  const hub = fakeWindow();
  const pill = fakeWindow();
  store.subscribe((state, previous) => publish({ hub, pill }, state, previous));
  const update = (change: Partial<AppState>) => store.update((s) => ({ ...s, ...change }));
  return { hub, pill, update };
}

describe("publish", () => {
  test("the pill gets the session and its one setting, never the account", () => {
    const { hub, pill, update } = harness();
    update({ session: { phase: "recording", id: "s1", mode: "hold", pressedAt: 0 } });
    update({
      session: { phase: "done", id: "s1", outcome: { kind: "inserted", method: "paste" } },
    });

    expect(pill.sent.every(({ channel }) => channel === Channel.pillSnapshot)).toBe(true);
    expect(pill.sent.map(({ value }) => value)).toEqual([
      {
        session: { kind: "listening" },
        alwaysShowPill: DEFAULT_SETTINGS.alwaysShowPill,
      },
      {
        session: { kind: "done", outcome: { kind: "inserted", method: "paste" } },
        alwaysShowPill: DEFAULT_SETTINGS.alwaysShowPill,
      },
    ]);
    const sentToPill = JSON.stringify(pill.sent);
    for (const secret of [identity.email, identity.name]) {
      expect(sentToPill).not.toContain(secret);
    }
    expect(hub.sent.at(-1)?.value).toMatchObject({ account: identity });
  });

  test("the pill hears only changes to what it renders", () => {
    const { hub, pill, update } = harness();
    update({ loginItem: "on" });
    update({ account: { kind: "signedOut" } });
    update({
      models: {
        asr: { state: "ready" },
        cleanup: { state: "downloading", progress: 0.5 },
        transform: { state: "missing" },
      },
    });

    expect(pill.sent).toEqual([]);
    expect(hub.sent).toHaveLength(3);

    update({ settings: { ...DEFAULT_SETTINGS, alwaysShowPill: !DEFAULT_SETTINGS.alwaysShowPill } });
    expect(pill.sent.map(({ value }) => value)).toEqual([
      {
        session: { kind: "idle" },
        alwaysShowPill: !DEFAULT_SETTINGS.alwaysShowPill,
      },
    ]);
  });
});
