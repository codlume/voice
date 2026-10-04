// Load the Electron mock before the adapter and plugin storage.
import {
  API,
  USER,
  GRACE,
  electron,
  http,
  log,
  json,
  signedIn,
  client,
  config,
  storedIdentity,
  signIn,
  signedInClient,
  snapshotAccount,
  signInCode,
} from "./account-client.test-harness.ts";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { storage } from "@better-auth/electron/storage";
import type { UpdateChannel } from "../shared/api.ts";
import { createVoiceAuthClient } from "./account-client.ts";
import {
  AUTH_SESSION_ENDED_MESSAGE,
  DELETE_ACCOUNT_FAILED_MESSAGE,
  DELETE_ACCOUNT_OFFLINE_MESSAGE,
  SIGN_IN_ERRORS,
} from "./account.ts";
import {
  authSessionStored,
  authStorageKeys,
  authStored,
  serverSignOutsStored,
} from "./account-storage.ts";

describe("createVoiceAuthClient", () => {
  test("stores the identity before a sign-in reports success, so an offline restart restores it", async () => {
    http.answer = (url) =>
      url.endsWith("/electron/token")
        ? signedIn("token-1")
        : Promise.reject(new TypeError("fetch failed"));
    expect(await signIn(client("nightly"))).toEqual({ kind: "signedIn", ...USER });
    expect(http.sent.map(({ url }) => new URL(url).pathname)).toEqual(["/api/auth/electron/token"]);

    expect(typeof storedIdentity("nightly")).toBe("string");
    expect(config()).not.toContain(USER.email);
    const restarted = client("nightly");
    expect(restarted.cachedUser()).toEqual(USER);
    expect(await restarted.checkAuthSession(new AbortController().signal)).toMatchObject({
      kind: "unreachable",
    });
    expect(client("nightly").cachedUser()).toEqual(USER);
  });

  test.each([
    [
      "a captive portal page",
      () => new Response("<html>Wi-Fi</html>", { headers: { "content-type": "text/html" } }),
    ],
    ["a 503", () => json({ error: "down" }, { status: 503 })],
    ["a JSON body without a user", () => json({ ok: true })],
  ])("%s never replaces the stored identity", async (_name, respond) => {
    http.answer = () => signedIn("token-1");
    await client("nightly").checkAuthSession(new AbortController().signal);
    const before = storedIdentity("nightly");

    http.answer = respond;
    expect(await client("nightly").checkAuthSession(new AbortController().signal)).toMatchObject({
      kind: "unknown",
    });
    expect(storedIdentity("nightly")).toBe(before);
    expect(client("nightly").cachedUser()).toEqual(USER);
  });

  test("an aborted check writes no cookie or identity, even when its answer comes later", async () => {
    const auth = await signedInClient();

    const revoked = Promise.withResolvers<Response>();
    http.answer = (url) =>
      url.endsWith("/get-session") ? revoked.promise : signedIn("new-token", GRACE);
    const check = new AbortController();
    const stale = auth.checkAuthSession(check.signal);
    await vi.waitFor(() => expect(http.sent).toHaveLength(2));
    // What the account module does when a sign-in starts during a check.
    check.abort();
    expect(await signIn(auth)).toEqual({ kind: "signedIn", ...GRACE });
    // The server ended the old auth session, and its late answer clears the cookie.
    revoked.resolve(
      json(null, { headers: { "set-cookie": "better-auth.session_token=; Max-Age=0; Path=/" } }),
    );
    expect(await stale).toMatchObject({ kind: "unreachable" });

    expect(client("nightly").cachedUser()).toEqual(GRACE);
    http.answer = () => signedIn("new-token", GRACE);
    expect(await client("nightly").checkAuthSession(new AbortController().signal)).toEqual({
      kind: "active",
      user: GRACE,
    });
    expect(http.sent.at(-1)?.cookie).toBe("better-auth.session_token=new-token");
  });

  test("keeps each channel's auth session for its own API", async () => {
    http.answer = (url) => (url.startsWith(API.stable) ? signedIn("stable-token") : json(null));
    const stable = client("stable");
    expect(await stable.checkAuthSession(new AbortController().signal)).toEqual({
      kind: "active",
      user: USER,
    });
    expect(authSessionStored(electron.state.userData, "stable")).toBe(true);
    expect(authSessionStored(electron.state.userData, "nightly")).toBe(false);

    expect(await client("nightly").checkAuthSession(new AbortController().signal)).toEqual({
      kind: "ended",
      status: 200,
    });
    await stable.checkAuthSession(new AbortController().signal);

    expect(http.sent.map(({ url, cookie }) => [new URL(url).origin, cookie])).toEqual([
      [API.stable, null],
      [API.nightly, null],
      [API.stable, "better-auth.session_token=stable-token"],
    ]);
  });

  test("restores the identity of the last answer from storage, and forget clears it", async () => {
    http.answer = () => signedIn("token-1");
    await client("nightly").checkAuthSession(new AbortController().signal);

    const restarted = client("nightly");
    expect(restarted.cachedUser()).toEqual(USER);
    restarted.forget();
    expect(restarted.cachedUser()).toBeNull();
    expect(authSessionStored(electron.state.userData, "nightly")).toBe(false);
    http.answer = () => json(null);
    await restarted.checkAuthSession(new AbortController().signal);
    expect(http.sent.at(-1)?.cookie).toBeNull();
  });

  test.each([
    ["a revoked auth session (200 null)", () => json(null), { kind: "ended", status: 200 }],
    ["401", () => json({ code: "UNAUTHORIZED" }, { status: 401 }), { kind: "ended", status: 401 }],
    ["403", () => json({ code: "FORBIDDEN" }, { status: 403 }), { kind: "ended", status: 403 }],
    ["503", () => json({}, { status: 503 }), { kind: "unknown", status: 503 }],
    [
      "a captive portal page",
      () =>
        new Response("<html>Sign in to Wi-Fi</html>", { headers: { "content-type": "text/html" } }),
      { kind: "unknown", status: 200 },
    ],
  ])("reads %s from get-session", async (_name, respond, expected) => {
    http.answer = respond;
    expect(await client("nightly").checkAuthSession(new AbortController().signal)).toEqual(
      expected,
    );
  });

  test("a failed fetch is unreachable, not ended", async () => {
    http.answer = () => Promise.reject(new TypeError("fetch failed"));
    expect(await client("nightly").checkAuthSession(new AbortController().signal)).toMatchObject({
      kind: "unreachable",
    });
  });

  test("without encryption and nothing in memory, it does not ask the API", async () => {
    electron.state.encryption = false;
    http.answer = () => json(null);
    expect(await client("nightly").checkAuthSession(new AbortController().signal)).toEqual({
      kind: "unknown",
      status: 0,
    });
    expect(http.sent).toEqual([]);
  });
});

