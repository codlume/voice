import { readFileSync } from "node:fs";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { parse } from "yaml";

import { VOICE_URL_SCHEME } from "../shared/api.ts";
import {
  API_URLS,
  AUTH_SESSION_CHECK_INTERVAL_MS,
  AUTH_SESSION_ENDED_MESSAGE,
  PASTE_CODE_MESSAGE,
  SIGN_IN_ERRORS,
  SIGN_IN_TIMEOUT_MS,
  STALE_CODE_MESSAGE,
  callbackUrlFromArgv,
  parseCallbackUrl,
  parseSignInCode,
  resolveApiUrl,
} from "./account.ts";
import { createDictation, whenNotDictating } from "./dictation.ts";
import type { HelperCommand } from "./protocol.ts";
import {
  API_URL,
  CODE,
  SECOND_CODE,
  USER,
  callbackUrl,
  encode,
  expectNoSecrets,
  flush,
  harness,
  restore,
  refresh,
  startSignIn,
  withStoredAuthSession,
} from "./account.test-harness.ts";
import { idle } from "./session.ts";

describe("resolveApiUrl", () => {
  const release = { channel: "nightly" as const, updateUrl: "https://downloads.example.com" };

  test("a development build reads VOICE_API_URL only", () => {
    expect(
      resolveApiUrl({
        development: true,
        release,
        env: { VOICE_API_URL: "http://localhost:8787/" },
      }),
    ).toBe("http://localhost:8787");
    expect(resolveApiUrl({ development: true, release, env: {} })).toBeNull();
    expect(
      resolveApiUrl({ development: true, release: null, env: { VOICE_API_URL: "" } }),
    ).toBeNull();
    for (const value of [
      "localhost:8787",
      "ftp://localhost:8787",
      "http://user:secret@localhost:8787",
      "http://localhost:8787?token=x",
      "http://localhost:8787#x",
      "not a url",
    ]) {
      expect(
        resolveApiUrl({ development: true, release, env: { VOICE_API_URL: value } }),
      ).toBeNull();
    }
  });

  test("a packaged build uses its channel's entry and ignores the environment", () => {
    const env = { VOICE_API_URL: "http://localhost:8787" };
    expect(resolveApiUrl({ development: false, release, env })).toBe(API_URLS.nightly);
    expect(API_URLS.nightly).toBe(API_URL);
    expect(
      resolveApiUrl({ development: false, release: { ...release, channel: "stable" }, env }),
    ).toBeNull();
    expect(resolveApiUrl({ development: false, release: null, env })).toBeNull();
  });

  test("the initial state names the fix for a development build", () => {
    expect(harness({ development: true }).state).toEqual({ kind: "signedOut" });
    expect(harness({ apiUrl: null, development: true }).state).toEqual({
      kind: "unavailable",
      reason: expect.stringContaining("VOICE_API_URL"),
    });
    expect(harness({ apiUrl: null }).state).toEqual({
      kind: "unavailable",
      reason: "Accounts are unavailable in this build.",
    });
  });
});

describe("parseSignInCode", () => {
  test("accepts the cookie value, trimmed, padded or percent-encoded", () => {
    expect(parseSignInCode(CODE)).toEqual({ code: CODE, state: "state1" });
    expect(parseSignInCode(`  ${CODE}\n`)).toEqual({ code: CODE, state: "state1" });
    const padded = Buffer.from(JSON.stringify({ identifier: "i", state: "st" })).toString("base64");
    expect(padded.endsWith("=")).toBe(true);
    expect(parseSignInCode(padded)).toEqual({ code: padded, state: "st" });
    const encoded = encodeURIComponent(padded);
    expect(encoded).toContain("%3D");
    expect(parseSignInCode(encoded)).toEqual({ code: encoded, state: "st" });
  });

  test("rejects anything that is not base64url JSON with an identifier and a state", () => {
    for (const value of [
      "",
      "   ",
      "electron_authorization_code_1",
      encode({ identifier: "i" }),
      encode({ state: "s" }),
      encode({ identifier: 1, state: "s" }),
      encode("text"),
      encode(null),
      `${CODE}!`,
      "%E0%A4%A",
    ]) {
      expect(parseSignInCode(value)).toBeNull();
    }
  });
});

