import { describe, expect, test } from "vite-plus/test";

import type { AccountState } from "../shared/api.ts";
import { accountName, accountRow, emailDecoy, initials } from "./accountView.ts";

describe("account view", () => {
  test("initials take the first two words of the name, else the email", () => {
    expect(initials("Ada Lovelace", "ada@example.com")).toBe("AL");
    expect(initials("ada king lovelace", "ada@example.com")).toBe("AK");
    expect(initials("  Grace  ", "grace@example.com")).toBe("G");
    expect(initials("", "ada@example.com")).toBe("A");
    expect(initials("   ", "zoe@example.com")).toBe("Z");
  });

  test("each state has its own row text", () => {
    const states: Exclude<AccountState, { kind: "signedIn" }>[] = [
      { kind: "unavailable", reason: "Set VOICE_API_URL to sign in from a development build." },
      { kind: "signedOut" },
      { kind: "signingIn", purpose: "signIn", phase: "browser" },
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
        title: "Finish signing in in your browser",
        detail: "Choose your Google account, then click Open Voice.",
      },
      { title: "Sign-in was interrupted", detail: "Retry to sign in again." },
    ]);
  });

  test("the account name falls back to Google account when the name is blank", () => {
    expect(accountName({ name: " Ada Lovelace ", email: "ada@example.com" })).toBe("Ada Lovelace");
    expect(accountName({ name: "  ", email: "ada@example.com" })).toBe("Google account");
  });

  test("the email decoy keeps the email's shape but none of its text", () => {
    const email = "ada.lovelace@example.com";
    const decoy = emailDecoy(email);
    expect(decoy).toHaveLength(email.length);
    expect(decoy.indexOf("@")).toBe(email.indexOf("@"));
    expect([...decoy].map((char, index) => (char === "." ? index : -1))).toEqual(
      [...email].map((char, index) => (char === "." ? index : -1)),
    );
    expect(decoy).toMatch(/^[a-z2-9]+\.[a-z2-9]+@[a-z2-9]+\.[a-z2-9]+$/);
    for (const part of ["ada", "lovelace", "example", "com"]) expect(decoy).not.toContain(part);
    expect(emailDecoy(email)).toBe(decoy);
    expect(emailDecoy("grace.hopper@example.com")).not.toBe(decoy);
  });
});
