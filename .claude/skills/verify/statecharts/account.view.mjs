const PAGE = {
  unavailable: "Accounts unavailable",
  restoring: "Just launched, checking your sign-in",
  launching: "Just launched, shows Signed out",
  signedOut: "Signed out",
  waiting: "Signing in",
  finishing: "Signing in",
  signedIn: "Signed in",
  deleting: "Deleting account",
  error: "Error with Retry and Dismiss",
};

export const title = "Account sign-in";

const pending = (v) => v.page === "signedOut" && v.queue !== "empty";

export const state = (v) =>
  pending(v) ? "Signed out, old sign-in not yet ended on the server" : PAGE[v.page];

export const group = (v) => {
  if (v.page === "signedIn" || v.page === "deleting") return "Signed in";
  if (v.page === "waiting" || v.page === "finishing") return "Signing in";
  if (v.page === "error") return "Error";
  if (v.page === "restoring") return "Checking";
  return "Signed out";
};

export const colors = {
  "Signed in": "teal",
  "Signing in": "blue",
  Checking: "blue",
  Error: "orange",
  "Signed out": "tan",
};

const LABEL = {
  Restore: (_from, to) => {
    if (to.page === "signedIn") return "Voice restores the stored sign-in";
    return pending(to) ? null : "Voice finds no stored sign-in";
  },
  YouClickSignIn: () => "you click Sign in with Google",
  YouRetry: () => "you click Retry",
  ServerAcceptsCode: () => "the server accepts your code",
  SignInFails: () => "the sign-in fails or the server cannot be reached",
  YouCancel: () => "you cancel, or 10 minutes pass",
  TimesOut: () => "you cancel, or 10 minutes pass",
  OldCodeArrives: (from) =>
    from.page === "launching" || pending(from) ? null : "a code from before a restart arrives",
  YouDismiss: (_from, to) => (pending(to) ? null : "you click Dismiss"),
  YouSignOut: () => "you click Sign out",
  VoiceEndsOldSignIn: () => "Voice ends the old sign-in on the server",
  VoiceLearnsSignInEnded: () => "Voice learns the sign-in ended",
  YouConfirmDeletion: () => "you confirm Delete account",
  ServerDeletesAccount: (_from, to) => (pending(to) ? null : "the server deletes the account"),
  DeletionFails: () => "the deletion fails or the server cannot be reached",
  YourCodeArrives: () => "your code arrives (paste, callback, or second copy)",
  ServerEndsSignIn: () => "the sign-in expires or is revoked on the server",
  OldSignInStaysQueued: () => "the old sign-in cannot be ended yet",
  NetworkDrops: () => "the network drops",
  NetworkReturns: () => "the network returns",
  YouRestart: (from) =>
    from.page === "signedIn" || from.page === "waiting" ? "you quit and reopen Voice" : null,
};

export const step = (action, from, to) => LABEL[action]?.(from, to) ?? null;
