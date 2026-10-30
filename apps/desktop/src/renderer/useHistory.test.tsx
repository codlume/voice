// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vite-plus/test";

import type { HubApi } from "../shared/api.ts";
import type { HistoryChange, HistoryEntry, HistoryState } from "../shared/history.ts";
import { useHistory } from "./useHistory.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

const entry = (id: string, at: number): HistoryEntry => ({
  id,
  at,
  raw: id,
  text: id,
  status: "inserted",
});
const patch = (upsert: HistoryEntry[], remove: string[] = []): HistoryChange => ({
  kind: "patch",
  upsert,
  remove,
  retention: "month",
  saveFailed: false,
});

function fakeMain() {
  let answer: ((state: HistoryState) => void) | null = null;
  const listeners = new Set<(change: HistoryChange) => void>();
  const api = {
    getSnapshot: () => Promise.reject(new Error("not needed")),
    getHistory: () => new Promise<HistoryState>((resolve) => (answer = resolve)),
    onHistory: (listener: (change: HistoryChange) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as Partial<HubApi> as HubApi;
  (window as { voice?: HubApi }).voice = api;
  return {
    answer: (entries: HistoryEntry[]) =>
      act(async () => answer?.({ entries, retention: "month", saveFailed: false })),
    push: (change: HistoryChange) =>
      act(async () => {
        for (const listener of listeners) listener(change);
      }),
  };
}

function Shown() {
  const history = useHistory();
  return <p>{history ? history.entries.map((item) => item.id).join(",") : "loading"}</p>;
}

async function mount(): Promise<() => string> {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<Shown />));
  return () => container.textContent ?? "";
}

test("shows the list main answers with, then each change folded into it", async () => {
  const main = fakeMain();
  const shown = await mount();
  expect(shown()).toBe("loading");

  await main.push(patch([entry("early", 500)]));
  expect(shown()).toBe("loading");

  await main.answer([entry("b", 2000), entry("a", 1000)]);
  expect(shown()).toBe("b,a");

  await main.push(patch([entry("c", 3000)]));
  expect(shown()).toBe("c,b,a");
  await main.push(patch([], ["b"]));
  expect(shown()).toBe("c,a");
  await main.push({
    kind: "all",
    state: { entries: [entry("z", 9000)], retention: "memory", saveFailed: false },
  });
  expect(shown()).toBe("z");
});

test("a whole list that arrives before the answer stands, and the answer does not replace it", async () => {
  const main = fakeMain();
  const shown = await mount();
  await main.push({
    kind: "all",
    state: { entries: [entry("pushed", 1000)], retention: "month", saveFailed: false },
  });
  expect(shown()).toBe("pushed");
  await main.answer([]);
  expect(shown()).toBe("pushed");
});
