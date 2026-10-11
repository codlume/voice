import type { AccountIdentity, AccountName, AccountState } from "../shared/api.ts";

const UNNAMED_ACCOUNT = "Google account";

export function initials({ firstName, lastName }: AccountName): string {
  const letters = [firstName, lastName].map((part) => [...part.trim()][0] ?? "").join("");
  return (letters || UNNAMED_ACCOUNT.charAt(0)).toUpperCase();
}

export function accountName(identity: AccountIdentity): string {
  return identity.name.trim() || UNNAMED_ACCOUNT;
}

export function accountRow(state: Exclude<AccountState, { kind: "signedIn" }>): {
  title: string;
  detail: string;
} {
  switch (state.kind) {
    case "unavailable":
      return { title: "Accounts are unavailable", detail: state.reason };
    case "signedOut":
      return {
        title: "Google account",
        detail:
          "Sign in to use your Voice account. Your browser opens so you can pick a Google account.",
      };
    case "signingIn":
      return {
        title:
          state.purpose === "deleteAccount"
            ? "Sign in again to delete your account"
            : "Finish signing in in your browser",
        detail: "Choose your Google account, then click Open Voice.",
      };
    case "error":
      return { title: state.message, detail: "Retry to sign in again." };
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

const DECOY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function emailDecoy(email: string): string {
  return Array.from(email, (char, index) =>
    "@.-_".includes(char) ? char : DECOY_ALPHABET[(index * 7) % DECOY_ALPHABET.length],
  ).join("");
}