async function storeSession(auxiliaryCookie = false) {
  http.answer = () => {
    const response = signedIn("expired-token");
    if (auxiliaryCookie) {
      response.headers.append("set-cookie", "better-auth.auxiliary=fixture; Max-Age=7200; Path=/");
    }
    return response;
  };
  const active = client("nightly");
  expect(await signIn(active)).toEqual({ kind: "signedIn", ...USER });
  return active;
}

async function restoreExpiredSession() {
  vi.setSystemTime(new Date("2026-01-01T01:00:01Z"));
  http.sent = [];
  http.answer = (url) => (url.endsWith("/sign-out") ? json({ success: true }) : json(null));
  const restarted = client("nightly");
  const h = snapshotAccount(restarted);
  await h.account.restore();
  await restarted.endServerSignOuts();
  return h;
}

describe("stored auth expiry through the account snapshot", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const keys = authStorageKeys("nightly");
  const expiredCookie = "better-auth.session_token=expired-token";
  const oldCookie = "better-auth.session_token=old-token";

  test.each([false, true])(
    "explains expiry and clears stored auth before Dismiss, with an unrelated queue=%s",
    async (unrelatedQueue) => {
      const active = await storeSession();
      if (unrelatedQueue) active.queueServerSignOut(oldCookie);

      const h = await restoreExpiredSession();

      expect(h.state).toEqual({ kind: "error", message: AUTH_SESSION_ENDED_MESSAGE });
      expect(storage().getItem(keys.cookie)).toBeNull();
      expect(storage().getItem(keys.identity)).toBeNull();
      expect(http.sent.filter(({ cookie }) => cookie === null)).toEqual([
        { url: `${API.nightly}/api/auth/get-session`, cookie: null, body: "" },
      ]);
      h.account.dismissError();
      expect(h.state).toEqual({ kind: "signedOut" });
    },
  );

  test.each([false, true])(
    "retires a crash-queued expired session silently, with a surviving auxiliary cookie=%s",
    async (auxiliaryCookie) => {
      const active = await storeSession(auxiliaryCookie);
      active.queueServerSignOut(expiredCookie);

      const h = await restoreExpiredSession();

      expect(h.state).toEqual({ kind: "signedOut" });
      expect(h.states).toEqual([]);
      expect(storage().getItem(keys.cookie)).toBeNull();
      expect(storage().getItem(keys.identity)).toBeNull();
      expect(http.sent).toEqual([
        { url: `${API.nightly}/api/auth/sign-out`, cookie: expiredCookie, body: "{}" },
        { url: `${API.nightly}/api/auth/get-session`, cookie: expiredCookie, body: "" },
      ]);
    },
  );

  test("unavailable encryption preserves stored auth without a request or expiry error", async () => {
    const active = await storeSession();
    active.queueServerSignOut(oldCookie);
    const before = config();
    electron.state.encryption = false;

    const h = await restoreExpiredSession();

    expect(h.state).toEqual({ kind: "signedOut" });
    expect(h.states).toEqual([]);
    expect(http.sent).toEqual([]);
    expect(config()).toBe(before);
  });
});

