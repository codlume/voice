import { describe, expect, test } from "vite-plus/test";

import { parseTranscriptVersion } from "./api.ts";
import {
  applyHistoryChange,
  copyText,
  parseHistoryRetention,
  type HistoryChange,
  type HistoryEntry,
  type HistoryState,
} from "./history.ts";

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

const at = (id: string, time: number, status: HistoryEntry["status"] = "inserted") => ({
  id,
  at: time,
  raw: id,
  text: id,
  status,
});

describe("history changes in the hub", () => {
  const held: HistoryState = {
    entries: [at("c", 3000), at("b", 2000), at("a", 1000)],
    retention: "month",
    saveFailed: false,
  };

  test("a patch before the first list has nothing to apply to, and a whole list replaces", () => {
    const patch: HistoryChange = {
      kind: "patch",
      upsert: [at("d", 4000)],
      remove: [],
      retention: "month",
      saveFailed: false,
    };
    expect(applyHistoryChange(null, patch)).toBeNull();
    expect(applyHistoryChange(null, { kind: "all", state: held })).toBe(held);
    expect(applyHistoryChange(held, { kind: "all", state: { ...held, entries: [] } })).toEqual({
      ...held,
      entries: [],
    });
  });

  test("a patch puts a new entry in by time, replaces one in place, drops ids, and carries the window", () => {
    const next = applyHistoryChange(held, {
      kind: "patch",
      upsert: [at("b", 2000, "notInserted"), at("d", 4000), at("between", 1500, "pending")],
      remove: ["a"],
      retention: "day",
      saveFailed: true,
    });
    expect(next).toEqual({
      entries: [
        at("d", 4000),
        at("c", 3000),
        at("b", 2000, "notInserted"),
        at("between", 1500, "pending"),
      ],
      retention: "day",
      saveFailed: true,
    });
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
