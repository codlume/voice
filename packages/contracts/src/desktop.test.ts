import { describe, expect, it } from "vite-plus/test";
import { decodeCommand } from "./desktop";

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