// What the plugin's storage holds for a signed-in channel: safeStorage ciphertext, base64.
const storeCookie = (channel: UpdateChannel, value: string | null = "Y2lwaGVydGV4dA==") =>
  storage().setItem(authStorageKeys(channel).cookie, value);

describe("authSessionStored", () => {
  test("is read from the plugin's Conf store under the installed channel only", () => {
    const { userData } = electron.state;
    expect(authSessionStored(userData, "stable")).toBe(false);
    storeCookie("stable");
    expect(authSessionStored(userData, "stable")).toBe(true);
    expect(authSessionStored(userData, "nightly")).toBe(false);
    storeCookie("nightly");
    expect(authSessionStored(userData, "nightly")).toBe(true);
    // A renamed prefix would sign every user out on update.
    expect(JSON.parse(config())).toEqual({
      voice: { stable: { cookie: "Y2lwaGVydGV4dA==" }, nightly: { cookie: "Y2lwaGVydGV4dA==" } },
    });
  });

  test("a cleared or unreadable store counts as no auth session", () => {
    const { userData } = electron.state;
    storeCookie("nightly", null);
    expect(authSessionStored(userData, "nightly")).toBe(false);
    rmSync(NodePath.join(userData, "config.json"));
    expect(authSessionStored(userData, "nightly")).toBe(false);
  });
});

const confirmed = (url: string) =>
  url.endsWith("/sign-out") ? json({ success: true }) : json(null);

