import { describe, expect, it } from "vite-plus/test";
import { decodeCommand } from "./desktop";
import { decodeBarPointerEvent, decodeShortcutEvent, decodeTargetSelected } from "./session";
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
      decodeTargetSelected({ type: "target.selected", session: "s", status: "eligible" }),
    ).toMatchObject({ session: "s", status: "eligible" });
    expect(
      decodeNativeSetupCommand({
        type: "shortcut.configure",
        shortcuts: { hold: "Fn", toggle: "Fn+Space", cancel: "Escape" },
        active: true,
        bar: { x: 10, y: 900, width: 480, height: 84, window: 42 },
      }).type,
    ).toBe("shortcut.configure");
    for (const bar of [
      undefined,
      { x: 0, y: 0, width: 0, height: 10, window: 42 },
      { x: 0, y: 0, width: 480, height: 84 },
    ])
      expect(() =>
        decodeNativeSetupCommand({
          type: "shortcut.configure",
          shortcuts: { hold: "Fn", toggle: "Fn+Space", cancel: "Escape" },
          active: true,
          bar,
        }),
      ).toThrow();
    expect(decodeBarPointerEvent({ type: "bar.pointer", phase: "down", x: 12, y: 30 })).toEqual({
      type: "bar.pointer",
      phase: "down",
      x: 12,
      y: 30,
    });
    expect(() =>
      decodeBarPointerEvent({ type: "bar.pointer", phase: "down", x: 12, y: 30, screen: 1 }),
    ).toThrow();
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
