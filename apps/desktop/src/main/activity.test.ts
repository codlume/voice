import { describe, expect, test } from "vite-plus/test";

import type { TransformId } from "../shared/transforms.ts";
import { activity } from "./activity.ts";
import { idle, type Session } from "./session.ts";
import { idleRun, type TransformRun } from "./transform-run.ts";

const recording: Session = { phase: "recording", id: "s1", mode: "hold", pressedAt: 0 };
const dictationDone: Session = {
  phase: "done",
  id: "s1",
  outcome: { kind: "inserted", method: "paste" },
};
const reading: TransformRun = { phase: "reading", id: "r1", transformId: "polish" as TransformId };
const inserting: TransformRun = { phase: "inserting", id: "r1" };
const transformDone: TransformRun = { phase: "done", id: "r1", outcome: { kind: "noSelection" } };

describe("activity", () => {
  test("a finished run or session is idle, so its pill may linger while the next one starts", () => {
    expect(activity({ session: idle, transform: idleRun })).toBe("idle");
    expect(activity({ session: dictationDone, transform: idleRun })).toBe("idle");
    expect(activity({ session: idle, transform: transformDone })).toBe("idle");
    expect(activity({ session: dictationDone, transform: transformDone })).toBe("idle");
  });

  test("names whichever is busy", () => {
    expect(activity({ session: recording, transform: idleRun })).toBe("dictation");
    expect(activity({ session: idle, transform: reading })).toBe("transform");
    expect(activity({ session: dictationDone, transform: inserting })).toBe("transform");
  });
});
