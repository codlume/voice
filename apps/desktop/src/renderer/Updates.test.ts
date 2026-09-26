import { describe, expect, test } from "vite-plus/test";

import type { PillState, UpdateStatus } from "../shared/api.ts";
import { canRestartForUpdate, updateStatusText } from "./updateStatus.ts";

describe("update controls", () => {
  test("restart is available only when an update is ready and dictation is inactive", () => {
    const ready: UpdateStatus = { kind: "ready", version: "1.5.0" };
    const sessions: PillState[] = [
      { kind: "idle" },
      { kind: "listening" },
      { kind: "processing" },
      { kind: "done", outcome: { kind: "inserted", method: "accessibility" } },
    ];
    expect(sessions.map((session) => canRestartForUpdate(ready, session))).toEqual([
      true,
      false,
      false,
      true,
    ]);
    expect(canRestartForUpdate({ kind: "installing", version: "1.5.0" }, sessions[0]!)).toBe(false);
  });

  test("status text keeps useful failure and disabled reasons visible", () => {
    expect(updateStatusText({ kind: "failed", message: "Connection timed out" })).toBe(
      "Connection timed out",
    );
    expect(updateStatusText({ kind: "disabled", reason: "Only packaged builds update" })).toBe(
      "Only packaged builds update",
    );
    expect(updateStatusText({ kind: "downloading", version: "1.5.0", percent: 48.4 })).toBe(
      "Downloading 1.5.0 · 48%",
    );
  });
});