describe("server sign-outs", () => {
  test.each(["garbage ciphertext", JSON.stringify({ cookie: "wrong shape" }), "[123]"])(
    "discards an unreadable queue once and still constructs the client (%s)",
    async (garbage) => {
      storage().setItem(
        authStorageKeys("nightly").serverSignOuts,
        garbage === "garbage ciphertext"
          ? garbage
          : electron.api.safeStorage.encryptString(garbage).toString("base64"),
      );
      const restarted = client("nightly");
      expect(await restarted.endServerSignOuts()).toEqual([]);
      expect(serverSignOutsStored(electron.state.userData, "nightly")).toBe(false);
      expect(log).toHaveBeenCalledExactlyOnceWith("account server sign-out queue discarded", {
        message: "account server sign-out queue discarded",
        level: "warn",
      });
      expect(await client("nightly").endServerSignOuts()).toEqual([]);
      expect(log).toHaveBeenCalledOnce();
    },
  );

  test("a Keychain decrypt failure drops the queue and allows a later sign-in", async () => {
    const active = await signedInClient();
    active.retireAuthSession();
    const decrypt = vi.spyOn(electron.api.safeStorage, "decryptString").mockImplementation(() => {
      throw new Error("Keychain reset");
    });
    const restarted = client("nightly");
    decrypt.mockRestore();
    expect(await restarted.endServerSignOuts()).toEqual([]);
    expect(log).toHaveBeenCalledOnce();
    http.answer = () => signedIn("replacement-token", GRACE);
    expect(await signIn(restarted)).toEqual({ kind: "signedIn", ...GRACE });
    expect(restarted.hasAuthSession()).toBe(true);
    expect(restarted.cachedUser()).toEqual(GRACE);
  });

  test("queues an old cookie once without touching a newer active cookie or identity", async () => {
    http.answer = () => signedIn("new-token", GRACE);
    const active = client("nightly");
    await active.checkAuthSession(new AbortController().signal);
    const keys = authStorageKeys("nightly");
    const activeCookie = storage().getItem(keys.cookie);
    const identity = storage().getItem(keys.identity);
    active.queueServerSignOut("better-auth.session_token=old-token");
    active.queueServerSignOut("better-auth.session_token=old-token");
    expect(storage().getItem(keys.cookie)).toBe(activeCookie);
    expect(storage().getItem(keys.identity)).toBe(identity);
    http.answer = confirmed;
    expect(await active.endServerSignOuts()).toEqual([{ kind: "ended", status: 200 }]);
    expect(
      http.sent.filter(({ url }) => url.endsWith("/sign-out")).map(({ cookie }) => cookie),
    ).toEqual(["better-auth.session_token=old-token"]);
    expect(active.hasAuthSession()).toBe(true);
    expect(active.cachedUser()).toEqual(GRACE);
    expect(storage().getItem(keys.cookie)).toBe(activeCookie);
    expect(storage().getItem(keys.identity)).toBe(identity);
  });

  test("the launch probe includes queued work without counting it as active auth", () => {
    const { userData } = electron.state;
    storage().setItem(authStorageKeys("stable").serverSignOuts, "Y2lwaGVydGV4dA==");
    expect(authStored(userData, "stable")).toBe(true);
    expect(authStored(userData, "nightly")).toBe(false);
    expect(authSessionStored(userData, "stable")).toBe(false);
    expect(serverSignOutsStored(userData, "stable")).toBe(true);
    expect(new Set(Object.values(authStorageKeys("stable"))).size).toBe(3);
  });

  test("clears active auth at once and stores only encrypted retry cookies", async () => {
    const active = await signedInClient();
    active.retireAuthSession();
    expect(authSessionStored(electron.state.userData, "nightly")).toBe(false);
    expect(active.cachedUser()).toBeNull();
    expect(serverSignOutsStored(electron.state.userData, "nightly")).toBe(true);
    expect(config()).not.toContain("old-token");
    http.answer = confirmed;
    expect(await active.endServerSignOuts()).toEqual([{ kind: "ended", status: 200 }]);
    expect(http.sent.slice(-2).map(({ url, cookie }) => [url, cookie])).toEqual([
      [`${API.nightly}/api/auth/sign-out`, "better-auth.session_token=old-token"],
      [`${API.nightly}/api/auth/get-session`, "better-auth.session_token=old-token"],
    ]);
    expect(serverSignOutsStored(electron.state.userData, "nightly")).toBe(false);
  });

  test.each(["offline", "503"])(
    "retains %s sign-outs for a later launch and removes them only after confirmation",
    async (failure) => {
      const active = await signedInClient();
      active.retireAuthSession();
      http.answer =
        failure === "offline"
          ? () => Promise.reject(new TypeError("fetch failed"))
          : () => json({}, { status: 503 });
      expect((await active.endServerSignOuts())[0]?.kind).toBe(
        failure === "offline" ? "unreachable" : "unknown",
      );
      expect(serverSignOutsStored(electron.state.userData, "nightly")).toBe(true);
      const restarted = client("nightly");
      expect(restarted.cachedUser()).toBeNull();
      http.answer = confirmed;
      expect(await restarted.endServerSignOuts()).toEqual([{ kind: "ended", status: 200 }]);
      expect(serverSignOutsStored(electron.state.userData, "nightly")).toBe(false);
      expect(authSessionStored(electron.state.userData, "nightly")).toBe(false);
    },
  );

  test.each(["active", "HTML", "malformed JSON", "403"])(
    "retains the retry after %s rather than trusting POST success",
    async (failure) => {
      const active = await signedInClient();
      active.retireAuthSession();
      http.answer = (url) => {
        if (failure === "403") return json({ code: "INVALID_ORIGIN" }, { status: 403 });
        if (failure === "HTML") return new Response("<html>Sign in to Wi-Fi</html>");
        if (failure === "malformed JSON") return new Response("{");
        return url.endsWith("/sign-out") ? json({ success: true }) : signedIn("old-token");
      };
      expect((await active.endServerSignOuts())[0]?.kind).not.toBe("ended");
      expect(serverSignOutsStored(electron.state.userData, "nightly")).toBe(true);
      expect(authSessionStored(electron.state.userData, "nightly")).toBe(false);
    },
  );

  test("a late get-session cannot write an old cookie or identity back after retirement", async () => {
    const active = await signedInClient();
    const pending = Promise.withResolvers<Response>();
    http.answer = () => pending.promise;
    const oldCheck = active.checkAuthSession(new AbortController().signal);
    await vi.waitFor(() => expect(http.sent).toHaveLength(2));
    active.retireAuthSession();
    http.answer = () => signedIn("new-token", GRACE);
    await active.checkAuthSession(new AbortController().signal);
    pending.resolve(signedIn("old-token"));
    await oldCheck;
    http.answer = confirmed;
    await active.endServerSignOuts();
    expect(active.cachedUser()).toEqual(GRACE);
    expect(authSessionStored(electron.state.userData, "nightly")).toBe(true);
    http.answer = () => json(null);
    await active.checkAuthSession(new AbortController().signal);
    expect(http.sent.at(-1)?.cookie).toBe("better-auth.session_token=new-token");
  });

  test("an aborted check cannot restore a cookie or identity after sign-out", async () => {
    const active = await signedInClient();
    const pending = Promise.withResolvers<Response>();
    http.answer = () => pending.promise;
    const controller = new AbortController();
    const checking = active.checkAuthSession(controller.signal);
    await vi.waitFor(() => expect(http.sent).toHaveLength(2));
    controller.abort();
    active.retireAuthSession();
    pending.resolve(signedIn("old-token", GRACE));
    expect(await checking).toMatchObject({ kind: "unreachable" });
    expect(active.hasAuthSession()).toBe(false);
    expect(active.cachedUser()).toBeNull();
    expect(client("nightly").hasAuthSession()).toBe(false);
    expect(client("nightly").cachedUser()).toBeNull();
    expect(storage().getItem(authStorageKeys("nightly").cookie)).toBeNull();
    expect(storage().getItem(authStorageKeys("nightly").identity)).toBeNull();
  });

  test("a response already read cannot write either key after retirement", async () => {
    const active = await signedInClient();
    const response = signedIn("refreshed-old-token", GRACE);
    const getHeader = response.headers.get.bind(response.headers);
    let retired = false;
    vi.spyOn(response.headers, "get").mockImplementation((name) => {
      if (name.toLowerCase() === "set-cookie" && !retired) {
        retired = true;
        active.retireAuthSession();
      }
      return getHeader(name);
    });
    http.answer = () => response;
    await active.checkAuthSession(new AbortController().signal);
    expect(retired).toBe(true);
    expect(active.hasAuthSession()).toBe(false);
    expect(active.cachedUser()).toBeNull();
    expect(storage().getItem(authStorageKeys("nightly").cookie)).toBeNull();
    expect(storage().getItem(authStorageKeys("nightly").identity)).toBeNull();
  });

  test("keeps multiple offline sign-outs and does not send them to another channel", async () => {
    const active = await signedInClient("token-a");
    active.retireAuthSession();
    http.answer = () => signedIn("token-b");
    await active.checkAuthSession(new AbortController().signal);
    active.retireAuthSession();
    http.answer = confirmed;
    expect(await client("stable").endServerSignOuts()).toEqual([]);
    const restarted = client("nightly");
    expect(await restarted.endServerSignOuts()).toEqual([
      { kind: "ended", status: 200 },
      { kind: "ended", status: 200 },
    ]);
    expect(http.sent.slice(-4).map(({ cookie }) => cookie)).toEqual([
      "better-auth.session_token=token-a",
      "better-auth.session_token=token-a",
      "better-auth.session_token=token-b",
      "better-auth.session_token=token-b",
    ]);
    expect(serverSignOutsStored(electron.state.userData, "nightly")).toBe(false);
  });

  test("drains a sign-out added while another is in flight without overlapping retries", async () => {
    const active = await signedInClient("token-a");
    active.retireAuthSession();
    const pending = Promise.withResolvers<Response>();
    http.answer = () => pending.promise;
    const first = active.endServerSignOuts();
    await vi.waitFor(() => expect(http.sent.at(-1)?.url).toContain("/sign-out"));
    http.answer = () => signedIn("token-b");
    await active.checkAuthSession(new AbortController().signal);
    active.retireAuthSession();
    expect(active.endServerSignOuts()).toBe(first);
    http.answer = confirmed;
    pending.resolve(json({ success: true }));
    expect(await first).toEqual([
      { kind: "ended", status: 200 },
      { kind: "ended", status: 200 },
    ]);
    expect(serverSignOutsStored(electron.state.userData, "nightly")).toBe(false);
    expect(
      http.sent.filter(({ url }) => url.endsWith("/sign-out")).map(({ cookie }) => cookie),
    ).toEqual(["better-auth.session_token=token-a", "better-auth.session_token=token-b"]);
  });

  test("unavailable encryption never overwrites an existing encrypted retry queue", async () => {
    const active = await signedInClient();
    active.retireAuthSession();
    const encrypted = storage().getItem("voice.nightly.retired_auth_sessions");
    electron.state.encryption = false;
    expect(await client("nightly").endServerSignOuts()).toEqual([]);
    expect(storage().getItem("voice.nightly.retired_auth_sessions")).toBe(encrypted);
    electron.state.encryption = true;
    http.answer = confirmed;
    expect(await client("nightly").endServerSignOuts()).toEqual([{ kind: "ended", status: 200 }]);
  });

  test("reconciles a crash after enqueueing, leaving a newer active cookie alone", async () => {
    await signedInClient();
    storage().setItem(
      "voice.nightly.retired_auth_sessions",
      electron.api.safeStorage
        .encryptString(JSON.stringify(["better-auth.session_token=old-token"]))
        .toString("base64"),
    );
    const restarted = client("nightly");
    expect(authSessionStored(electron.state.userData, "nightly")).toBe(false);
    expect(restarted.cachedUser()).toBeNull();
    http.answer = () => signedIn("new-token");
    await restarted.checkAuthSession(new AbortController().signal);
    expect(client("nightly").cachedUser()).toEqual(USER);
    expect(authSessionStored(electron.state.userData, "nightly")).toBe(true);
  });

  test("with no encryption, clears private plugin memory and never persists a retry token", async () => {
    electron.state.encryption = false;
    const active = client("nightly");
    const { state } = await active.openBrowser();
    http.answer = () => signedIn("memory-token");
    const code = Buffer.from(JSON.stringify({ identifier: "test-code", state })).toString(
      "base64url",
    );
    expect(await active.redeem(code, new AbortController().signal)).toMatchObject({
      kind: "signedIn",
    });
    active.retireAuthSession();
    expect(authSessionStored(electron.state.userData, "nightly")).toBe(false);
    expect(await active.checkAuthSession(new AbortController().signal)).toEqual({
      kind: "unknown",
      status: 0,
    });
    expect(config()).not.toContain("memory-token");
    expect(serverSignOutsStored(electron.state.userData, "nightly")).toBe(false);
    http.answer = confirmed;
    expect(await active.endServerSignOuts()).toEqual([{ kind: "ended", status: 200 }]);
    expect(http.sent.at(-1)?.cookie).toBe("better-auth.session_token=memory-token");
  });
});

