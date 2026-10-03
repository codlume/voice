import { VOICE_URL_SCHEME, type AccountState, type UpdateChannel } from "../shared/api.ts";
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

/** What the module needs from the Better Auth Electron client. The adapter owns the plugin details. */
export type AuthClient = {
  openBrowser(): Promise<void>;
  redeem(code: string): Promise<{ name: string; email: string }>;
};

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
export function parseSignInCode(value: string): string | null {
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
    ? code
    : null;
}

/** Nothing is restored yet (#129), so a build starts unavailable or signed out. */
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

export function parseCallbackUrl(url: string): string | null {
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
// late callback, a stale timer or a result from an older attempt has nothing to land on.
type State =
  | Exclude<AccountState, { kind: "signingIn" }>
  | { kind: "signingIn"; attempt: number; client: Promise<AuthClient>; timer: NodeJS.Timeout };

const toAccountState = (state: State): AccountState =>
  state.kind === "signingIn" ? { kind: "signingIn" } : state;

export function createAccount({
  apiUrl,
  development,
  createClient,
  onChange,
  log,
}: {
  apiUrl: string | null;
  development: boolean;
  createClient: (apiUrl: string) => Promise<AuthClient>;
  onChange: (state: AccountState) => void;
  log: Log;
}) {
  let state: State = initialAccountState(apiUrl, development);
  let attempts = 0;
  let cachedClient: Promise<AuthClient> | null = null;

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
    leave(attempt, { kind: "error", message });
  }

  async function complete(
    { attempt, client }: Extract<State, { kind: "signingIn" }>,
    code: string,
  ) {
    try {
      const user = await (await client).redeem(code);
      leave(attempt, { kind: "signedIn", name: user.name, email: user.email });
    } catch (error) {
      failed(attempt, error, SIGN_IN_FAILED_MESSAGE);
    }
  }

  return {
    get state(): AccountState {
      return toAccountState(state);
    },
    async signIn() {
      if (apiUrl === null || (state.kind !== "signedOut" && state.kind !== "error")) {
        log(`account: sign-in ignored while ${state.kind}`);
        return;
      }
      attempts += 1;
      const attempt = attempts;
      const timer = setTimeout(() => {
        log("account sign-in timed out", { message: "account sign-in timed out", level: "warn" });
        leave(attempt, { kind: "signedOut" });
      }, SIGN_IN_TIMEOUT_MS);
      timer.unref();
      const client = loadClient(apiUrl);
      publish({ kind: "signingIn", attempt, client, timer });
      try {
        await (await client).openBrowser();
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
      await complete(state, code);
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
      if (state.kind === "signingIn") leave(state.attempt, { kind: "signedOut" });
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
