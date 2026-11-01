// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { PillApi, PillState } from "../shared/api.ts";
import { PillCapsule } from "./PillCapsule.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  (window as { voice?: PillApi }).voice = {
    getPillSnapshot: vi.fn(),
    onLevel: () => () => {},
  } as Partial<PillApi> as PillApi;
  host = document.createElement("div");
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
});

const spoken = (session: PillState) => {
  act(() => root.render(<PillCapsule session={session} alwaysShowPill meeting={null} />));
  return host.querySelector("[role=status]")?.textContent;
};

describe("Flow Bar status for a screen reader", () => {
  test("says Listening only while capture is active", () => {
    expect(spoken({ kind: "idle" })).toBe("");
    expect(spoken({ kind: "listening" })).toBe("Listening");
    expect(spoken({ kind: "processing", overdue: false })).toBe("");
  });
});
