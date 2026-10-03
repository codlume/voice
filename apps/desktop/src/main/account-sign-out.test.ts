import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { AUTH_SESSION_CHECK_INTERVAL_MS } from "./account.ts";
import {
  CODE,
  USER,
  expectNoSecrets,
  fakeClient,
  flush,
  harness,
  startSignIn,
  signedIn,
  withStoredAuthSession,
} from "./account.test-harness.ts";

describe("sign out", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("shows signedOut immediately, clears local auth, and ends the server session", async () => {
    const h = await signedIn();
    const done = h.account.signOut();
    expect(h.state).toEqual({ kind: "signedOut" });
    await flush();
    expect(h.fake.forgotten).toBe(2);
    expect(h.fake.serverSignOuts).toBe(1);
    await h.account.signOut();
    expect(h.fake.signOuts).toHaveLength(1);
    h.fake.signOuts[0]?.answer({ kind: "ended", status: 200 });
    await done;
    expect(h.fake.serverSignOuts).toBe(0);
    expect(h.states.at(-1)).toEqual({ kind: "signedOut" });
    expectNoSecrets(h);
  });

  test.each([
    { kind: "unreachable", error: new TypeError("fetch failed") } as const,
    { kind: "unknown", status: 503 } as const,
  ])(
    "a failed server sign-out stays signed out and retries on successive launches (%s)",
    async (failure) => {
      const h = await signedIn();
      const done = h.account.signOut();
      await flush();
      h.fake.signOuts[0]?.answer(failure);
      await done;
      expect(h.state).toEqual({ kind: "signedOut" });
      expect(h.fake.serverSignOuts).toBe(1);
      h.account.dispose();

      const offline = harness({ fake: h.fake });
      await offline.account.restore();
      await flush();
      expect(offline.state).toEqual({ kind: "signedOut" });
      expect(offline.checks).toEqual([]);
      h.fake.signOuts[1]?.answer(failure);
      await flush();
      expect(h.fake.serverSignOuts).toBe(1);
      offline.account.dispose();

      const online = harness({ fake: h.fake });
      await online.account.restore();
      await flush();
      h.fake.signOuts[2]?.answer({ kind: "ended", status: 200 });
      await flush();
      expect(h.fake.serverSignOuts).toBe(0);
      expect(online.state).toEqual({ kind: "signedOut" });
      expect(online.states).toEqual([]);
      expectNoSecrets(online);
      const next = harness({ fake: h.fake });
      await next.account.restore();
      expect(next.createClient).not.toHaveBeenCalled();
    },
  );

  test("a retry reporting the session already gone never restores the cached identity", async () => {
    const fake = fakeClient();
    fake.setStored(true);
    fake.client.retireAuthSession();
    fake.setCached(USER);
    const h = harness({ fake });
    await h.account.restore();
    await flush();
    fake.signOuts[0]?.answer({ kind: "ended", status: 401 });
    await flush();
    expect(h.state).toEqual({ kind: "signedOut" });
    expect(h.states).toEqual([]);
    expect(h.checks).toEqual([]);
    expect(fake.serverSignOuts).toBe(0);
  });

  test("a launch retry cannot overwrite a new sign-in", async () => {
    const fake = fakeClient();
    fake.setStored(true);
    fake.client.retireAuthSession();
    const h = harness({ fake });
    await h.account.restore();
    await startSignIn(h);
    const submitted = h.account.submitSignInCode(CODE);
    await flush();
    fake.exchanges[0]?.resolve();
    await submitted;
    fake.signOuts[0]?.answer({ kind: "ended", status: 200 });
    await flush();
    expect(h.state).toEqual({ kind: "signedIn", ...USER });
  });

  test("a session check completing after sign-out cannot sign the user back in", async () => {
    const h = harness({ hasStoredAuthSession: withStoredAuthSession });
    const restored = h.account.restore();
    await flush();
    const retire = h.fake.client.retireAuthSession;
    vi.spyOn(h.fake.client, "retireAuthSession").mockImplementation(() => {
      expect(h.checks[0]?.signal.aborted).toBe(true);
      retire();
    });
    const done = h.account.signOut();
    expect(h.checks[0]?.signal.aborted).toBe(true);
    expect(h.state).toEqual({ kind: "signedOut" });
    await flush();
    h.checks[0]?.answer({ kind: "active", user: USER });
    await restored;
    h.fake.signOuts[0]?.answer({ kind: "ended", status: 200 });
    await done;
    expect(h.state).toEqual({ kind: "signedOut" });
    expect(h.fake.stored).toBe(false);
    expect(h.fake.client.cachedUser()).toBeNull();
    h.account.dispose();
    const relaunched = harness({ fake: h.fake });
    await relaunched.account.restore();
    expect(relaunched.state).toEqual({ kind: "signedOut" });
    expect(relaunched.createClient).not.toHaveBeenCalled();
  });

  test("a crash after enqueue clears active auth on load without a cookieless session check", async () => {
    const fake = fakeClient();
    fake.setStored(true);
    fake.client.queueServerSignOut("fixture-cookie");
    const h = harness({ fake });
    h.createClient.mockImplementation(async () => {
      fake.client.forget();
      return fake.client;
    });
    await h.account.restore();
    expect(h.state).toEqual({ kind: "signedOut" });
    expect(h.states).toEqual([]);
    expect(h.checks).toEqual([]);
    expect(fake.signOuts).toHaveLength(1);
    fake.signOuts[0]?.answer({ kind: "ended", status: 200 });
    await flush();
    expect(fake.serverSignOuts).toBe(0);
    expectNoSecrets(h);
  });

  test("a refresh waiting for the client cannot send a cookieless check after sign-out", async () => {
    const h = await signedIn();
    await vi.advanceTimersByTimeAsync(AUTH_SESSION_CHECK_INTERVAL_MS);
    const refreshing = h.account.refresh();
    const signingOut = h.account.signOut();
    await flush();
    h.checks[0]?.answer({ kind: "ended", status: 200 });
    h.fake.signOuts[0]?.answer({ kind: "ended", status: 200 });
    await Promise.all([refreshing, signingOut]);
    expect(h.checks).toEqual([]);
    expect(h.state).toEqual({ kind: "signedOut" });
    expect(h.states.at(-1)).toEqual({ kind: "signedOut" });
  });

  test("fresh sign-in retires an offline credential and relaunch revokes only the old session", async () => {
    const fake = fakeClient();
    fake.setStored(true);
    fake.setCached(null);
    const h = harness({ fake });
    const restoring = h.account.restore();
    await flush();
    fake.checks[0]?.answer({ kind: "unreachable", error: new TypeError("offline") });
    await restoring;
    expect(h.state).toEqual({ kind: "signedOut" });
    expect(fake.stored).toBe(true);

    await startSignIn(h);
    expect(fake.stored).toBe(false);
    expect(fake.serverSignOuts).toBe(1);
    fake.signOuts[0]?.answer({ kind: "unreachable", error: new TypeError("offline") });
    const nextUser = { id: "grace-id", name: "Grace Hopper", email: "grace@example.com" };
    fake.setUser(nextUser);
    const submitted = h.account.submitSignInCode(CODE);
    await flush();
    fake.exchanges[0]?.resolve();
    await submitted;
    expect(h.state).toEqual({ kind: "signedIn", ...nextUser });
    h.account.dispose();

    const relaunched = harness({ fake });
    const restored = relaunched.account.restore();
    await flush();
    expect(relaunched.state).toEqual({ kind: "signedIn", ...nextUser });
    fake.signOuts[1]?.answer({ kind: "ended", status: 200 });
    fake.checks[1]?.answer({ kind: "active", user: nextUser });
    await restored;
    expect(fake.serverSignOuts).toBe(0);
    expect(fake.stored).toBe(true);
    expect(fake.client.cachedUser()).toEqual(nextUser);
    expect(relaunched.states.every((state) => state.kind === "signedIn")).toBe(true);
    expectNoSecrets(relaunched);
  });

  test("sign-out is inert in states without an active account", async () => {
    for (const h of [harness(), harness({ apiUrl: null })]) {
      await h.account.signOut();
      expect(h.createClient).not.toHaveBeenCalled();
      expect(h.states).toEqual([]);
    }
  });
});
