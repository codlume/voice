import {
  VOICE_URL_SCHEME,
  type AccountDeletion,
  type AccountState,
  type UpdateChannel,
} from "../shared/api.ts";
import { errorType, type Log } from "./diagnostics-scrub.ts";
import type { ReleaseConfig } from "./updates.ts";

// The API base URL per release channel. Stable stays empty until #133.
export const API_URLS: Record<UpdateChannel, string | null> = {
  stable: null,
  nightly: "https://api-nightly.voice.codlume.com",
};

export const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
export const PASTE_CODE_MESSAGE = "Paste the whole code shown in the browser.";
export const OPEN_BROWSER_FAILED_MESSAGE = "Could not open your browser to sign in. Try again.";
export const SIGN_IN_FAILED_MESSAGE = "Sign-in failed. Try again.";
export const STALE_CODE_MESSAGE =
  "That code is from an earlier sign-in. Paste the code shown in the browser now.";
export const AUTH_SESSION_ENDED_MESSAGE = "Your sign-in expired or was revoked.";
export const AUTH_SESSION_CHECK_INTERVAL_MS = 60 * 60 * 1000;
export const DELETE_ACCOUNT_FAILED_MESSAGE = "Could not delete your account. Try again.";
export const DELETE_ACCOUNT_OFFLINE_MESSAGE =
  "Could not reach Voice. Check your connection and retry deleting your account.";
export const DELETE_ACCOUNT_REAUTH_MESSAGE = "Sign in again before deleting your account.";
export const REVOKE_AUTH_SESSION_FAILED_MESSAGE =
  "Could not end your previous sign-in. Retry before deleting your account.";

export type Identity = { name: string; email: string };

/** `offline` is a failed fetch; `rejected` is the API refusing the code. #130 shows them apart. */
export type RedeemResult =
  | { kind: "signedIn"; name: string; email: string }
  | { kind: "offline" | "rejected"; error: unknown };

type RevokeOlderAuthSession = () => Promise<void>;
export type DeleteAccountResult =
  | { kind: "deleted" }
  | { kind: "reauthRequired"; revokeOlderAuthSession: RevokeOlderAuthSession }
  | { kind: "failed" | "offline" };

/** What the module needs from the Better Auth Electron client. The adapter owns the plugin details. */
export type AuthClient = {
  /** Resolves with the OAuth state of the sign-in it opened, which the code must carry back. */
  openBrowser(): Promise<{ state: string }>;
  redeem(code: string): Promise<RedeemResult>;
  /** The identity from the last `get-session`, decrypted from the plugin's storage. */
  cachedUser(): Identity | null;
  checkAuthSession(): Promise<AuthSessionCheck>;
  /** Deletes this channel's stored auth session. */
  forget(): void;
  deleteAccount(): Promise<DeleteAccountResult>;
};

/**
 * What the API said about the stored auth session. Only `ended` means it is gone; the API could
 * not be reached (`unreachable`) or answered something that says nothing about it (`unknown`).
 */
export type AuthSessionCheck =
  | { kind: "active"; user: Identity }
  | { kind: "ended"; status: number }
  | { kind: "unknown"; status: number }
  | { kind: "unreachable"; error: unknown };

/** A code as the landing page shows it, with the OAuth state it carries. */
export type SignInCode = { code: string; state: string };

const sameIdentity = (a: Identity, b: Identity) => a.name === b.name && a.email === b.email;

function parseHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

// A development build reads VOICE_API_URL only. A packaged build without release metadata is a
// local build and must never reach production.
export function resolveApiUrl({
  development,
  release,
  env,
}: {
  development: boolean;
  release: ReleaseConfig | null;
  env: NodeJS.ProcessEnv;
}): string | null {
  if (development) return env.VOICE_API_URL ? parseHttpUrl(env.VOICE_API_URL) : null;
  return release ? API_URLS[release.channel] : null;
}

// The code is the `better-auth.electron` cookie value: base64url JSON with the identifier and
// state, possibly percent-encoded by the cookie serializer. The plugin decodes it the same way.
export function parseSignInCode(value: string): SignInCode | null {
  const code = value.trim();
  let text: string;
  try {
    text = decodeURIComponent(code);
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9_-]+=*$/.test(text)) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  return typeof decoded === "object" &&
    decoded !== null &&
    "identifier" in decoded &&
    typeof decoded.identifier === "string" &&
    "state" in decoded &&
    typeof decoded.state === "string"
    ? { code, state: decoded.state }
    : null;
}

/** A build starts unavailable or signed out. `restore` signs in from storage after launch. */
function initialAccountState(
  apiUrl: string | null,
  development: boolean,
): Extract<AccountState, { kind: "unavailable" | "signedOut" }> {
  if (apiUrl !== null) return { kind: "signedOut" };
  return {
    kind: "unavailable",
    reason: development
      ? "Set VOICE_API_URL to sign in from a development build."
      : "Accounts are unavailable in this build.",
  };
}

