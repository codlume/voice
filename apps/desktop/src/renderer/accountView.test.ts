import { describe, expect, test } from "vite-plus/test";

import type { AccountState } from "../shared/api.ts";
import { accountRow, initials, signInCode } from "./accountView.ts";

describe("account view", () => {
  test("initials take the first two words of the name, else the email", () => {
    expect(initials("Ada Lovelace", "ada@example.com")).toBe("AL");
    expect(initials("ada king lovelace", "ada@example.com")).toBe("AK");
    expect(initials("  Grace  ", "grace@example.com")).toBe("G");
    expect(initials("", "ada@example.com")).toBe("A");
    expect(initials("   ", "zoe@example.com")).toBe("Z");
  });

  test("each state has its own row text", () => {
    const states: AccountState[] = [
      { kind: "unavailable", reason: "Set VOICE_API_URL to sign in from a development build." },
      { kind: "signedOut" },
      { kind: "signingIn" },
      { kind: "signedIn", name: "Ada Lovelace", email: "ada@example.com" },
      { kind: "signedIn", name: " ", email: "ada@example.com" },
      { kind: "error", message: "Sign-in was interrupted" },
    ];
    expect(states.map(accountRow)).toEqual([
      {
        title: "Accounts are unavailable",
        detail: "Set VOICE_API_URL to sign in from a development build.",
      },
      {
        title: "Google account",
        detail:
          "Sign in to use your Voice account. Your browser opens so you can pick a Google account.",
      },
      {
        title: "Waiting for your browser…",
        detail: "Finish signing in with Google, then come back to Voice.",
      },
      { title: "Ada Lovelace", detail: "ada@example.com" },
      { title: "ada@example.com", detail: "ada@example.com" },
      { title: "Sign-in was interrupted", detail: "Retry to sign in again." },
    ]);
  });

  test("a pasted code is trimmed and an empty paste is no code", () => {
    expect(signInCode("  eyJpZCI6ImFiYyJ9\n")).toBe("eyJpZCI6ImFiYyJ9");
    expect(signInCode(" \n\t")).toBeNull();
    expect(signInCode("")).toBeNull();
  });
});
