import { describe, expect, it } from "vite-plus/test";
import { decodeCommand } from "./desktop";
import { decodeShortcutEvent, decodeTargetSelected } from "./session";
import { decodeNativeSetupCommand, decodeNativeSetupResult } from "./setup";

describe("settings commands", () => {
  it("accepts an appearance preference and rejects malformed or extra fields", () => {
    expect(decodeCommand({ type: "settings.set", appearance: "dark" })).toEqual({
      type: "settings.set",
      appearance: "dark",
    });
    for (const payload of [
      { type: "settings.set", appearance: "rainbow" },
      { type: "settings.set" },
      { type: "settings.get", path: "/private" },
    ]) {
      expect(() => decodeCommand(payload)).toThrow();
    }
  });
});

describe("dictation contracts", () => {
  it("accepts explicit paste and native shortcut or target messages, rejecting unknown shapes", () => {
    expect(decodeCommand({ type: "recovery.paste", id: "entry" })).toEqual({
      type: "recovery.paste",
      id: "entry",
    });
    expect(decodeShortcutEvent({ type: "shortcut", action: "hold.down" }).action).toBe("hold.down");
    expect(
      decodeTargetSelected({
        type: "target.selected",
        session: "s",
        status: "eligible",
        app: null,
      }),
    ).toMatchObject({ session: "s", status: "eligible" });
    expect(
      decodeNativeSetupCommand({
        type: "shortcut.configure",
        shortcuts: { hold: "Fn", toggle: "Fn+Space", cancel: "Escape" },
        active: true,
      }).type,
    ).toBe("shortcut.configure");
    expect(
      decodeNativeSetupResult({ type: "insertion", session: "s", outcome: "uncertain" }),
    ).toMatchObject({ outcome: "uncertain" });
    for (const payload of [
      { type: "recovery.paste" },
      { type: "recovery.paste", id: "entry", target: "anywhere" },
    ])
      expect(() => decodeCommand(payload)).toThrow();
    expect(() => decodeShortcutEvent({ type: "shortcut", action: "start" })).toThrow();
    expect(() =>
      decodeNativeSetupCommand({ type: "target.insert", session: "s", text: "" }),
    ).toThrow();
    expect(() =>
      decodeNativeSetupResult({ type: "insertion", session: "s", outcome: "maybe" }),
    ).toThrow();
  });
});