describe("callbackUrlFromArgv", () => {
  test("finds the callback URL in a second copy's command line", () => {
    const url = callbackUrl(CODE);
    expect(
      callbackUrlFromArgv(["/Applications/Voice.app/Contents/MacOS/Voice", "--flag", url]),
    ).toBe(url);
    expect(callbackUrlFromArgv(["/path/Electron", ".", "--remote-debugging-port=9355"])).toBe(
      undefined,
    );
    expect(callbackUrlFromArgv(["/path/Electron", `https://example.com/#token=${CODE}`])).toBe(
      undefined,
    );
  });
});

describe("parseCallbackUrl", () => {
  test("accepts only the app scheme, the callback path and a valid token", () => {
    expect(parseCallbackUrl(callbackUrl(CODE))).toEqual({ code: CODE, state: "state1" });
    const padded = Buffer.from(JSON.stringify({ identifier: "i", state: "st" })).toString("base64");
    const encoded = encodeURIComponent(padded);
    expect(parseCallbackUrl(callbackUrl(encoded))).toEqual({ code: encoded, state: "st" });
    for (const url of [
      `https://auth/callback#token=${CODE}`,
      `${VOICE_URL_SCHEME}://auth/other#token=${CODE}`,
      `${VOICE_URL_SCHEME}://other/callback#token=${CODE}`,
      `${VOICE_URL_SCHEME}://auth/callback`,
      `${VOICE_URL_SCHEME}://auth/callback#token=`,
      `${VOICE_URL_SCHEME}://auth/callback?token=${CODE}`,
      callbackUrl("electron_authorization_code_1"),
      callbackUrl("%E0%A4%A"),
      "not a url",
    ]) {
      expect(parseCallbackUrl(url)).toBeNull();
    }
  });
});

