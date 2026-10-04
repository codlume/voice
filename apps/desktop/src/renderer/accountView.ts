import type { AccountState } from "../shared/api.ts";

export function initials(name: string, email: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 0 ? words.slice(0, 2).map((word) => word[0]) : [email.trim()[0]];
  return letters.join("").toUpperCase();
}

export function accountRow(state: AccountState): { title: string; detail: string } {
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
    case "signedIn":
      return { title: state.name.trim() || "Google account", detail: state.email };
    case "error":
      return { title: state.message, detail: "Retry to sign in again." };
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}
