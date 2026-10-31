import { describe, expect, test } from "vite-plus/test";

import {
  applyPart,
  candidatePairs,
  dropReplaced,
  emptyLedger,
  sameItem,
  type Ledger,
  type Part,
} from "./ledger.ts";

const owners = new Set(["You", "Speaker 1"]);

const part = (fields: Partial<Part>): Part => ({
  topics: [],
  decisions: [],
  nextSteps: [],
  ...fields,
});

const after = (...parts: Part[]): Ledger =>
  parts.reduce((ledger, next, index) => applyPart(ledger, index + 1, next, owners), emptyLedger);

describe("applyPart", () => {
  test("a repeated task in a later part takes over the earlier one, owner included", () => {
    const ledger = after(
      part({
        nextSteps: [
          { owner: "Speaker 1", task: "Send the press kit to Northlight.", status: "agreed" },
        ],
      }),
      part({
        nextSteps: [
          { owner: "You", task: "Send the press kit to Northlight today.", status: "agreed" },
        ],
      }),
    );

    expect(ledger.tasks.map(({ owner, text }) => [owner, text])).toEqual([
      ["You", "Send the press kit to Northlight today."],
    ]);
  });

  test("an owner the meeting does not have becomes unassigned, and stray @ and fragments go", () => {
    const ledger = after(
      part({
        topics: ["@Budget review.", " "],
        nextSteps: [
          { owner: "Speaker 7", task: "Order the new coffee machine.", status: "agreed" },
          { owner: "You", task: "Follow up", status: "agreed" },
        ],
      }),
    );

    expect(ledger.topics).toEqual(["Budget review."]);
    expect(ledger.tasks.map(({ owner, text }) => [owner, text])).toEqual([
      ["Unassigned", "Order the new coffee machine."],
    ]);
  });
});

test("items with the same words are the same item; a shared subject alone is not", () => {
  expect(sameItem("Ship the hotfix today.", "We ship the hotfix today")).toBe(true);
  expect(sameItem("Ship the hotfix today.", "Write the hotfix release notes.")).toBe(false);
});

describe("reconcile", () => {
  const ledger = after(
    part({
      decisions: [
        { decision: "No OpsWorld booth this year.", status: "final" },
        { decision: "Brightline Messaging replaces Pingwell.", status: "final" },
      ],
    }),
    part({
      decisions: [
        { decision: "A small OpsWorld booth, capped at eighteen thousand.", status: "final" },
        { decision: "Annual plans stay two months free.", status: "final" },
      ],
    }),
  );

  test("pairs only same-kind items from different parts that share two subject words", () => {
    const pairs = candidatePairs(ledger);

    expect(pairs.map(({ id, earlier, later }) => [id, earlier.text, later.text])).toEqual([
      [
        "P1",
        "No OpsWorld booth this year.",
        "A small OpsWorld booth, capped at eighteen thousand.",
      ],
    ]);
  });

  test("drops only the earlier item of a confirmed pair", () => {
    const pairs = candidatePairs(ledger);

    expect(dropReplaced(ledger, pairs, new Set()).decisions).toHaveLength(4);
    expect(dropReplaced(ledger, pairs, new Set(["P1"])).decisions.map(({ text }) => text)).toEqual([
      "Brightline Messaging replaces Pingwell.",
      "A small OpsWorld booth, capped at eighteen thousand.",
      "Annual plans stay two months free.",
    ]);
  });
});