describe("createAccount", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("signs in through the callback URL and keeps the token out of the snapshot", async () => {
    const h = harness();
    expect(h.state).toEqual({ kind: "signedOut" });
    await startSignIn(h);
    expect(h.requests).toHaveLength(1);
    h.account.handleCallbackUrl(callbackUrl(CODE));
    await flush();
    expect(h.exchanges.map((call) => call.code)).toEqual([CODE]);
    h.exchanges[0]?.resolve();
    await flush();
    expect(h.state).toEqual({ kind: "signedIn", ...USER });
    expect(h.states).toEqual([
      { kind: "signingIn", purpose: "signIn", phase: "browser" },
      { kind: "signingIn", purpose: "signIn", phase: "finishing" },
      { kind: "signedIn", ...USER },
    ]);
    expectNoSecrets(h);
  });

  test("signs in through a pasted code with surrounding whitespace", async () => {
    const h = harness();
    await startSignIn(h);
    const submitted = h.account.submitSignInCode(`  ${CODE}\n`);
    await flush();
    expect(h.exchanges[0]?.code).toBe(CODE);
    h.exchanges[0]?.resolve();
    await submitted;
    expect(h.state).toEqual({ kind: "signedIn", ...USER });
    expectNoSecrets(h);
  });

  test("a callback after cancel is ignored and never redeemed", async () => {
    const h = harness();
    await startSignIn(h);
    h.account.cancelSignIn();
    expect(h.state).toEqual({ kind: "signedOut" });
    h.account.handleCallbackUrl(callbackUrl(CODE));
    await h.account.submitSignInCode(CODE);
    await flush();
    expect(h.exchanges).toEqual([]);
    expect(h.state).toEqual({ kind: "signedOut" });
    await vi.advanceTimersByTimeAsync(SIGN_IN_TIMEOUT_MS);
    expect(h.states.filter((state) => state.kind === "signedOut")).toHaveLength(1);
    expectNoSecrets(h);
  });

  test("times out back to signed out and ignores a later callback", async () => {
    const h = harness();
    await startSignIn(h);
    await vi.advanceTimersByTimeAsync(SIGN_IN_TIMEOUT_MS - 1);
    expect(h.state).toEqual({ kind: "signingIn", purpose: "signIn", phase: "browser" });
    await vi.advanceTimersByTimeAsync(1);
    expect(h.state).toEqual({ kind: "signedOut" });
    expect(h.entries).toContainEqual({ message: "account sign-in timed out", level: "warn" });
    h.account.handleCallbackUrl(callbackUrl(CODE));
    await flush();
    expect(h.exchanges).toEqual([]);
    expect(h.state).toEqual({ kind: "signedOut" });
    expectNoSecrets(h);
  });

  test("cancel or timeout while the client is still loading never opens the browser", async () => {
    const endings = [
      (h: ReturnType<typeof harness>) => h.account.cancelSignIn(),
      () => vi.advanceTimersByTimeAsync(SIGN_IN_TIMEOUT_MS),
    ];
    for (const end of endings) {
      const h = harness();
      h.fake.setStored(true);
      let loaded!: (client: typeof h.fake.client) => void;
      h.createClient.mockImplementationOnce(
        () =>
          new Promise<typeof h.fake.client>((resolve) => {
            loaded = resolve;
          }),
      );
      const signIn = h.account.signIn();
      await flush();
      expect(h.state).toEqual({ kind: "signingIn" });
      await end(h);
      expect(h.state).toEqual({ kind: "signedOut" });
      loaded(h.fake.client);
      await flush();
      expect(h.fake.stored).toBe(true);
      expect(h.fake.forgotten).toBe(0);
      expect(h.fake.serverSignOuts).toBe(0);
      expect(h.requests).toEqual([]);
      await signIn;
      expect(h.state).toEqual({ kind: "signedOut" });
      expectNoSecrets(h);
    }
  });

  test("a callback on a launch with nothing pending says sign-in was interrupted", async () => {
    const h = harness();
    h.account.handleCallbackUrl(callbackUrl(CODE));
    await flush();
    expect(h.state).toEqual({ kind: "error", message: SIGN_IN_ERRORS.interrupted });
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.exchanges).toEqual([]);

    // Retry opens a new browser; the interrupted code belongs to the dead process's attempt.
    await startSignIn(h, "state2");
    expect(h.requests).toHaveLength(1);
    h.account.handleCallbackUrl(callbackUrl(CODE));
    await flush();
    expect(h.exchanges).toEqual([]);
    expect(h.state).toEqual({ kind: "signingIn", purpose: "signIn", phase: "browser" });
    h.account.handleCallbackUrl(callbackUrl(SECOND_CODE));
    await flush();
    h.exchanges[0]?.resolve();
    await flush();
    expect(h.state).toEqual({ kind: "signedIn", ...USER });
    expectNoSecrets(h);
  });

  test("the interrupted message dismisses to signed out until the next stale callback", () => {
    const h = harness();
    h.account.handleCallbackUrl(callbackUrl(CODE));
    h.account.dismissError();
    h.account.handleCallbackUrl(callbackUrl(CODE));
    expect(h.states).toEqual([
      { kind: "error", message: SIGN_IN_ERRORS.interrupted },
      { kind: "signedOut" },
      { kind: "error", message: SIGN_IN_ERRORS.interrupted },
    ]);
  });

  test("a late callback after a cancel in this process is not called interrupted", async () => {
    const h = harness();
    await startSignIn(h);
    h.account.cancelSignIn();
    h.account.handleCallbackUrl(callbackUrl(CODE));
    await flush();
    expect(h.states).toEqual([
      { kind: "signingIn", purpose: "signIn", phase: "browser" },
      { kind: "signedOut" },
    ]);
    expect(h.logs).toContain("account: callback ignored while signedOut");
  });

  test("malformed callbacks and pastes leave the attempt open", async () => {
    const h = harness();
    await startSignIn(h);
    for (const url of [
      `https://auth/callback#token=${CODE}`,
      `${VOICE_URL_SCHEME}://auth/other#token=${CODE}`,
      `${VOICE_URL_SCHEME}://auth/callback`,
      callbackUrl("electron_authorization_code_1"),
    ]) {
      h.account.handleCallbackUrl(url);
    }
    await expect(h.account.submitSignInCode("electron_authorization_code_1")).rejects.toThrow(
      PASTE_CODE_MESSAGE,
    );
    await flush();
    expect(h.exchanges).toEqual([]);
    expect(h.state).toEqual({ kind: "signingIn", purpose: "signIn", phase: "browser" });
    expect(h.logs.filter((line) => line === "account: malformed callback URL")).toHaveLength(4);
    expectNoSecrets(h);
  });

  test.each([
    ["offline", new TypeError("fetch failed")],
    ["rejected", Object.assign(new Error("NOT_FOUND"), { name: "BetterFetchError" })],
  ] as const)(
    "a %s exchange shows its own message, and Retry opens a new browser",
    async (kind, error) => {
      const h = harness();
      await startSignIn(h);
      h.account.handleCallbackUrl(callbackUrl(CODE));
      await flush();
      h.exchanges[0]?.fail(kind, error);
      await flush();
      expect(h.state).toEqual({ kind: "error", message: SIGN_IN_ERRORS[kind] });
      expect(h.entries).toContainEqual({
        message: "account sign-in failed",
        level: "warn",
        attributes: { "error.type": error.name, "account.failure": kind },
      });

      // The plugin spent the verifier on the failed exchange, so Retry must not redeem again.
      await startSignIn(h, "state2");
      expect(h.requests).toHaveLength(2);
      h.account.handleCallbackUrl(callbackUrl(CODE));
      await flush();
      expect(h.exchanges).toHaveLength(1);
      h.account.handleCallbackUrl(callbackUrl(SECOND_CODE));
      await flush();
      h.exchanges[1]?.resolve();
      await flush();
      expect(h.state).toEqual({ kind: "signedIn", ...USER });
      expect(h.createClient).toHaveBeenCalledOnce();
      expectNoSecrets(h);
    },
  );

  test("offline and rejected read differently, and an error dismisses to signed out", async () => {
    expect(SIGN_IN_ERRORS.offline).not.toBe(SIGN_IN_ERRORS.rejected);
    const h = harness();
    await startSignIn(h);
    h.account.handleCallbackUrl(callbackUrl(CODE));
    await flush();
    h.exchanges[0]?.fail("rejected", new Error("NOT_FOUND"));
    await flush();
    h.account.dismissError();
    expect(h.state).toEqual({ kind: "signedOut" });
  });

  test("a browser that cannot open lands in error", async () => {
    const h = harness();
    const signIn = h.account.signIn();
    await flush();
    h.requests[0]?.reject(new Error("no handler"));
    await signIn;
    expect(h.state).toEqual({ kind: "error", message: SIGN_IN_ERRORS.browser });
    expectNoSecrets(h);
  });

  test("a cancelled attempt's code never signs in during a newer attempt (the plugin keeps every verifier)", async () => {
    const h = harness();
    await startSignIn(h, "state1");
    h.account.cancelSignIn();
    await startSignIn(h, "state2");
    h.account.handleCallbackUrl(callbackUrl(CODE));
    await expect(h.account.submitSignInCode(CODE)).rejects.toThrow(STALE_CODE_MESSAGE);
    await flush();
    expect(h.exchanges).toEqual([]);
    expect(h.state).toEqual({ kind: "signingIn", purpose: "signIn", phase: "browser" });
    expect(
      h.logs.filter((line) => line === "account: code from another sign-in ignored"),
    ).toHaveLength(2);
    h.account.handleCallbackUrl(callbackUrl(SECOND_CODE));
    await flush();
    expect(h.exchanges.map((call) => call.code)).toEqual([SECOND_CODE]);
    h.exchanges[0]?.resolve();
    await flush();
    expect(h.state).toEqual({ kind: "signedIn", ...USER });
    expectNoSecrets(h);
  });

  test("a timed-out attempt's callback is ignored by the retry that followed it", async () => {
    const h = harness();
    await startSignIn(h, "state1");
    await vi.advanceTimersByTimeAsync(SIGN_IN_TIMEOUT_MS);
    expect(h.state).toEqual({ kind: "signedOut" });
    await startSignIn(h, "state2");
    h.account.handleCallbackUrl(callbackUrl(CODE));
    await flush();
    expect(h.exchanges).toEqual([]);
    expect(h.state).toEqual({ kind: "signingIn", purpose: "signIn", phase: "browser" });
    expectNoSecrets(h);
  });

  test("a code arriving before the browser opened is ignored, not redeemed against the wrong attempt", async () => {
    const h = harness();
    const signIn = h.account.signIn();
    await flush();
    h.account.handleCallbackUrl(callbackUrl(CODE));
    await flush();
    expect(h.exchanges).toEqual([]);
    h.requests[0]?.resolve("state1");
    await signIn;
    h.account.handleCallbackUrl(callbackUrl(CODE));
    await flush();
    expect(h.exchanges.map((call) => call.code)).toEqual([CODE]);
  });

  test("a paste and a callback for the same code redeem once and keep the first result", async () => {
    const h = harness();
    await startSignIn(h);
    h.account.handleCallbackUrl(callbackUrl(CODE));
    const pasted = h.account.submitSignInCode(CODE);
    await flush();
    expect(h.exchanges).toHaveLength(1);
    await pasted;
    expect(h.state).toEqual({ kind: "signingIn", purpose: "signIn", phase: "finishing" });
    h.exchanges[0]?.resolve();
    await flush();
    expect(h.state).toEqual({ kind: "signedIn", ...USER });
    expect(h.logs).toContain("account: code ignored while one is being redeemed");
    expectNoSecrets(h);
  });

  test.each(["cancel", "timeout"] as const)(
    "%s while a code is being redeemed abandons the exchange, so a late success persists nothing",
    async (ending) => {
      const h = harness();
      await startSignIn(h);
      const submitted = h.account.submitSignInCode(CODE);
      await flush();
      expect(h.exchanges[0]?.signal.aborted).toBe(false);
      if (ending === "cancel") h.account.cancelSignIn();
      else await vi.advanceTimersByTimeAsync(SIGN_IN_TIMEOUT_MS);
      expect(h.state).toEqual({ kind: "signedOut" });
      expect(h.exchanges[0]?.signal.aborted).toBe(true);
      h.exchanges[0]?.resolve();
      await submitted;
      expect(h.state).toEqual({ kind: "signedOut" });
      expect(h.fake.stored).toBe(false);
      expect(h.fake.client.cachedUser()).toBeNull();
      expect(h.entries.map((entry) => entry.message)).not.toContain("account sign-in failed");
      h.account.dispose();

      const relaunched = harness({ fake: h.fake });
      await relaunched.account.restore();
      await flush();
      expect(relaunched.state).toEqual({ kind: "signedOut" });
      expect(relaunched.states).toEqual([]);
      expect(relaunched.checks).toEqual([]);
      expectNoSecrets(h);
    },
  );

  test("a result from an older attempt is dropped", async () => {
    const h = harness();
    await startSignIn(h);
    h.account.handleCallbackUrl(callbackUrl(CODE));
    await flush();
    h.account.cancelSignIn();
    await startSignIn(h);
    h.exchanges[0]?.resolve();
    await flush();
    expect(h.state).toEqual({ kind: "signingIn", purpose: "signIn", phase: "browser" });
    h.account.handleCallbackUrl(callbackUrl(CODE));
    await flush();
    h.setUser({ name: "Second", email: "second@example.com" });
    h.exchanges[1]?.resolve();
    await flush();
    expect(h.state).toEqual({ kind: "signedIn", name: "Second", email: "second@example.com" });
    expectNoSecrets(h);
  });

  test("a build without an API URL is unavailable and never builds a client", async () => {
    const h = harness({ apiUrl: null });
    expect(h.state).toEqual({
      kind: "unavailable",
      reason: "Accounts are unavailable in this build.",
    });
    await h.account.signIn();
    h.account.handleCallbackUrl(callbackUrl(CODE));
    await h.account.submitSignInCode(CODE);
    h.account.cancelSignIn();
    h.account.dismissError();
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.states).toEqual([]);
    expectNoSecrets(h);
  });

  test("builds the client on the first sign-in only", async () => {
    const h = harness();
    expect(h.createClient).not.toHaveBeenCalled();
    await startSignIn(h);
    expect(h.createClient).toHaveBeenCalledWith(API_URL);
    h.account.cancelSignIn();
    await startSignIn(h);
    expect(h.createClient).toHaveBeenCalledOnce();
    expect(h.requests).toHaveLength(2);
  });

  test("a failed client build lands in error and is retried on the next sign-in", async () => {
    const h = harness();
    h.createClient.mockRejectedValueOnce(new Error("import failed"));
    await h.account.signIn();
    expect(h.state).toEqual({ kind: "error", message: SIGN_IN_ERRORS.browser });
    await startSignIn(h);
    expect(h.createClient).toHaveBeenCalledTimes(2);
  });

  test("sign-in while signing in or signed in does nothing", async () => {
    const h = harness();
    await startSignIn(h);
    await h.account.signIn();
    expect(h.requests).toHaveLength(1);
    h.account.handleCallbackUrl(callbackUrl(CODE));
    await flush();
    h.exchanges[0]?.resolve();
    await flush();
    await h.account.signIn();
    expect(h.requests).toHaveLength(1);
    expect(h.state).toEqual({ kind: "signedIn", ...USER });
  });

  test("dispose drops a pending attempt without a late result", async () => {
    const h = harness();
    await startSignIn(h);
    h.account.handleCallbackUrl(callbackUrl(CODE));
    await flush();
    h.account.dispose();
    h.exchanges[0]?.resolve();
    await vi.advanceTimersByTimeAsync(SIGN_IN_TIMEOUT_MS);
    expect(h.states).toEqual([
      { kind: "signingIn", purpose: "signIn", phase: "browser" },
      { kind: "signingIn", purpose: "signIn", phase: "finishing" },
    ]);
  });

  test("reports whether each callback changed the account", async () => {
    const h = harness();
    expect(h.account.handleCallbackUrl(callbackUrl("electron_authorization_code_1"))).toBe(
      "ignored",
    );
    expect(h.account.handleCallbackUrl(callbackUrl(CODE))).toBe("interrupted");
    h.account.dismissError();
    await startSignIn(h, "state2");
    expect(h.account.handleCallbackUrl(callbackUrl(CODE))).toBe("ignored");
    expect(h.account.handleCallbackUrl(callbackUrl(SECOND_CODE))).toBe("accepted");
    await flush();
    h.exchanges[0]?.resolve();
    await flush();
    expect(h.account.handleCallbackUrl(callbackUrl(SECOND_CODE))).toBe("ignored");
  });

  test("a callback during dictation shows Voice only after the session's outcome", async () => {
    const h = harness();
    const commands: HelperCommand[] = [];
    const dictation = createDictation({
      store: h.store,
      send: (command) => commands.push(command),
      cleanup: { loaded: () => true, clean: async (raw) => raw },
      onLevel: () => {},
      log: () => {},
      onSessionDone: () => {},
    });
    // The same wiring as index.ts: only a callback that changed the account shows the hub.
    const shownDuring: string[] = [];
    const showWhenIdle = whenNotDictating(h.store, () =>
      shownDuring.push(h.store.state.session.phase),
    );
    const takeCallback = (url: string) => {
      if (h.account.handleCallbackUrl(url) !== "ignored") showWhenIdle();
    };

    await startSignIn(h);
    h.account.cancelSignIn();
    takeCallback(callbackUrl(CODE));
    takeCallback(callbackUrl("electron_authorization_code_1"));
    expect(shownDuring).toEqual([]);

    await startSignIn(h, "state2");
    dictation.onHelperEvent({ type: "hotkey", action: "down" });
    const session = h.store.state.session;
    if (session.phase === "idle") throw new Error("no session");
    const id = session.id;
    dictation.onHelperEvent({ type: "capture.started", id, startMs: 40 });
    takeCallback(callbackUrl(SECOND_CODE));
    await flush();
    h.exchanges[0]?.resolve();
    await flush();
    expect(h.state).toEqual({ kind: "signedIn", ...USER });
    expect(shownDuring).toEqual([]);

    vi.advanceTimersByTime(800);
    dictation.onHelperEvent({ type: "hotkey", action: "up" });
    dictation.onHelperEvent({
      type: "transcript",
      id,
      text: "hello world",
      audioMs: 800,
      asrMs: 1,
    });
    await flush();
    expect(shownDuring).toEqual([]);
    dictation.onHelperEvent({ type: "insert.result", id, method: "accessibility", reason: null });
    expect(h.store.state.session).toEqual({
      phase: "done",
      id,
      outcome: { kind: "inserted", method: "accessibility" },
    });
    expect(commands.map((command) => command.type)).toEqual([
      "capture.start",
      "capture.stop",
      "insert",
    ]);
    expect(shownDuring).toEqual(["done"]);
  });

  test("an interrupted callback outside a session shows Voice at once", () => {
    const h = harness();
    const shown = vi.fn();
    const showWhenIdle = whenNotDictating(h.store, shown);
    if (h.account.handleCallbackUrl(callbackUrl(CODE)) !== "ignored") showWhenIdle();
    expect(shown).toHaveBeenCalledOnce();
    expect(h.state).toEqual({ kind: "error", message: SIGN_IN_ERRORS.interrupted });
  });

  test("sign-in never starts or resumes capture", async () => {
    const h = harness();
    const commands: HelperCommand[] = [];
    createDictation({
      store: h.store,
      send: (command) => commands.push(command),
      cleanup: { loaded: () => true, clean: async (raw) => raw },
      onLevel: () => {},
      log: () => {},
      onSessionDone: () => {},
    });

    h.account.handleCallbackUrl(callbackUrl(CODE));
    await startSignIn(h);
    h.account.cancelSignIn();
    await startSignIn(h);
    await vi.advanceTimersByTimeAsync(SIGN_IN_TIMEOUT_MS);
    await startSignIn(h);
    h.account.handleCallbackUrl(callbackUrl(CODE));
    await flush();
    h.exchanges[0]?.fail("offline", new TypeError("fetch failed"));
    await flush();
    await startSignIn(h, "state2");
    const pasted = h.account.submitSignInCode(SECOND_CODE);
    await flush();
    h.exchanges[1]?.resolve();
    await pasted;

    expect(h.states.map((state) => state.kind)).toEqual([
      "error",
      "signingIn",
      "signedOut",
      "signingIn",
      "signedOut",
      "signingIn",
      "signingIn",
      "error",
      "signingIn",
      "signingIn",
      "signedIn",
    ]);
    expect(commands).toEqual([]);
    expect(h.store.state.session).toBe(idle);
  });
});

