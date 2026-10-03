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
        title: "Waiting for your browser…",
        detail: "Finish signing in with Google, then come back to Voice.",
      };
    case "signedIn":
      return { title: state.name.trim() || state.email, detail: state.email };
    case "error":
      return { title: state.message, detail: "Retry to sign in again." };
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/** A pasted code with surrounding whitespace removed, or null when nothing was pasted. */
export function signInCode(input: string): string | null {
  return input.trim() || null;
}

/** `ipcRenderer.invoke` wraps a main-process rejection as "Error invoking remote method '<channel>': Error: <message>". */
export function actionErrorMessage(caught: unknown, fallback: string): string {
  if (!(caught instanceof Error)) return fallback;
  return caught.message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, "");
}
