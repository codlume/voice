import { describe, expect, test } from "vite-plus/test";

import type { AccountState } from "../shared/api.ts";
import { accountName, accountRow, emailDecoy, initials } from "./accountView.ts";

const separators = (text: string) =>
  [...text].flatMap((char, index) => ("@.-_".includes(char) ? [`${index}${char}`] : []));

describe("account view", () => {
  test("initials take the first letters of the first and last name, else G for Google account", () => {
    expect(initials({ firstName: "Augusta Ada", lastName: "King" })).toBe("AK");
    expect(initials({ firstName: "Ada", lastName: "" })).toBe("A");
    expect(initials({ firstName: "", lastName: "" })).toBe("G");
    expect(initials({ firstName: "ada", lastName: "lovelace" })).toBe("AL");
    expect(initials({ firstName: "Łukasz", lastName: "Ślęzak" })).toBe("ŁŚ");
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
    const ada = { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" };
    expect(accountName({ ...ada, name: " Ada Lovelace " })).toBe("Ada Lovelace");
    expect(accountName({ ...ada, name: "  " })).toBe("Google account");
  });

  test("the email decoy keeps the email's shape but none of its text", () => {
    const cases: [string, string[]][] = [
      ["ada.lovelace@example.com", ["ada"]],
      ["grace-hopper_1@navy.mil", ["grace", "navy"]],
    ];
    for (const [email, parts] of cases) {
      const decoy = emailDecoy(email);
      expect(decoy).toHaveLength(email.length);
      expect(separators(decoy)).toEqual(separators(email));
      expect(decoy).toBe(emailDecoy(email.replace(/[^@._-]/g, "z")));
      for (const part of parts) expect(decoy).not.toContain(part);
    }
  });
});
