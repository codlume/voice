import { describe, expect, test, vi } from "vite-plus/test";

import { DEFAULT_SETTINGS, type Settings } from "../shared/api.ts";
import { parseAssignments } from "../shared/style.ts";
import { createSettingsQueue, editAssignments } from "./settings-queue.ts";

const textEdit = {
  kind: "app",
  bundleId: "com.apple.textedit",
  name: "TextEdit",
  category: "personal",
} as const;
const notes = {
  kind: "app",
  bundleId: "com.apple.notes",
  name: "Notes",
  category: "personal",
} as const;
const placeTextEdit = { op: "place", assignment: textEdit };
const placeNotes = { op: "place", assignment: notes };

function withHeldSaves(initial: Settings = DEFAULT_SETTINGS) {
  let settings = initial;
  const saves: { next: Settings; release: (fail?: Error) => void }[] = [];
  const queue = createSettingsQueue({
    current: () => settings,
    save: (next) =>
      new Promise<void>((resolve, reject) => {
        saves.push({ next, release: (fail) => (fail ? reject(fail) : resolve()) });
      }),
    applied: (next) => {
      settings = next;
    },
  });
  return { queue, saves, current: () => settings };
}

describe("editAssignments", () => {
  test("two edits sent before the first save finishes both land", async () => {
    const { queue, saves, current } = withHeldSaves();
    const first = editAssignments(queue, placeTextEdit);
    const second = editAssignments(queue, placeNotes);

    await vi.waitFor(() => expect(saves).toHaveLength(1));
    saves[0]?.release();
    await first;
    await vi.waitFor(() => expect(saves).toHaveLength(2));
    saves[1]?.release();
    await second;

    expect(current().cleanup.assignments).toEqual(parseAssignments([textEdit, notes]));
    expect(saves.map(({ next }) => next.cleanup.assignments)).toEqual([
      parseAssignments([textEdit]),
      parseAssignments([textEdit, notes]),
    ]);
  });

  test("an edit after a failed save builds on what is on disk", async () => {
    const { queue, saves, current } = withHeldSaves();
    const first = editAssignments(queue, placeTextEdit);
    const second = editAssignments(queue, placeNotes);

    await vi.waitFor(() => expect(saves).toHaveLength(1));
    saves[0]?.release(new Error("disk full"));
    await expect(first).rejects.toThrow("disk full");
    await vi.waitFor(() => expect(saves).toHaveLength(2));
    saves[1]?.release();
    await second;

    expect(current().cleanup.assignments).toEqual(parseAssignments([notes]));
  });

  test("an edit that changes nothing saves nothing", async () => {
    const assignments = parseAssignments([textEdit]);
    const initial = { ...DEFAULT_SETTINGS, cleanup: { ...DEFAULT_SETTINGS.cleanup, assignments } };
    const { queue, saves, current } = withHeldSaves(initial);

    await expect(editAssignments(queue, placeTextEdit)).resolves.toBe(initial);
    const slackHome = {
      kind: "app",
      bundleId: "com.tinyspeck.slackmacgap",
      name: "Slack",
      category: "work",
    };
    await expect(editAssignments(queue, { op: "place", assignment: slackHome })).resolves.toBe(
      initial,
    );
    await expect(editAssignments(queue, { op: "unassign", assignment: notes })).resolves.toBe(
      initial,
    );

    expect(saves).toEqual([]);
    expect(current()).toBe(initial);
  });

  test("refuses a malformed edit without queueing a save", async () => {
    const { queue, saves } = withHeldSaves();
    await expect(editAssignments(queue, { op: "replace", assignment: textEdit })).rejects.toThrow(
      "Could not save these app assignments.",
    );
    await queue.settled();
    expect(saves).toEqual([]);
  });
});

describe("settings queue", () => {
  test("settled waits for every queued change, saved or failed", async () => {
    const { queue, saves } = withHeldSaves();
    const failing = queue.run((s) => ({ ...s, showInDock: !s.showInDock }));
    const following = queue.run((s) => ({ ...s, theme: "dark" }));
    let settled = false;
    void queue.settled().then(() => (settled = true));

    await vi.waitFor(() => expect(saves).toHaveLength(1));
    saves[0]?.release(new Error("no"));
    await expect(failing).rejects.toThrow("no");
    expect(settled).toBe(false);
    await vi.waitFor(() => expect(saves).toHaveLength(2));
    saves[1]?.release();
    await following;
    await vi.waitFor(() => expect(settled).toBe(true));
  });
});
