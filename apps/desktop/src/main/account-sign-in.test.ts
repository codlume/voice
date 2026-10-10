// Load the Electron mock before the adapter and plugin storage.
import {
  API,
  USER,
  electron,
  http,
  json,
  signedIn,
  client,
  config,
  snapshotAccount,
  signInCode,
} from "./account-client.test-harness.ts";
import { writeFileSync } from "node:fs";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { storage } from "@better-auth/electron/storage";
import { SIGN_IN_TIMEOUT_MS } from "./account.ts";
import { harness } from "./account.test-harness.ts";
import {
  authSessionStored,
  authStorageKeys,
  authStored,
  serverSignOutsStored,
} from "./account-storage.ts";

const confirmed = (url: string) =>
  url.endsWith("/sign-out") ? json({ success: true }) : json(null);

describe("an abandoned exchange through the real auth client", () => {
  const keys = authStorageKeys("nightly");

  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());

  test.each(["cancel", "timeout"] as const)(
    "%s as the API answers persists nothing, ends the session it created, and stays signed out across restart",
    async (ending) => {
      const auth = client("nightly");
      const h = snapshotAccount(auth);
      const code = await signInCode(h, auth);
      const response = signedIn("late-token");
      const getHeader = response.headers.get.bind(response.headers);
      // The user gives up as the answer arrives: Cancel, or the attempt's deadline.
      vi.spyOn(response.headers, "get").mockImplementation((name) => {
        if (name.toLowerCase() === "set-cookie" && h.state.kind === "signingIn") {
          if (ending === "cancel") h.account.cancelSignIn();
          else vi.advanceTimersByTime(SIGN_IN_TIMEOUT_MS);
        }
        return getHeader(name);
      });
      http.answer = () => response;
      await h.account.submitSignInCode(code);

      expect(h.state).toEqual({ kind: "signedOut" });
      expect(storage().getItem(keys.cookie)).toBeNull();
      expect(storage().getItem(keys.identity)).toBeNull();
      expect(auth.hasAuthSession()).toBe(false);
      expect(auth.cachedUser()).toBeNull();
      expect(serverSignOutsStored(electron.state.userData, "nightly")).toBe(true);
      expect(h.entries.map((entry) => entry.message)).not.toContain("account sign-in failed");
      http.answer = confirmed;
      expect(await auth.endServerSignOuts()).toEqual([{ kind: "ended", status: 200 }]);
      expect(http.sent.slice(-2).map(({ url, cookie }) => [new URL(url).pathname, cookie])).toEqual(
        [
          ["/api/auth/sign-out", "better-auth.session_token=late-token"],
          ["/api/auth/get-session", "better-auth.session_token=late-token"],
        ],
      );

      h.account.dispose();
      const requests = http.sent.length;
      const relaunched = snapshotAccount(client("nightly"));
      await relaunched.account.restore();
      expect(relaunched.state).toEqual({ kind: "signedOut" });
      expect(relaunched.states).toEqual([]);
      expect(http.sent).toHaveLength(requests);
      expect(config()).not.toContain(USER.email);
    },
  );

  test("cancel before the API answers persists nothing and has no session to end", async () => {
    const auth = client("nightly");
    const h = snapshotAccount(auth);
    const code = await signInCode(h, auth);
    const pending = Promise.withResolvers<Response>();
    http.answer = () => pending.promise;
    const submitted = h.account.submitSignInCode(code);
    await vi.waitFor(() => expect(http.sent).toHaveLength(1));
    h.account.cancelSignIn();
    pending.resolve(signedIn("late-token"));
    await submitted;

    expect(h.state).toEqual({ kind: "signedOut" });
    expect(authStored(electron.state.userData, "nightly")).toBe(false);
    expect(auth.hasAuthSession()).toBe(false);
    expect(auth.cachedUser()).toBeNull();
    expect(await auth.endServerSignOuts()).toEqual([]);
    expect(h.entries.map((entry) => entry.message)).not.toContain("account sign-in failed");
  });

  test("an exchange answered after forget writes no identity or cookie and ends its session", async () => {
    const auth = client("nightly");
    const { state } = await auth.openBrowser();
    const code = Buffer.from(JSON.stringify({ identifier: "code-1", state })).toString("base64url");
    const pending = Promise.withResolvers<Response>();
    http.answer = () => pending.promise;
    const late = auth.redeem(code, new AbortController().signal);
    await vi.waitFor(() => expect(http.sent).toHaveLength(1));
    // What a newer sign-in does to whatever is stored before it opens the browser.
    auth.forget();
    pending.resolve(signedIn("late-token"));
    const result = await late;

    expect(auth.cachedUser()).toBeNull();
    expect(auth.hasAuthSession()).toBe(false);
    expect(storage().getItem(keys.identity)).toBeNull();
    expect(result).toEqual({ kind: "abandoned" });
    expect(serverSignOutsStored(electron.state.userData, "nightly")).toBe(true);
    http.answer = confirmed;
    expect(await auth.endServerSignOuts()).toEqual([{ kind: "ended", status: 200 }]);
    expect(http.sent.at(-2)?.cookie).toBe("better-auth.session_token=late-token");
  });
});

describe("a session Voice does not keep", () => {
  test("an answer with a session cookie but no user is rejected and its session is queued for sign-out", async () => {
    const auth = client("nightly");
    const { state } = await auth.openBrowser();
    const code = Buffer.from(JSON.stringify({ identifier: "code-1", state })).toString("base64url");
    http.answer = () =>
      json(
        { token: "stray-token", session: { token: "stray-token" } },
        {
          headers: { "set-cookie": "better-auth.session_token=stray-token; Max-Age=3600; Path=/" },
        },
      );
    expect(await auth.redeem(code, new AbortController().signal)).toMatchObject({
      kind: "rejected",
    });
    expect(auth.cachedUser()).toBeNull();
    expect(serverSignOutsStored(electron.state.userData, "nightly")).toBe(true);
    http.answer = (url) => (url.endsWith("/sign-out") ? json({ success: true }) : json(null));
    expect(await auth.endServerSignOuts()).toEqual([{ kind: "ended", status: 200 }]);
    expect(http.sent.at(-2)?.cookie).toBe("better-auth.session_token=stray-token");
  });
});

describe("an unreadable config.json", () => {
  test("launches signed out, then Sign in completes and stores the new auth session", async () => {
    const { userData } = electron.state;
    writeFileSync(NodePath.join(userData, "config.json"), '{"voice":{"nightly":{"cookie":"djEw');
    let opening: Promise<{ state: string }> | undefined;
    const h = harness({
      apiUrl: API.nightly,
      createClient: async () => {
        const auth = client("nightly");
        const openBrowser = auth.openBrowser;
        auth.openBrowser = () => (opening = openBrowser());
        return auth;
      },
      hasStoredAuthSession: () => authSessionStored(userData, "nightly"),
      hasStoredAuth: () => authStored(userData, "nightly"),
    });
    await h.account.restore();
    expect(h.state).toEqual({ kind: "signedOut" });

    await h.account.signIn();
    expect(h.state).toMatchObject({ kind: "signingIn", phase: "browser" });
    if (!opening) throw new Error("Sign-in did not open the browser");
    const { state } = await opening;
    http.answer = () => signedIn("fresh-token");
    await h.account.submitSignInCode(
      Buffer.from(JSON.stringify({ identifier: "code-1", state })).toString("base64url"),
    );

    expect(h.state).toMatchObject({ kind: "signedIn", email: USER.email });
    expect(authSessionStored(userData, "nightly")).toBe(true);
  });
});
