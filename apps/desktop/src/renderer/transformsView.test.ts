import { describe, expect, test } from "vite-plus/test";

import {
  BUILT_IN_TRANSFORMS,
  POLISH_ID,
  type Transform,
  type TransformId,
} from "../shared/transforms.ts";
import {
  askToDelete,
  asksBeforeTurningOn,
  autoApplyChoice,
  autoApplyOptions,
  cancelDelete,
  confirmDelete,
  firstLine,
  modelLine,
  NO_AUTO_APPLY,
  openEditor,
  restoreDescription,
  TRANSFORM_MODEL_SIZE,
} from "./transformsView.ts";

const bullets: Transform = {
  id: "synthetic-bullets" as TransformId,
  name: "Bullets",
  instruction: "Turn this into a bulleted list.",
  shortcut: { keycode: 18, modifiers: ["option"] },
};

describe("After dictation", () => {
  test("offers None first, then every transform in list order", () => {
    expect(autoApplyOptions([...BUILT_IN_TRANSFORMS, bullets])).toEqual([
      { value: NO_AUTO_APPLY, label: "None" },
      { value: "polish", label: "Polish" },
      { value: "prompt-engineer", label: "Prompt Engineer" },
      { value: "synthetic-bullets", label: "Bullets" },
    ]);
  });

  test("None and an unknown value choose no transform", () => {
    expect(autoApplyChoice(BUILT_IN_TRANSFORMS, NO_AUTO_APPLY)).toBeNull();
    expect(autoApplyChoice(BUILT_IN_TRANSFORMS, "deleted")).toBeNull();
    expect(autoApplyChoice(BUILT_IN_TRANSFORMS, "polish")).toBe(POLISH_ID);
  });
});

describe("the switch", () => {
  test("asks before downloading only when turning on without the model", () => {
    expect(asksBeforeTurningOn(true, { state: "missing" })).toBe(true);
    expect(asksBeforeTurningOn(false, { state: "missing" })).toBe(false);
    for (const state of ["installed", "ready", "loading"] as const) {
      expect(asksBeforeTurningOn(true, { state })).toBe(false);
    }
    expect(asksBeforeTurningOn(true, { state: "downloading", progress: 0.2 })).toBe(false);
  });

  test("the download size comes from the models table", () => {
    expect(TRANSFORM_MODEL_SIZE).toBe("3.1 GB");
  });

  test("links to Models while the model is not usable", () => {
    expect(modelLine(true, { state: "downloading", progress: 0.42 })).toEqual({
      text: "Downloading the transform model, 42%.",
      linksToModels: true,
    });
    expect(modelLine(true, { state: "missing" }).linksToModels).toBe(true);
    expect(modelLine(true, { state: "failed", message: "x" }).linksToModels).toBe(true);
    expect(modelLine(true, { state: "installed" }).linksToModels).toBe(false);
    expect(modelLine(false, { state: "downloading" }).linksToModels).toBe(false);
  });
});

describe("cards", () => {
  test("show the instruction's first line", () => {
    expect(firstLine("  Make it short.\nThen add a title.")).toBe("Make it short.");
    expect(firstLine("")).toBe("");
  });
});

describe("Restore defaults", () => {
  test("says custom transforms stay", () => {
    expect(restoreDescription(BUILT_IN_TRANSFORMS, null)).toBe(
      "Polish and Prompt Engineer get their original name, instruction and shortcut back. Transforms you created stay as they are.",
    );
  });

  test("names a shortcut a built-in cannot take back, and who holds it", () => {
    const layout = new Map([["Digit1", "&"]]);
    expect(restoreDescription([bullets], layout)).toContain(
      "Polish comes back without ⌥&, which Bullets uses.",
    );
    expect(restoreDescription([bullets], layout)).not.toContain("Prompt Engineer comes back");
  });
});

describe("Delete from the editor", () => {
  const editing = openEditor("edit", bullets, "editor-key");

  test("Delete then Cancel keeps the editor open on the same draft", () => {
    // The editor keeps its draft for as long as it stays mounted under the same key.
    expect(cancelDelete(askToDelete(editing))).toEqual(editing);
  });

  test("confirming closes the editor for good, though the confirm closes after it", () => {
    const deleted = cancelDelete(confirmDelete(askToDelete(editing)));
    expect(deleted).toEqual({ ...editing, open: false, deletion: "confirmed" });
  });
});
