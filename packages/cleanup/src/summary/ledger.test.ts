import { describe, expect, test } from "vite-plus/test";

import {
  applyPart,
  candidatePairs,
  describeItem,
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
  test("a task repeated under another owner stays for the pair step to judge", () => {
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

    expect(
      candidatePairs(ledger).map(({ earlier, later }) => [
        describeItem(earlier),
        describeItem(later),
      ]),
    ).toEqual([
      [
        "Speaker 1: Send the press kit to Northlight.",
        "You: Send the press kit to Northlight today.",
      ],
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

describe("sameItem", () => {
  test.each([
    ["Send the SMS migration plan to Kasia.", "Send the SMS migration plan to Kasia by Friday."],
    ["Ship the hotfix today.", "We will ship the hotfix today"],
    [
      "Wyślij dokumenty do Przelewy24.",
      "Wyślij wszystkie dokumenty do Przelewy24 do poniedziałku.",
    ],
  ])("%j repeats %j", (a, b) => {
    expect(sameItem(a, b)).toBe(true);
  });

  // Filler, owners' verbs and deadlines are shared; the object, name or platform is not.
  test.each([
    ["Send the contract to Tom by Friday.", "Send the invoice to Kasia by Friday."],
    ["The iOS app ships on Thursday.", "The Android app ships on Thursday."],
    ["We will use Stripe for EU payments.", "We will use PayU for Polish payments."],
    ["Hire two backend engineers in Q3.", "Hire two frontend engineers in Q3."],
    [
      "Review the design doc for onboarding by Friday.",
      "Review the design doc for checkout by Friday.",
    ],
    ["Call Brightline on Monday.", "Call Brightline on Friday."],
    ["Ship the hotfix today.", "Write the hotfix release notes."],
  ])("%j is not %j", (a, b) => {
    expect(sameItem(a, b)).toBe(false);
  });
});

describe("applyPart near misses", () => {
  test("distinct decisions and tasks in one part all stay, owners included", () => {
    const ledger = after(
      part({
        decisions: [
          { decision: "The iOS app ships on Thursday.", status: "final" },
          { decision: "The Android app ships on Thursday.", status: "final" },
        ],
        nextSteps: [
          { owner: "You", task: "Send the contract to Tom by Friday.", status: "agreed" },
          { owner: "You", task: "Send the invoice to Kasia by Friday.", status: "agreed" },
          {
            owner: "Speaker 1",
            task: "Review the design doc for onboarding by Friday.",
            status: "agreed",
          },
          {
            owner: "You",
            task: "Review the design doc for onboarding by Friday.",
            status: "agreed",
          },
        ],
      }),
    );

    expect(ledger.decisions).toHaveLength(2);
    expect(ledger.tasks.map(({ owner, text }) => [owner, text])).toEqual([
      ["You", "Send the contract to Tom by Friday."],
      ["You", "Send the invoice to Kasia by Friday."],
      ["Speaker 1", "Review the design doc for onboarding by Friday."],
      ["You", "Review the design doc for onboarding by Friday."],
    ]);
  });

  test("a repeat keeps its deadline wherever it was said", () => {
    const ledger = after(
      part({
        nextSteps: [
          { owner: "You", task: "Send the SMS migration plan by Friday.", status: "agreed" },
        ],
      }),
      part({
        decisions: [{ decision: "Brightline replaces Pingwell.", status: "final" }],
        nextSteps: [{ owner: "You", task: "Send the SMS migration plan.", status: "agreed" }],
      }),
      part({
        decisions: [{ decision: "Brightline replaces Pingwell for SMS.", status: "final" }],
      }),
    );

    expect(ledger.tasks.map((task) => [task.part, task.text])).toEqual([
      [2, "Send the SMS migration plan by Friday."],
    ]);
    expect(ledger.decisions.map((decision) => [decision.part, decision.text])).toEqual([
      [3, "Brightline replaces Pingwell for SMS."],
    ]);
  });
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
