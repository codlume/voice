import { describe, expect, test } from "vite-plus/test";

import type { HistoryEntry } from "../shared/history.ts";
import { createHistory } from "./history.ts";

function harness() {
  const published: (readonly HistoryEntry[])[] = [];
  const history = createHistory({ onChange: (entries) => published.push(entries) });
  return { history, published };
}

const settledTick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("history", () => {
  test("keeps one entry per session, newest first, and cleanup replaces its text in place", () => {
    const { history } = harness();
    history.remember({ id: "a", raw: "first", text: "first", status: "pending" }, 1000);
    history.settle("a", true);
    history.remember({ id: "b", raw: "um second", text: "um second", status: "pending" }, 2000);
    history.remember({ id: "b", raw: "um second", text: "Second.", status: "pending" }, 2500);
    history.settle("b", false);

    expect(history.entries()).toEqual([
      { id: "b", at: 2000, raw: "um second", text: "Second.", status: "notInserted" },
      { id: "a", at: 1000, raw: "first", text: "first", status: "inserted" },
    ]);
  });

  test("settling a session that left no transcript, or one already settled, changes nothing", async () => {
    const { history, published } = harness();
    history.settle("none", true);
    history.remember({ id: "late", raw: "late", text: "late", status: "notInserted" }, 1000);
    await settledTick();
    published.length = 0;
    history.settle("late", true);
    await settledTick();

    expect(history.entries()).toEqual([
      { id: "late", at: 1000, raw: "late", text: "late", status: "notInserted" },
    ]);
    expect(published).toEqual([]);
  });

  test("tells the hub after the caller's turn, once for changes made together", async () => {
    const { history, published } = harness();
    history.remember({ id: "a", raw: "hi", text: "hi", status: "pending" }, 1000);
    history.settle("a", true);
    expect(published).toEqual([]);
    await settledTick();
    expect(published).toEqual([[{ id: "a", at: 1000, raw: "hi", text: "hi", status: "inserted" }]]);
  });

  test("deletes one entry or all of them", async () => {
    const { history, published } = harness();
    history.remember({ id: "a", raw: "a", text: "a", status: "pending" }, 1000);
    history.remember({ id: "b", raw: "b", text: "b", status: "pending" }, 2000);
    history.remove("a");
    expect(history.entries().map((entry) => entry.id)).toEqual(["b"]);
    history.clear();
    expect(history.entries()).toEqual([]);
    await settledTick();
    expect(published.at(-1)).toEqual([]);
  });
});
