import { describe, expect, test } from "vite-plus/test";

import { parseTranscriptVersion } from "./api.ts";
import { copyText, parseHistoryRetention, type HistoryEntry } from "./history.ts";

const entry = (text: string, raw: string): HistoryEntry => ({
  id: "s1",
  at: 0,
  raw,
  text,
  status: "inserted",
});

describe("copy text", () => {
  test("copies the cleaned text, and the raw transcript when cleanup left nothing", () => {
    expect(copyText(entry("Ship it.", "um ship it"))).toBe("Ship it.");
    expect(copyText(entry("", "um ship it"))).toBe("um ship it");
  });
});

describe("history arguments from the hub", () => {
  test("accept a known window and nothing else", () => {
    for (const retention of ["memory", "day", "month", "forever"] as const) {
      expect(parseHistoryRetention(retention)).toBe(retention);
    }
    for (const value of [undefined, null, "week", "MEMORY", 30, {}, ["day"]]) {
      expect(parseHistoryRetention(value)).toBeNull();
    }
  });

  test("accept a known transcript version and nothing else", () => {
    expect(parseTranscriptVersion("text")).toBe("text");
    expect(parseTranscriptVersion("raw")).toBe("raw");
    for (const value of [undefined, null, "RAW", "cleaned", 1, {}]) {
      expect(parseTranscriptVersion(value)).toBeNull();
    }
  });
});