describe("deletion through the real auth client", () => {
  test.each(["503", "offline", "invalid success"])(
    "%s keeps the local credential",
    async (failure) => {
      const auth = await signedInClient("kept-token");
      http.answer = () => {
        if (failure === "offline") throw new TypeError("fetch failed");
        return failure === "503" ? json({}, { status: 503 }) : json({ success: false });
      };
      const result = await auth.deleteAccount();
      expect(result.kind).toBe(failure === "offline" ? "offline" : "failed");
      expect(authSessionStored(electron.state.userData, "nightly")).toBe(true);
      expect(auth.cachedUser()).toEqual(USER);
      http.answer = () => json({ session: { token: "kept-token" }, user: USER });
      await auth.checkAuthSession(new AbortController().signal);
      expect(http.sent.at(-1)?.cookie).toBe("better-auth.session_token=kept-token");
    },
  );

  test("only the freshness refusal asks for re-authentication and captures the older credential", async () => {
    const auth = await signedInClient();
    const before = http.sent.length;
    http.answer = (url) => {
      if (url.endsWith("/delete-user")) return json({ code: "SESSION_EXPIRED" }, { status: 400 });
      throw new TypeError("get-session is unavailable");
    };
    const result = await auth.deleteAccount();
    expect(result.kind).toBe("reauthRequired");
    expect(http.sent.slice(before).map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/auth/delete-user",
    ]);
    expect(authSessionStored(electron.state.userData, "nightly")).toBe(true);
    expect(serverSignOutsStored(electron.state.userData, "nightly")).toBe(false);
    http.answer = () => signedIn("new-token");
    await auth.checkAuthSession(new AbortController().signal);
    http.answer = () => json({}, { status: 503 });
    await expect(auth.revokeOlderAuthSession()).rejects.toThrow("Auth session revocation failed.");
    expect(http.sent.at(-1)?.cookie).toBe("better-auth.session_token=old-token");
    expect(serverSignOutsStored(electron.state.userData, "nightly")).toBe(true);
    http.answer = (url) =>
      url.endsWith("/sign-out")
        ? json(
            { success: true },
            { headers: { "set-cookie": "better-auth.session_token=; Max-Age=0; Path=/" } },
          )
        : json(null);
    await auth.revokeOlderAuthSession();
    expect(serverSignOutsStored(electron.state.userData, "nightly")).toBe(false);
    expect(http.sent.slice(-2)).toEqual([
      {
        url: `${API.nightly}/api/auth/sign-out`,
        cookie: "better-auth.session_token=old-token",
        body: "{}",
      },
      {
        url: `${API.nightly}/api/auth/get-session`,
        cookie: "better-auth.session_token=old-token",
        body: "",
      },
    ]);
    http.answer = () => json({ session: { token: "new-token" }, user: USER });
    await auth.checkAuthSession(new AbortController().signal);
    expect(http.sent.at(-1)?.cookie).toBe("better-auth.session_token=new-token");
    expect(authSessionStored(electron.state.userData, "nightly")).toBe(true);
  });

  test.each(["cancel", "quit", "delete"] as const)(
    "%s after failed revocation drains the encrypted old credential on launch without restoring it",
    async (action) => {
      let refuseSignOut = true;
      const liveSessions = new Set(["better-auth.session_token=old-token"]);
      const oldCookie = "better-auth.session_token=old-token";
      const newCookie = "better-auth.session_token=new-token";
      const auth = await signedInClient();
      http.answer = (url) => {
        const cookie = http.sent.at(-1)?.cookie;
        if (url.endsWith("/electron/token")) {
          liveSessions.add(newCookie);
          return signedIn("new-token");
        }
        if (url.endsWith("/delete-user")) {
          if (cookie === oldCookie) return json({ code: "SESSION_EXPIRED" }, { status: 400 });
          liveSessions.clear();
          return json({ success: true, message: "User deleted" });
        }
        if (url.endsWith("/sign-out")) {
          if (refuseSignOut) return json({}, { status: 503 });
          liveSessions.delete(cookie ?? "");
          return json({ success: true });
        }
        if (url.endsWith("/get-session"))
          return cookie && liveSessions.has(cookie)
            ? json({
                session: { token: cookie === oldCookie ? "old-token" : "new-token" },
                user: USER,
              })
            : json(null);
        throw new Error("Unexpected auth endpoint");
      };
      const h = snapshotAccount(auth);
      await h.account.restore();
      h.account.requestDeletion();
      await h.account.confirmDeletion();
      const code = await signInCode(h, auth);
      await h.account.submitSignInCode(code);
      expect(h.state).toMatchObject({
        kind: "signedIn",
        ...USER,
        deletion: { kind: "revocationFailed" },
      });
      expect(liveSessions).toEqual(new Set([oldCookie, newCookie]));
      expect(serverSignOutsStored(electron.state.userData, "nightly")).toBe(true);
      expect(config()).not.toContain("old-token");
      expect(config()).not.toContain("new-token");
      if (action !== "quit") {
        h.account.cancelDeletion();
        expect(h.state).toEqual({ kind: "signedIn", ...USER });
        if (action === "delete") {
          h.account.requestDeletion();
          await h.account.confirmDeletion();
          expect(h.state).toEqual({ kind: "signedOut" });
          expect(liveSessions.size).toBe(0);
        }
      }
      h.account.dispose();
      refuseSignOut = false;
      const relaunched = snapshotAccount(client("nightly"));
      await relaunched.account.restore();
      await vi.waitFor(() =>
        expect(serverSignOutsStored(electron.state.userData, "nightly")).toBe(false),
      );
      expect(http.sent.filter(({ url }) => url.endsWith("/sign-out"))).toEqual([
        { url: `${API.nightly}/api/auth/sign-out`, cookie: oldCookie, body: "{}" },
        { url: `${API.nightly}/api/auth/sign-out`, cookie: oldCookie, body: "{}" },
      ]);
      if (action === "delete") {
        expect(relaunched.state).toEqual({ kind: "signedOut" });
        expect(relaunched.states).toEqual([]);
        expect(authSessionStored(electron.state.userData, "nightly")).toBe(false);
        expect(liveSessions.size).toBe(0);
      } else {
        expect(relaunched.state).toEqual({ kind: "signedIn", ...USER });
        expect(relaunched.states).toEqual([{ kind: "signedIn", ...USER }]);
        expect(liveSessions).toEqual(new Set([newCookie]));
        expect(authSessionStored(electron.state.userData, "nightly")).toBe(true);
      }
    },
  );

  test.each([true, false])(
    "a changed account id cancels deletion and keeps the new auth session (old sign-out succeeds: %s)",
    async (endsOld) => {
      const auth = await signedInClient();
      const h = snapshotAccount(auth);
      await h.account.restore();
      http.answer = (url) =>
        url.endsWith("/get-session")
          ? json({ user: USER, session: { token: "old-token" } })
          : json({ code: "SESSION_EXPIRED" }, { status: 400 });
      h.account.requestDeletion();
      await h.account.confirmDeletion();
      const code = await signInCode(h, auth);
      http.answer = (url) => {
        if (url.endsWith("/electron/token")) return signedIn("grace-token", GRACE);
        if (url.endsWith("/sign-out"))
          return endsOld ? json({ success: true }) : json({}, { status: 503 });
        if (url.endsWith("/get-session")) return json(null);
        throw new Error("Unexpected deletion after changing accounts");
      };
      await h.account.submitSignInCode(code);
      expect(h.state).toEqual({
        kind: "signedIn",
        ...GRACE,
        notice: `You signed in as ${GRACE.email}, so Voice did not delete ${USER.email}.`,
      });
      await h.account.confirmDeletion();
      await h.account.retryDeletion();
      expect(http.sent.filter(({ url }) => url.endsWith("/delete-user"))).toHaveLength(1);
      expect(http.sent.filter(({ url }) => url.endsWith("/sign-out"))).toEqual([
        {
          url: `${API.nightly}/api/auth/sign-out`,
          cookie: "better-auth.session_token=old-token",
          body: "{}",
        },
      ]);
      expect(serverSignOutsStored(electron.state.userData, "nightly")).toBe(!endsOld);
      expect(auth.cachedUser()).toEqual(GRACE);
      http.answer = () => json({ user: GRACE, session: { token: "grace-token" } });
      expect(await auth.checkAuthSession(new AbortController().signal)).toEqual({
        kind: "active",
        user: GRACE,
      });
      expect(http.sent.at(-1)?.cookie).toBe("better-auth.session_token=grace-token");
    },
  );

  test.each(["delete", "reauth", "signIn"] as const)(
    "a stalled %s body reaches a retryable error when its deadline aborts",
    async (phase) => {
      if (phase !== "signIn") await signedInClient();
      const stalledPath = phase === "delete" ? "/api/auth/delete-user" : "/api/auth/electron/token";
      const receivedHeaders = Promise.withResolvers<void>();
      const server = createServer((request, response) => {
        request.resume();
        response.setHeader("content-type", "application/json");
        if (request.url === stalledPath) {
          response.writeHead(200);
          response.write('{"user":');
        } else if (request.url === "/api/auth/delete-user") {
          response.writeHead(400);
          response.end(JSON.stringify({ code: "SESSION_EXPIRED" }));
        } else {
          response.end(JSON.stringify({ user: USER, session: { token: "old-token" } }));
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing test server port");
        vi.unstubAllGlobals();
        const realFetch = globalThis.fetch;
        vi.stubGlobal("fetch", async (input: Request | string | URL, init?: RequestInit) => {
          const response = await realFetch(input, init);
          if (new URL(response.url).pathname === stalledPath) receivedHeaders.resolve();
          return response;
        });
        const auth = createVoiceAuthClient({
          apiUrl: `http://127.0.0.1:${address.port}`,
          installedChannel: "nightly",
          log,
        });
        const h = snapshotAccount(auth);
        if (phase !== "signIn") await h.account.restore();
        if (phase === "reauth") {
          h.account.requestDeletion();
          await h.account.confirmDeletion();
        }
        const deadline = new AbortController();
        const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
        let done: Promise<void>;
        if (phase === "delete") {
          h.account.requestDeletion();
          done = h.account.confirmDeletion();
        } else {
          done = h.account.submitSignInCode(await signInCode(h, auth));
        }
        await receivedHeaders.promise;
        expect(timeout).toHaveBeenLastCalledWith(30_000);
        expect(h.state).toMatchObject(
          phase === "delete"
            ? { kind: "signedIn", deletion: { kind: "deleting" } }
            : { kind: "signingIn", phase: "finishing" },
        );
        deadline.abort(new DOMException("Request timed out", "TimeoutError"));
        await done;
        timeout.mockRestore();
        if (phase === "delete") {
          expect(h.state).toEqual({
            kind: "signedIn",
            ...USER,
            deletion: { kind: "failed", message: DELETE_ACCOUNT_FAILED_MESSAGE },
          });
          await h.account.retryDeletion();
          expect(h.state).toEqual({ kind: "signedIn", ...USER, deletion: { kind: "confirming" } });
        } else {
          expect(h.state).toEqual(
            phase === "reauth"
              ? {
                  kind: "signedIn",
                  ...USER,
                  deletion: { kind: "reauthFailed", message: SIGN_IN_ERRORS.rejected },
                }
              : { kind: "error", message: SIGN_IN_ERRORS.rejected },
          );
          await h.account.signIn();
          expect(h.state).toEqual({
            kind: "signingIn",
            purpose: phase === "reauth" ? "deleteAccount" : "signIn",
            phase: "browser",
          });
        }
        if (phase !== "signIn") {
          expect(auth.cachedUser()).toEqual(USER);
          expect(authSessionStored(electron.state.userData, "nightly")).toBe(true);
        }
        h.account.dispose();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );

  test("an unauthorized deletion is a failure, never a deleted account", async () => {
    http.answer = () => json({ code: "UNAUTHORIZED" }, { status: 401 });
    expect(await client("nightly").deleteAccount()).toEqual({ kind: "failed" });
  });

  test("a successful deletion is reported only with the server's deletion receipt", async () => {
    http.answer = () => json({ success: true, message: "User deleted" });
    expect(await client("nightly").deleteAccount()).toEqual({ kind: "deleted" });
    http.answer = () => json({ success: true, message: "Verification email http.sent" });
    expect(await client("nightly").deleteAccount()).toEqual({ kind: "failed" });
  });

  test("an auth session revoked before confirmation ends the sign-in instead of trapping the deletion", async () => {
    const auth = await signedInClient();
    const h = snapshotAccount(auth);
    await h.account.restore();
    expect(h.state).toEqual({ kind: "signedIn", ...USER });
    http.answer = (url) => {
      if (url.endsWith("/get-session")) return json({ code: "UNAUTHORIZED" }, { status: 401 });
      throw new Error(`Unexpected ${new URL(url).pathname} after the auth session ended`);
    };
    h.account.requestDeletion();
    await h.account.confirmDeletion();
    expect(http.sent.filter(({ url }) => url.endsWith("/delete-user"))).toEqual([]);
    expect(h.state).toEqual({ kind: "error", message: AUTH_SESSION_ENDED_MESSAGE });
    expect(authSessionStored(electron.state.userData, "nightly")).toBe(false);
    expect(auth.cachedUser()).toBeNull();
    await h.account.signIn();
    expect(h.state).toEqual({ kind: "signingIn", purpose: "signIn", phase: "browser" });
    h.account.dispose();
  });

  test("a deletion whose receipt was lost ends the sign-in on retry and never claims the deletion", async () => {
    const auth = await signedInClient();
    const h = snapshotAccount(auth);
    await h.account.restore();
    let deleted = false;
    http.answer = (url) => {
      if (url.endsWith("/get-session")) {
        return deleted ? json(null) : json({ session: { token: "old-token" }, user: USER });
      }
      if (url.endsWith("/delete-user")) {
        deleted = true;
        throw new TypeError("fetch failed");
      }
      throw new Error(`Unexpected ${new URL(url).pathname}`);
    };
    h.account.requestDeletion();
    await h.account.confirmDeletion();
    expect(h.state).toEqual({
      kind: "signedIn",
      ...USER,
      deletion: { kind: "failed", message: DELETE_ACCOUNT_OFFLINE_MESSAGE },
    });
    await h.account.retryDeletion();
    await h.account.confirmDeletion();
    expect(http.sent.filter(({ url }) => url.endsWith("/delete-user"))).toHaveLength(1);
    expect(h.state).toEqual({ kind: "error", message: AUTH_SESSION_ENDED_MESSAGE });
    expect(h.states.filter((state) => state.kind === "signedOut")).toEqual([]);
    expect(authSessionStored(electron.state.userData, "nightly")).toBe(false);
    await h.account.signIn();
    expect(h.state).toEqual({ kind: "signingIn", purpose: "signIn", phase: "browser" });
    h.account.dispose();
  });
});
