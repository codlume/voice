// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import { useAction } from "./useAction.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let root: Root;
let action: ReturnType<typeof useAction>;

function Probe({ expose }: { expose: (current: ReturnType<typeof useAction>) => void }) {
  const current = useAction();
  useEffect(() => expose(current));
  return null;
}

beforeEach(() => {
  root = createRoot(document.createElement("div"));
  act(() =>
    root.render(
      <Probe
        expose={(current) => {
          action = current;
        }}
      />,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
});

describe("useAction", () => {
  test("is pending while the action runs and reports success", async () => {
    const work = deferred();
    let outcome!: Promise<boolean>;
    act(() => {
      outcome = action.run(() => work.promise, "Could not save.");
    });
    expect(action.pending).toBe(true);
    await act(async () => work.resolve());
    expect(await outcome).toBe(true);
    expect(action.pending).toBe(false);
    expect(action.error).toBe("");
  });

  test("shows the main-process message, or the fallback for a non-Error", async () => {
    await act(async () => {
      await action.run(async () => {
        throw new Error("Error invoking remote method 'voice:save': Error: Disk is full.");
      }, "Could not save.");
    });
    expect(action.error).toBe("Disk is full.");
    await act(async () => {
      await action.run(() => Promise.reject("nope"), "Could not save.");
    });
    expect(action.error).toBe("Could not save.");
  });

  test("a new attempt clears the last error", async () => {
    await act(async () => {
      await action.run(() => Promise.reject(new Error("first")), "x");
    });
    const work = deferred();
    act(() => void action.run(() => work.promise, "x"));
    expect(action.error).toBe("");
    await act(async () => work.resolve());
  });

  test("a slow earlier attempt cannot overwrite the newest outcome", async () => {
    const slow = deferred();
    const fast = deferred();
    act(() => void action.run(() => slow.promise, "slow failed"));
    act(() => void action.run(() => fast.promise, "fast failed"));
    await act(async () => fast.resolve());
    expect(action.pending).toBe(false);
    await act(async () => slow.reject("late"));
    expect(action.error).toBe("");
    expect(action.pending).toBe(false);
  });

  test("an earlier attempt finishing does not end the newest one's pending", async () => {
    const slow = deferred();
    const fast = deferred();
    act(() => void action.run(() => slow.promise, "x"));
    act(() => void action.run(() => fast.promise, "x"));
    await act(async () => slow.resolve());
    expect(action.pending).toBe(true);
    await act(async () => fast.resolve());
    expect(action.pending).toBe(false);
  });
});