export function parseCallbackUrl(url: string): SignInCode | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${VOICE_URL_SCHEME}:`) return null;
  if (`/${parsed.hostname}${parsed.pathname}` !== "/auth/callback") return null;
  if (!parsed.hash.startsWith("#token=")) return null;
  // The landing page puts the cookie value in the fragment as is, so the token is the same
  // string the user would paste.
  return parseSignInCode(parsed.hash.slice("#token=".length));
}

// One sign-in attempt. The client promise and the timer exist exactly while signing in, so a
// late callback, a stale timer or a result from an older attempt has nothing to land on. The
// plugin keeps every attempt's verifier, so the attempt also remembers its own OAuth state and
// redeems only a code that carries it, once.
type Attempt = {
  kind: "signingIn";
  attempt: number;
  client: Promise<AuthClient>;
  timer: NodeJS.Timeout;
  oauthState: string | null;
  redeeming: boolean;
  reauthentication: { user: Identity; revokeOlderAuthSession: RevokeOlderAuthSession } | null;
};
type DeletionState =
  | Exclude<AccountDeletion, { kind: "reauthRequired" | "revoking" | "revocationFailed" }>
  | (Extract<AccountDeletion, { kind: "reauthRequired" | "revoking" | "revocationFailed" }> & {
      revokeOlderAuthSession: RevokeOlderAuthSession;
    });
type SignedInState = Identity & { kind: "signedIn"; deletion?: DeletionState };
type State = Exclude<AccountState, { kind: "signingIn" | "signedIn" }> | SignedInState | Attempt;

function toAccountState(state: State): AccountState {
  if (state.kind === "signingIn") {
    return state.reauthentication === null
      ? { kind: "signingIn" }
      : {
          kind: "signingIn",
          purpose: "deleteAccount",
          phase: state.redeeming ? "finishing" : "browser",
        };
  }
  if (state.kind !== "signedIn") return state;
  const { deletion, name, email } = state;
  if (!deletion) return { kind: "signedIn", name, email };
  if ("revokeOlderAuthSession" in deletion) {
    const { revokeOlderAuthSession: _revoke, ...publicDeletion } = deletion;
    return { kind: "signedIn", name, email, deletion: publicDeletion };
  }
  return { kind: "signedIn", name, email, deletion };
}

export function createAccount({
  apiUrl,
  development,
  hasStoredAuthSession,
  checkIntervalMs = AUTH_SESSION_CHECK_INTERVAL_MS,
  createClient,
  onChange,
  log,
}: {
  apiUrl: string | null;
  development: boolean;
  hasStoredAuthSession: () => boolean;
  checkIntervalMs?: number;
  createClient: (apiUrl: string) => Promise<AuthClient>;
  onChange: (state: AccountState) => void;
  log: Log;
}) {
  let state: State = initialAccountState(apiUrl, development);
  let attempts = 0;
  let cachedClient: Promise<AuthClient> | null = null;
  let lastCheck = Date.now();
  let restoreStarted = false;

  function publish(next: State) {
    state = next;
    onChange(toAccountState(state));
  }

  function leave(attempt: number, next: Exclude<State, { kind: "signingIn" }>) {
    if (state.kind !== "signingIn" || state.attempt !== attempt) return;
    clearTimeout(state.timer);
    publish(next);
  }

  function loadClient(url: string): Promise<AuthClient> {
    if (!cachedClient) {
      cachedClient = createClient(url);
      cachedClient.catch(() => {
        cachedClient = null;
      });
    }
    return cachedClient;
  }

  function failed(attempt: number, error: unknown, message: string) {
    if (state.kind !== "signingIn" || state.attempt !== attempt) return;
    log("account sign-in failed", {
      message: "account sign-in failed",
      level: "warn",
      attributes: { "error.type": errorType(error) },
    });
    const reauthentication = state.reauthentication;
    leave(
      attempt,
      reauthentication === null
        ? { kind: "error", message }
        : {
            kind: "signedIn",
            ...reauthentication.user,
            deletion: {
              kind: "reauthRequired",
              message,
              revokeOlderAuthSession: reauthentication.revokeOlderAuthSession,
            },
          },
    );
  }

  async function revokeOlderAuthSession(user: Identity, revoke: RevokeOlderAuthSession) {
    const revoking: SignedInState = {
      kind: "signedIn",
      ...user,
      deletion: { kind: "revoking", revokeOlderAuthSession: revoke },
    };
    publish(revoking);
    try {
      await revoke();
      if (state === revoking)
        publish({ kind: "signedIn", ...user, deletion: { kind: "confirming" } });
    } catch (error) {
      log("account auth session revocation failed", {
        message: "account auth session revocation failed",
        level: "warn",
        attributes: { "error.type": errorType(error) },
      });
      if (state === revoking)
        publish({
          kind: "signedIn",
          ...user,
          deletion: {
            kind: "revocationFailed",
            message: REVOKE_AUTH_SESSION_FAILED_MESSAGE,
            revokeOlderAuthSession: revoke,
          },
        });
    }
  }

  /** Redeems a code for the attempt; returns false when the code is not this attempt's. */
  async function complete(current: Attempt, { code, state: oauthState }: SignInCode) {
    if (oauthState !== current.oauthState) {
      log("account: code from another sign-in ignored");
      return false;
    }
    if (current.redeeming) {
      log("account: code ignored while one is being redeemed");
      return true;
    }
    current.redeeming = true;
    if (current.reauthentication !== null) onChange(toAccountState(current));
    let result: RedeemResult;
    try {
      result = await (await current.client).redeem(code);
    } catch (error) {
      result = { kind: "rejected", error };
    }
    if (result.kind === "signedIn") {
      if (state !== current) return true;
      const user = { name: result.name, email: result.email };
      if (current.reauthentication === null) {
        leave(current.attempt, { kind: "signedIn", ...user });
      } else {
        clearTimeout(current.timer);
        await revokeOlderAuthSession(user, current.reauthentication.revokeOlderAuthSession);
      }
    } else {
      failed(current.attempt, result.error, SIGN_IN_FAILED_MESSAGE);
    }
    return true;
  }

  // A result lands only on the state it was started from, so a sign-in or a sign-out while the
  // request is in flight is never overwritten.
  async function checkAuthSession(client: AuthClient) {
    const checked = state;
    lastCheck = Date.now();
    const answer = await client.checkAuthSession();
    if (state !== checked) return;
    switch (answer.kind) {
      case "active":
        if (checked.kind !== "signedIn" || !sameIdentity(answer.user, checked)) {
          publish({ kind: "signedIn", ...answer.user });
        }
        return;
      case "ended":
        log("account auth session ended", {
          message: "account auth session ended",
          level: "warn",
          attributes: { "http.response.status_code": answer.status },
        });
        client.forget();
        publish({ kind: "error", message: AUTH_SESSION_ENDED_MESSAGE });
        return;
      case "unknown":
        log("account auth session check failed", {
          message: "account auth session check failed",
          level: "warn",
          attributes: { "http.response.status_code": answer.status },
        });
        return;
      case "unreachable":
        log("account auth session check failed", {
          message: "account auth session check failed",
          level: "warn",
          attributes: { "error.type": errorType(answer.error) },
        });
        return;
      default: {
        const exhaustive: never = answer;
        return exhaustive;
      }
    }
  }

  return {
    get state(): AccountState {
      return toAccountState(state);
    },
    /**
     * Signs in from the stored auth session, then asks the API whether it still holds. Runs once
     * per launch; without a cached identity the API's answer alone decides.
     */
    async restore() {
      if (restoreStarted) return;
      restoreStarted = true;
      if (apiUrl === null || state.kind !== "signedOut" || !hasStoredAuthSession()) return;
      let client: AuthClient;
      try {
        client = await loadClient(apiUrl);
      } catch (error) {
        log("account restore failed", {
          message: "account restore failed",
          level: "warn",
          attributes: { "error.type": errorType(error) },
        });
        return;
      }
      if (state.kind !== "signedOut") return;
      const user = client.cachedUser();
      if (user !== null) publish({ kind: "signedIn", ...user });
      await checkAuthSession(client);
    },
    /** Called when the main window becomes visible. Checks at most once per interval. */
    async refresh() {
      if (state.kind !== "signedIn" || cachedClient === null) return;
      if (state.deletion) return;
      if (Date.now() - lastCheck < checkIntervalMs) return;
      await checkAuthSession(await cachedClient);
    },
    async signIn() {
      const reauthentication =
        state.kind === "signedIn" && state.deletion?.kind === "reauthRequired"
          ? {
              user: { name: state.name, email: state.email },
              revokeOlderAuthSession: state.deletion.revokeOlderAuthSession,
            }
          : null;
      if (
        apiUrl === null ||
        (state.kind !== "signedOut" && state.kind !== "error" && reauthentication === null)
      ) {
        log(`account: sign-in ignored while ${state.kind}`);
        return;
      }
      attempts += 1;
      const attempt = attempts;
      const timer = setTimeout(() => {
        if (state.kind === "signingIn" && state.reauthentication !== null && state.redeeming)
          return;
        log("account sign-in timed out", { message: "account sign-in timed out", level: "warn" });
        leave(
          attempt,
          reauthentication === null
            ? { kind: "signedOut" }
            : { kind: "signedIn", ...reauthentication.user },
        );
      }, SIGN_IN_TIMEOUT_MS);
      timer.unref();
      const client = loadClient(apiUrl);
      const current: Attempt = {
        kind: "signingIn",
        attempt,
        client,
        timer,
        oauthState: null,
        redeeming: false,
        reauthentication,
      };
      publish(current);
      try {
        current.oauthState = (await (await client).openBrowser()).state;
      } catch (error) {
        failed(attempt, error, OPEN_BROWSER_FAILED_MESSAGE);
      }
    },
    async submitSignInCode(value: string) {
      if (state.kind !== "signingIn") {
        log(`account: code ignored while ${state.kind}`);
        return;
      }
      const code = parseSignInCode(value);
      if (code === null) throw new Error(PASTE_CODE_MESSAGE);
      if (!(await complete(state, code))) throw new Error(STALE_CODE_MESSAGE);
    },
    handleCallbackUrl(url: string) {
      const code = parseCallbackUrl(url);
      if (code === null) {
        log("account: malformed callback URL");
        return;
      }
      if (state.kind !== "signingIn") {
        log(`account: callback ignored while ${state.kind}`);
        return;
      }
      void complete(state, code);
    },
    cancelSignIn() {
      if (state.kind !== "signingIn") return;
      if (state.reauthentication !== null && state.redeeming) return;
      leave(
        state.attempt,
        state.reauthentication === null
          ? { kind: "signedOut" }
          : { kind: "signedIn", ...state.reauthentication.user },
      );
    },
    requestDeletion() {
      if (state.kind !== "signedIn" || (state.deletion && state.deletion.kind !== "failed")) return;
      publish({
        kind: "signedIn",
        name: state.name,
        email: state.email,
        deletion: { kind: "confirming" },
      });
    },
    cancelDeletion() {
      if (state.kind !== "signedIn" || !state.deletion) return;
      if (
        state.deletion.kind === "deleting" ||
        state.deletion.kind === "revoking" ||
        state.deletion.kind === "revocationFailed"
      )
        return;
      publish({ kind: "signedIn", name: state.name, email: state.email });
    },
    async confirmDeletion() {
      if (state.kind !== "signedIn" || state.deletion?.kind !== "confirming" || apiUrl === null)
        return;
      const user = { name: state.name, email: state.email };
      const deleting: SignedInState = { kind: "signedIn", ...user, deletion: { kind: "deleting" } };
      publish(deleting);
      let result: DeleteAccountResult;
      let client: AuthClient;
      try {
        client = await loadClient(apiUrl);
        result = await client.deleteAccount();
      } catch (error) {
        log("account deletion failed", {
          message: "account deletion failed",
          level: "warn",
          attributes: { "error.type": errorType(error) },
        });
        if (state === deleting)
          publish({
            kind: "signedIn",
            ...user,
            deletion: { kind: "failed", message: DELETE_ACCOUNT_FAILED_MESSAGE },
          });
        return;
      }
      if (state !== deleting) return;
      switch (result.kind) {
        case "deleted":
          client.forget();
          publish({ kind: "signedOut" });
          return;
        case "reauthRequired":
          publish({
            kind: "signedIn",
            ...user,
            deletion: {
              kind: "reauthRequired",
              message: DELETE_ACCOUNT_REAUTH_MESSAGE,
              revokeOlderAuthSession: result.revokeOlderAuthSession,
            },
          });
          return;
        case "failed":
        case "offline":
          publish({
            kind: "signedIn",
            ...user,
            deletion: {
              kind: "failed",
              message:
                result.kind === "offline"
                  ? DELETE_ACCOUNT_OFFLINE_MESSAGE
                  : DELETE_ACCOUNT_FAILED_MESSAGE,
            },
          });
          return;
        default: {
          const exhaustive: never = result;
          return exhaustive;
        }
      }
    },
    async retryDeletion() {
      if (state.kind !== "signedIn") return;
      const { deletion, name, email } = state;
      if (deletion?.kind === "revocationFailed") {
        await revokeOlderAuthSession({ name, email }, deletion.revokeOlderAuthSession);
      } else if (deletion?.kind === "failed") {
        publish({ kind: "signedIn", name, email, deletion: { kind: "confirming" } });
      }
    },
    dismissError() {
      if (state.kind === "error") publish({ kind: "signedOut" });
    },
    dispose() {
      if (state.kind !== "signingIn") return;
      clearTimeout(state.timer);
      state = { kind: "signedOut" };
    },
  };
}

export type Account = ReturnType<typeof createAccount>;
