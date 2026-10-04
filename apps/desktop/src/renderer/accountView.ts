import type { AccountIdentity, AccountState } from "../shared/api.ts";

// A nameless account shows "G", for Google account, so the avatar never hints at the email.
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "G";
  return words
    .slice(0, 2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

export function accountName(identity: AccountIdentity): string {
  return identity.name.trim() || "Google account";
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
  let state = 0x811c9dc5;
  for (let index = 0; index < email.length; index += 1) {
    state ^= email.charCodeAt(index);
    state = Math.imul(state, 0x01000193);
  }
  const nextChar = () => {
    state = Math.imul(state ^ (state >>> 13), 0x85ebca6b);
    state = Math.imul(state ^ (state >>> 16), 0xc2b2ae35);
    return DECOY_ALPHABET.charAt(Math.abs(state) % DECOY_ALPHABET.length);
  };
  return Array.from(email, (char) => ("@.-_".includes(char) ? char : nextChar())).join("");
}
