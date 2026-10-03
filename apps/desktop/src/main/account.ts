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
// The error row adds "Retry to sign in again.", so these name only what went wrong.
export const SIGN_IN_ERRORS = {
  browser: "Could not open your browser to sign in.",
  offline: "Could not reach the Voice server. Check your connection.",
  rejected: "The Voice server did not accept this sign-in.",
  interrupted: "Sign-in was interrupted.",
} as const;
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

export type CachedIdentity = { id?: string; name: string; email: string };
export type Identity = CachedIdentity & { id: string };

/**
 * `offline` is a failed fetch; `rejected` is the API refusing the code. `abandoned` is an exchange
 * aborted while the API answered, or outlived by a forget: nothing of it was stored.
 */
export type RedeemResult =
  | ({ kind: "signedIn" } & Identity)
  | { kind: "offline" | "rejected"; error: unknown }
  | { kind: "abandoned" };

export type DeleteAccountResult = { kind: "deleted" | "reauthRequired" | "failed" | "offline" };

/** What confirming a deletion came to: the API's answer, or a cookie that is another account's. */
type DeletionOutcome = DeleteAccountResult | { kind: "otherAccount"; user: Identity };

/** What the module needs from the Better Auth Electron client. The adapter owns the plugin details. */
export type AuthClient = {
  /** Resolves with the OAuth state of the sign-in it opened, which the code must carry back. */
  openBrowser(): Promise<{ state: string }>;
  /**
   * Exchanges the code for an auth session and stores it with its identity. Aborting abandons the
   * exchange: nothing is stored, and a session the API created anyway is queued for server sign-out.
   */
  redeem(code: string, signal: AbortSignal): Promise<RedeemResult>;
  /** The identity of the last sign-in or `get-session`, kept encrypted for an offline launch. */
  cachedUser(): CachedIdentity | null;
  /** Asks `get-session`. Aborted before its body is read, it answers `unreachable` and writes nothing. */
  checkAuthSession(signal: AbortSignal): Promise<AuthSessionCheck>;
  /** Deletes this channel's stored auth session. */
  forget(): void;
  /** Queues a complete Cookie header for revocation without changing the active session. */
  queueServerSignOut(cookie: string): void;
  /** Whether local auth remains to check after the adapter reconciles stored sign-outs. */
  hasAuthSession(): boolean;
  /** Queues the active cookie before clearing its cookie and identity through forget. */
  retireAuthSession(): void;
  /** Retries queued sign-outs once; confirmed sessions leave the queue, failures stay for launch. */
  endServerSignOuts(): Promise<ServerSignOut[]>;
  deleteAccount(): Promise<DeleteAccountResult>;
  revokeOlderAuthSession(): Promise<void>;
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

export type ServerSignOut = Exclude<AuthSessionCheck, { kind: "active" }>;

/** A code as the landing page shows it, with the OAuth state it carries. */
export type SignInCode = { code: string; state: string };

// The confirmation dialog names the account by email; a cached id is the stricter test when present.
const sameAccount = (confirmed: CachedIdentity, live: Identity) =>
  confirmed.id === undefined ? confirmed.email === live.email : confirmed.id === live.id;

const sameIdentity = (a: Identity, b: CachedIdentity) =>
  a.id === b.id && a.name === b.name && a.email === b.email;

function identityOf({ id, name, email }: CachedIdentity): CachedIdentity {
  return id === undefined ? { name, email } : { id, name, email };
}

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

/** A second copy of Voice hands its command line to the first; this finds a callback URL in it. */
export function callbackUrlFromArgv(argv: readonly string[]): string | undefined {
  return argv.find((arg) => arg.startsWith(`${VOICE_URL_SCHEME}:`));
}

// One sign-in attempt. The client promise and the timer exist exactly while signing in, so a
// late callback, a stale timer or a result from an older attempt has nothing to land on. The
// plugin keeps every attempt's verifier, so the attempt also remembers its own OAuth state and
// redeems only a code that carries it, once. The exchange of that code is aborted with the attempt,
// so an answer that arrives after Cancel or the deadline stores nothing.
type Attempt = {
  kind: "signingIn";
  attempt: number;
  client: Promise<AuthClient>;
  timer: NodeJS.Timeout;
  oauthState: string | null;
  exchange: AbortController | null;
  resumeAs: Identity | null;
};
type SignedInState = Extract<AccountState, { kind: "signedIn" }>;
type State = Exclude<AccountState, { kind: "signingIn" }> | Attempt;

function toAccountState(state: State): AccountState {
  if (state.kind === "signingIn") {
    return {
      kind: "signingIn",
      purpose: state.resumeAs === null ? "signIn" : "deleteAccount",
      phase: state.exchange ? "finishing" : "browser",
    };
  }
  return state;
}

export function createAccount({
  apiUrl,
  development,
  hasStoredAuthSession,
  hasStoredAuth,
  checkIntervalMs = AUTH_SESSION_CHECK_INTERVAL_MS,
  createClient,
  signInTimeoutMs,
  onChange,
  log,
}: {
  apiUrl: string | null;
  development: boolean;
  hasStoredAuthSession: () => boolean;
  hasStoredAuth: () => boolean;
  checkIntervalMs?: number;
  createClient: (apiUrl: string) => Promise<AuthClient>;
  signInTimeoutMs: number;
  onChange: (state: AccountState) => void;
  log: Log;
}) {
  let state: State = initialAccountState(apiUrl, development);
  let attempts = 0;
  let cachedClient: Promise<AuthClient> | null = null;
  let loadedClient: AuthClient | null = null;
  let lastCheck = Date.now();
  let restoreStarted = false;
  // The get-session in flight. Its response would still write the cookie it carries, so anything
  // that replaces the auth session aborts it first.
  let checking: AbortController | null = null;

  function abortCheck() {
    checking?.abort();
    checking = null;
  }

  function publish(next: State) {
    state = next;
    onChange(toAccountState(state));
  }

  function leave(attempt: number, next: Exclude<State, { kind: "signingIn" }>) {
    if (state.kind !== "signingIn" || state.attempt !== attempt) return;
    clearTimeout(state.timer);
    state.exchange?.abort();
    publish(next);
  }

  function loadClient(url: string): Promise<AuthClient> {
    if (!cachedClient) {
      cachedClient = createClient(url).then((client) => {
        loadedClient = client;
        return client;
      });
      cachedClient.catch(() => {
        cachedClient = null;
      });
    }
    return cachedClient;
  }

  function requestDeletion() {
    if (state.kind !== "signedIn" || (state.deletion && state.deletion.kind !== "failed")) return;
    abortCheck();
    publish({
      kind: "signedIn",
      ...identityOf(state),
      deletion: { kind: "confirming" },
    });
  }

  function failed(attempt: number, error: unknown, failure: "browser" | "offline" | "rejected") {
    if (state.kind !== "signingIn" || state.attempt !== attempt) return;
    log("account sign-in failed", {
      message: "account sign-in failed",
      level: "warn",
      attributes: { "error.type": errorType(error), "account.failure": failure },
    });
    const message = SIGN_IN_ERRORS[failure];
    const resumeAs = state.resumeAs;
    leave(
      attempt,
      resumeAs === null
        ? { kind: "error", message }
        : {
            kind: "signedIn",
            ...resumeAs,
            deletion: {
              kind: "reauthFailed",
              message,
            },
          },
    );
  }

  async function revokeOlderAuthSession(current: SignedInState) {
    if (apiUrl === null) return;
    let deletion: AccountDeletion = { kind: "confirming" };
    try {
      await (await loadClient(apiUrl)).revokeOlderAuthSession();
    } catch (error) {
      log("account auth session revocation failed", {
        message: "account auth session revocation failed",
        level: "warn",
        attributes: { "error.type": errorType(error) },
      });
      deletion = { kind: "revocationFailed", message: REVOKE_AUTH_SESSION_FAILED_MESSAGE };
    }
    if (state === current && current.deletion?.kind === "revoking")
      publish({ ...current, deletion });
  }

  async function endServerSignOuts(client: AuthClient) {
    for (const answer of await client.endServerSignOuts()) {
      if (answer.kind === "ended") continue;
      log("account server sign-out failed", {
        message: "account server sign-out failed",
        level: "warn",
        attributes:
          answer.kind === "unknown"
            ? { "http.response.status_code": answer.status }
            : { "error.type": errorType(answer.error) },
      });
    }
  }

  /** Redeems a code for the attempt, or returns null when the code is not this attempt's. */
  function complete(current: Attempt, { code, state: oauthState }: SignInCode) {
    if (oauthState !== current.oauthState) {
      log("account: code from another sign-in ignored");
      return null;
    }
    if (current.exchange) {
      log("account: code ignored while one is being redeemed");
      return Promise.resolve();
    }
    current.exchange = new AbortController();
    onChange(toAccountState(current));
    return redeem(current, code, current.exchange.signal);
  }

  async function redeem(current: Attempt, code: string, signal: AbortSignal) {
    let result: RedeemResult;
    try {
      result = await (await current.client).redeem(code, signal);
    } catch (error) {
      result = { kind: "rejected", error };
    }
    // Only an attempt that already left, through Cancel or its deadline, abandons its exchange.
    if (result.kind === "abandoned") return;
    if (result.kind === "signedIn") {
      const user = { id: result.id, name: result.name, email: result.email };
      if (current.resumeAs === null) {
        leave(current.attempt, { kind: "signedIn", ...user });
      } else {
        const next: SignedInState = sameAccount(current.resumeAs, user)
          ? { kind: "signedIn", ...user, deletion: { kind: "revoking" } }
          : {
              kind: "signedIn",
              ...user,
              notice: `You signed in as ${user.email}, so Voice did not delete ${current.resumeAs.email}.`,
            };
        leave(current.attempt, next);
        if (state === next) await revokeOlderAuthSession(next);
      }
    } else {
      failed(current.attempt, result.error, result.kind);
    }
  }

  // One bounded get-session for a decision. Null when a sign-out, a sign-in or dispose aborted
  // it; past the deadline, unreachable.
  async function askAuthSession(client: AuthClient): Promise<AuthSessionCheck | null> {
    const controller = new AbortController();
    abortCheck();
    checking = controller;
    const deadline = AbortSignal.timeout(30_000);
    const answer = await client.checkAuthSession(AbortSignal.any([controller.signal, deadline]));
    if (checking === controller) checking = null;
    if (controller.signal.aborted) return null;
    return deadline.aborted ? { kind: "unreachable", error: deadline.reason } : answer;
  }

  // The API no longer has the auth session, so the stored one is gone and only a fresh sign-in can
  // show what is left.
  function endAuthSession(client: AuthClient, status: number) {
    log("account auth session ended", {
      message: "account auth session ended",
      level: "warn",
      attributes: { "http.response.status_code": status },
    });
    client.forget();
    publish({ kind: "error", message: AUTH_SESSION_ENDED_MESSAGE });
  }

  // A result lands only on the state it was started from, so a sign-in or a sign-out while the
  // request is in flight is never overwritten.
  async function checkAuthSession(client: AuthClient) {
    const checked = state;
    const controller = new AbortController();
    abortCheck();
    checking = controller;
    lastCheck = Date.now();
    const answer = await client.checkAuthSession(controller.signal);
    if (checking === controller) checking = null;
    if (state !== checked) return;
    switch (answer.kind) {
      case "active":
        if (checked.kind !== "signedIn" || !sameIdentity(answer.user, checked)) {
          publish({ kind: "signedIn", ...answer.user });
        }
        return;
      case "ended":
        endAuthSession(client, answer.status);
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
      if (apiUrl === null || state.kind !== "signedOut") return;
      if (!hasStoredAuth()) return;
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
      void endServerSignOuts(client);
      if (state.kind !== "signedOut" || !client.hasAuthSession()) return;
      const user = client.cachedUser();
      if (user !== null) publish({ kind: "signedIn", ...user });
      await checkAuthSession(client);
    },
    /** Called when the main window becomes visible. Checks at most once per interval. */
    async refresh() {
      if (state.kind !== "signedIn" || cachedClient === null) return;
      if (state.deletion) return;
      if (Date.now() - lastCheck < checkIntervalMs) return;
      const refreshing = state;
      // Claimed before the client resolves, so a show and a restore in one tick send one request.
      lastCheck = Date.now();
      const client = await cachedClient;
      if (state !== refreshing) return;
      await checkAuthSession(client);
    },
    async signIn() {
      const resumeAs =
        state.kind === "signedIn" &&
        state.id !== undefined &&
        (state.deletion?.kind === "reauthRequired" || state.deletion?.kind === "reauthFailed")
          ? { id: state.id, name: state.name, email: state.email }
          : null;
      if (
        apiUrl === null ||
        (state.kind !== "signedOut" && state.kind !== "error" && resumeAs === null)
      ) {
        log(`account: sign-in ignored while ${state.kind}`);
        return;
      }
      abortCheck();
      attempts += 1;
      const attempt = attempts;
      const timer = setTimeout(() => {
        if (state.kind === "signingIn" && state.resumeAs !== null && state.exchange) return;
        log("account sign-in timed out", { message: "account sign-in timed out", level: "warn" });
        leave(
          attempt,
          resumeAs === null ? { kind: "signedOut" } : { kind: "signedIn", ...resumeAs },
        );
      }, signInTimeoutMs);
      timer.unref();
      const client = loadClient(apiUrl);
      const current: Attempt = {
        kind: "signingIn",
        attempt,
        client,
        timer,
        oauthState: null,
        exchange: null,
        resumeAs,
      };
      publish(current);
      try {
        const opened = await client;
        // Cancel or the deadline may have ended this attempt while the client loaded.
        if (state !== current) return;
        if (resumeAs === null) {
          opened.retireAuthSession();
          void endServerSignOuts(opened);
        }
        current.oauthState = (await opened.openBrowser()).state;
      } catch (error) {
        failed(attempt, error, "browser");
      }
    },
    async submitSignInCode(value: string) {
      if (state.kind !== "signingIn") {
        log(`account: code ignored while ${state.kind}`);
        return;
      }
      const code = parseSignInCode(value);
      if (code === null) throw new Error(PASTE_CODE_MESSAGE);
      const redeeming = complete(state, code);
      if (redeeming === null) throw new Error(STALE_CODE_MESSAGE);
      await redeeming;
    },
    /** Whether the callback changed anything, so the caller knows whether to bring Voice forward. */
    handleCallbackUrl(url: string): "accepted" | "interrupted" | "ignored" {
      const code = parseCallbackUrl(url);
      if (code === null) {
        log("account: malformed callback URL");
        return "ignored";
      }
      if (state.kind === "signingIn")
        return complete(state, code) === null ? "ignored" : "accepted";
      // This process never started a sign-in, so the browser finished one that a quit or an
      // update restart cut short. Its verifier died with that process. A stored auth session
      // means the last process was signed in instead, and restore is about to sign in again.
      if (attempts === 0 && state.kind === "signedOut" && !hasStoredAuthSession()) {
        log("account: sign-in was interrupted");
        publish({ kind: "error", message: SIGN_IN_ERRORS.interrupted });
        return "interrupted";
      }
      log(`account: callback ignored while ${state.kind}`);
      return "ignored";
    },
    cancelSignIn() {
      if (state.kind !== "signingIn") return;
      if (state.resumeAs !== null && state.exchange) return;
      leave(
        state.attempt,
        state.resumeAs === null ? { kind: "signedOut" } : { kind: "signedIn", ...state.resumeAs },
      );
    },
    requestDeletion,
    cancelDeletion() {
      if (state.kind !== "signedIn" || !state.deletion) return;
      if (state.deletion.kind === "deleting" || state.deletion.kind === "revoking") return;
      publish({ kind: "signedIn", ...identityOf(state) });
    },
    async confirmDeletion() {
      if (state.kind !== "signedIn" || state.deletion?.kind !== "confirming" || apiUrl === null)
        return;
      let user = identityOf(state);
      const deleting: SignedInState = { kind: "signedIn", ...user, deletion: { kind: "deleting" } };
      publish(deleting);
      let outcome: DeletionOutcome;
      try {
        const client = await loadClient(apiUrl);
        if (state !== deleting) return;
        // The API deletes whichever account the stored cookie belongs to, and the cached identity
        // can be another account's. The cookie's account is asked for and must be the confirmed one.
        const answer = await askAuthSession(client);
        if (state !== deleting || answer === null) return;
        // Revoked, or already deleted by a request whose receipt was lost. A failed deletion
        // would only offer a retry that asks the same question again.
        if (answer.kind === "ended") {
          endAuthSession(client, answer.status);
          return;
        }
        if (answer.kind !== "active") {
          outcome = { kind: answer.kind === "unreachable" ? "offline" : "failed" };
        } else if (!sameAccount(user, answer.user)) {
          outcome = { kind: "otherAccount", user: answer.user };
        } else {
          user = answer.user;
          outcome = await client.deleteAccount();
          if (outcome.kind === "deleted" && state === deleting) client.forget();
        }
      } catch (error) {
        log("account deletion failed", {
          message: "account deletion failed",
          level: "warn",
          attributes: { "error.type": errorType(error) },
        });
        outcome = { kind: "failed" };
      }
      if (state !== deleting) return;
      switch (outcome.kind) {
        case "deleted":
          publish({ kind: "signedOut" });
          return;
        case "otherAccount":
          publish({
            kind: "signedIn",
            ...outcome.user,
            notice: `Voice is signed in as ${outcome.user.email}, so it did not delete ${user.email}.`,
          });
          return;
        case "reauthRequired":
          publish({
            kind: "signedIn",
            ...user,
            deletion: { kind: "reauthRequired", message: DELETE_ACCOUNT_REAUTH_MESSAGE },
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
                outcome.kind === "offline"
                  ? DELETE_ACCOUNT_OFFLINE_MESSAGE
                  : DELETE_ACCOUNT_FAILED_MESSAGE,
            },
          });
          return;
        default: {
          const exhaustive: never = outcome;
          return exhaustive;
        }
      }
    },
    async retryDeletion() {
      if (state.kind !== "signedIn") return;
      const { deletion } = state;
      if (deletion?.kind === "revocationFailed") {
        const revoking: SignedInState = {
          kind: "signedIn",
          ...identityOf(state),
          deletion: { kind: "revoking" },
        };
        publish(revoking);
        await revokeOlderAuthSession(revoking);
      } else if (deletion?.kind === "failed") {
        requestDeletion();
      }
    },
    async signOut() {
      if (state.kind !== "signedIn" || loadedClient === null) return;
      abortCheck();
      loadedClient.retireAuthSession();
      publish({ kind: "signedOut" });
      await endServerSignOuts(loadedClient);
    },
    dismissError() {
      if (state.kind === "error") publish({ kind: "signedOut" });
    },
    dispose() {
      abortCheck();
      if (state.kind !== "signingIn") return;
      clearTimeout(state.timer);
      state = { kind: "signedOut" };
    },
  };
}

export type Account = ReturnType<typeof createAccount>;