describe("restore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("a launch without a stored auth session builds no client", async () => {
    const h = harness();
    await h.account.restore();
    await h.account.refresh();
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.states).toEqual([]);
  });

  test("a sign-in after a failed restore clears the stored auth session, so a quit reads as interrupted", async () => {
    const before = harness({ hasStoredAuthSession: withStoredAuthSession });
    before.fake.setCached(null);
    const restored = await restore(before);
    before.checks[0]?.answer({ kind: "unreachable", error: new TypeError("fetch failed") });
    await restored.done;
    expect(before.state).toEqual({ kind: "signedOut" });
    await startSignIn(before);
    expect(before.fake.forgotten).toBe(1);

    // Voice quits while signing in; the next launch sees what the sign-in left in storage.
    const after = harness({ hasStoredAuthSession: () => before.fake.forgotten === 0 });
    expect(after.account.handleCallbackUrl(callbackUrl(CODE))).toBe("interrupted");
    expect(after.state).toEqual({ kind: "error", message: SIGN_IN_ERRORS.interrupted });
  });

  test("a callback before restore leaves a stored auth session to restore", async () => {
    const h = harness({ hasStoredAuthSession: withStoredAuthSession });
    expect(h.account.handleCallbackUrl(callbackUrl(CODE))).toBe("ignored");
    await restore(h);
    expect(h.state).toEqual({ kind: "signedIn", ...USER });
  });

  test("signs in from the cached identity, then takes the API's answer", async () => {
    const h = harness({ hasStoredAuthSession: withStoredAuthSession });
    const restored = await restore(h);
    expect(h.createClient).toHaveBeenCalledWith(API_URL);
    expect(h.state).toEqual({ kind: "signedIn", ...USER });
    expect(h.checks).toHaveLength(1);
    h.checks[0]?.answer({ kind: "active", user: { name: "Ada King", email: USER.email } });
    await restored.done;
    expect(h.states).toEqual([
      { kind: "signedIn", ...USER },
      { kind: "signedIn", name: "Ada King", email: USER.email },
    ]);
    expectNoSecrets(h);
  });

  test("stays signed in with the cached identity while the API cannot answer", async () => {
    const h = harness({ hasStoredAuthSession: withStoredAuthSession });
    const restored = await restore(h);
    h.checks[0]?.answer({ kind: "unreachable", error: new TypeError("fetch failed") });
    await restored.done;
    expect(h.state).toEqual({ kind: "signedIn", ...USER });
    expect(h.entries).toContainEqual({
      message: "account auth session check failed",
      level: "warn",
      attributes: { "error.type": "TypeError" },
    });
    for (const status of [500, 503, 429]) {
      await vi.advanceTimersByTimeAsync(AUTH_SESSION_CHECK_INTERVAL_MS);
      const refreshed = await refresh(h);
      h.checks.at(-1)?.answer({ kind: "unknown", status });
      await refreshed.done;
      expect(h.state).toEqual({ kind: "signedIn", ...USER });
    }
    expect(h.entries).toContainEqual({
      message: "account auth session check failed",
      level: "warn",
      attributes: { "http.response.status_code": 503 },
    });
    expect(h.checks).toHaveLength(4);
    expect(h.fake.forgotten).toBe(0);
    expectNoSecrets(h);
  });

  test.each([401, 403, 200])(
    "an auth session the API reports ended (status %i) is deleted, explained, and dismissed to signed out",
    async (status) => {
      const h = harness({ hasStoredAuthSession: withStoredAuthSession });
      const restored = await restore(h);
      h.checks[0]?.answer({ kind: "ended", status });
      await restored.done;
      expect(h.state).toEqual({ kind: "error", message: AUTH_SESSION_ENDED_MESSAGE });
      expect(h.fake.forgotten).toBe(1);
      expect(h.entries).toContainEqual({
        message: "account auth session ended",
        level: "warn",
        attributes: { "http.response.status_code": status },
      });
      h.account.dismissError();
      expect(h.state).toEqual({ kind: "signedOut" });
      expectNoSecrets(h);
    },
  );

  test("checks again at most once an hour, when the window is shown", async () => {
    const h = harness({ hasStoredAuthSession: withStoredAuthSession });
    const restored = await restore(h);
    h.checks[0]?.answer({ kind: "active", user: USER });
    await restored.done;
    await vi.advanceTimersByTimeAsync(AUTH_SESSION_CHECK_INTERVAL_MS - 1);
    await h.account.refresh();
    expect(h.checks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const refreshed = await refresh(h);
    await h.account.refresh();
    expect(h.checks).toHaveLength(2);
    h.checks[1]?.answer({ kind: "ended", status: 401 });
    await refreshed.done;
    expect(h.state).toEqual({ kind: "error", message: AUTH_SESSION_ENDED_MESSAGE });
  });

  test("without a cached identity, the API's answer alone decides", async () => {
    const offline = harness({ hasStoredAuthSession: withStoredAuthSession });
    offline.fake.setCached(null);
    const unanswered = await restore(offline);
    expect(offline.state).toEqual({ kind: "signedOut" });
    offline.checks[0]?.answer({ kind: "unreachable", error: new TypeError("fetch failed") });
    await unanswered.done;
    expect(offline.states).toEqual([]);
    expect(offline.fake.forgotten).toBe(0);

    const online = harness({ hasStoredAuthSession: withStoredAuthSession });
    online.fake.setCached(null);
    const answered = await restore(online);
    online.checks[0]?.answer({ kind: "active", user: USER });
    await answered.done;
    expect(online.states).toEqual([{ kind: "signedIn", ...USER }]);
  });

  test("a show and an unminimize in the same moment send one check", async () => {
    const h = harness({ hasStoredAuthSession: withStoredAuthSession });
    const restored = await restore(h);
    h.checks[0]?.answer({ kind: "active", user: USER });
    await restored.done;
    await vi.advanceTimersByTimeAsync(AUTH_SESSION_CHECK_INTERVAL_MS);
    void h.account.refresh();
    void h.account.refresh();
    await flush();
    expect(h.checks).toHaveLength(2);
  });

  test("restores once per launch", async () => {
    const h = harness({ hasStoredAuthSession: withStoredAuthSession });
    const restored = await restore(h);
    h.checks[0]?.answer({ kind: "ended", status: 200 });
    await restored.done;
    h.account.dismissError();
    await h.account.restore();
    expect(h.createClient).toHaveBeenCalledOnce();
    expect(h.checks).toHaveLength(1);
  });

  test("a sign-in aborts a check still in flight, and its late answer is dropped", async () => {
    const h = harness({ hasStoredAuthSession: withStoredAuthSession });
    h.fake.setCached(null);
    const restored = await restore(h);
    expect(h.checks[0]?.signal.aborted).toBe(false);
    await startSignIn(h);
    expect(h.checks[0]?.signal.aborted).toBe(true);
    h.checks[0]?.answer({ kind: "active", user: USER });
    await restored.done;
    expect(h.state).toEqual({ kind: "signingIn", purpose: "signIn", phase: "browser" });
    expect(h.states.filter((state) => state.kind === "signedIn")).toEqual([]);
  });

  test("a sign-in forgets the stored auth session once, after aborting its check", async () => {
    const h = harness({ hasStoredAuthSession: withStoredAuthSession });
    h.fake.setCached(null);
    const restored = await restore(h);
    const signIn = h.account.signIn();
    expect(h.checks[0]?.signal.aborted).toBe(true);
    await flush();
    expect(h.fake.forgotten).toBe(1);
    h.checks[0]?.answer({ kind: "ended", status: 401 });
    await restored.done;
    h.requests[0]?.resolve();
    await signIn;
    expect(h.fake.forgotten).toBe(1);
    expect(h.states).toEqual([{ kind: "signingIn", purpose: "signIn", phase: "browser" }]);
  });

  test("quitting aborts a check still in flight", async () => {
    const h = harness({ hasStoredAuthSession: withStoredAuthSession });
    await restore(h);
    h.account.dispose();
    expect(h.checks[0]?.signal.aborted).toBe(true);
  });

  test("a sign-in started while the client loads wins over the restore", async () => {
    const h = harness({ hasStoredAuthSession: withStoredAuthSession });
    const restored = h.account.restore();
    void h.account.signIn();
    await restored;
    expect(h.state).toEqual({ kind: "signingIn", purpose: "signIn", phase: "browser" });
    expect(h.checks).toEqual([]);
    expect(h.createClient).toHaveBeenCalledOnce();
  });
});

describe("URL scheme", () => {
  test("electron-builder registers the scheme the account module expects", () => {
    const config = parse(
      readFileSync(NodePath.join(import.meta.dirname, "../../electron-builder.yml"), "utf8"),
    ) as { protocols: { schemes: string[] }[] };
    expect(config.protocols.flatMap((protocol) => protocol.schemes)).toEqual([VOICE_URL_SCHEME]);
  });
});
