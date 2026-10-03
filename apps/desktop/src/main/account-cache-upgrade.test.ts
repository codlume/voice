// Load the Electron mock before plugin storage.
import {
  USER,
  GRACE,
  electron,
  http,
  json,
  signedIn,
  signedInClient,
  client,
  snapshotAccount,
  signInCode,
  requests,
} from "./account-client.test-harness.ts";
import { expect, test, vi } from "vite-plus/test";
import { storage } from "@better-auth/electron/storage";
import { authSessionStored, authStorageKeys } from "./account-storage.ts";

const legacyUser = { name: USER.name, email: USER.email };
const keys = authStorageKeys("nightly");

async function legacyAccount() {
  await signedInClient();
  storage().setItem(
    keys.identity,
    electron.api.safeStorage.encryptString(JSON.stringify(legacyUser)).toString("base64"),
  );
  const cookie = storage().getItem(keys.cookie);
  http.answer = () => {
    throw new TypeError("offline");
  };
  const auth = client("nightly");
  const h = snapshotAccount(auth);
  await h.account.restore();
  expect(h.state).toEqual({ kind: "signedIn", ...legacyUser });
  expect(auth.cachedUser()).toEqual(legacyUser);
  expect(storage().getItem(keys.cookie)).toBe(cookie);
  expect(authSessionStored(electron.state.userData, "nightly")).toBe(true);
  return { h, auth, cookie };
}

test.each([USER, GRACE])(
  "an offline legacy cache resolves the original id before re-authenticating as $name",
  async (nextUser) => {
    const { h, auth, cookie } = await legacyAccount();
    h.account.requestDeletion();
    await h.account.confirmDeletion();
    expect(h.state).toMatchObject({
      kind: "signedIn",
      ...legacyUser,
      deletion: { kind: "failed" },
    });
    expect(http.sent.filter(({ url }) => url.endsWith("/delete-user"))).toEqual([]);
    expect(storage().getItem(keys.cookie)).toBe(cookie);

    let oldEnded = false;
    http.sent = [];
    http.answer = (url) => {
      if (url.endsWith("/get-session")) {
        if (http.sent.at(-1)?.cookie === "better-auth.session_token=new-token")
          return json({ user: nextUser, session: { token: "new-token" } });
        return oldEnded ? json(null) : json({ user: USER, session: { token: "old-token" } });
      }
      if (url.endsWith("/electron/token")) return signedIn("new-token", nextUser);
      if (url.endsWith("/sign-out")) {
        oldEnded = true;
        return json({ success: true });
      }
      if (url.endsWith("/delete-user"))
        return oldEnded
          ? json({ success: true, message: "User deleted" })
          : json({ code: "SESSION_EXPIRED" }, { status: 400 });
      throw new Error("Unexpected auth endpoint");
    };
    await h.account.retryDeletion();
    await h.account.confirmDeletion();
    expect(h.state).toMatchObject({
      kind: "signedIn",
      ...USER,
      deletion: { kind: "reauthRequired" },
    });
    expect(requests()).toEqual([
      ["/api/auth/get-session", "better-auth.session_token=old-token"],
      ["/api/auth/delete-user", "better-auth.session_token=old-token"],
    ]);
    expect(auth.cachedUser()).toEqual(USER);
    await h.account.submitSignInCode(await signInCode(h, auth));
    expect(oldEnded).toBe(true);
    if (nextUser.id === USER.id) {
      expect(h.state).toEqual({ kind: "signedIn", ...USER, deletion: { kind: "confirming" } });
      await h.account.confirmDeletion();
      expect(h.state).toEqual({ kind: "signedOut" });
      expect(authSessionStored(electron.state.userData, "nightly")).toBe(false);
    } else {
      expect(h.state).toEqual({
        kind: "signedIn",
        ...GRACE,
        notice: `You signed in as ${GRACE.email}, so Voice did not delete ${USER.email}.`,
      });
      await h.account.confirmDeletion();
      expect(http.sent.filter(({ url }) => url.endsWith("/delete-user"))).toHaveLength(1);
      expect(auth.cachedUser()).toEqual(GRACE);
      expect(authSessionStored(electron.state.userData, "nightly")).toBe(true);
    }
    h.account.dispose();
  },
);

test("deletion refuses a cached identity the cookie does not belong to and shows the cookie's account", async () => {
  http.answer = () => signedIn("beta-token", GRACE);
  await client("nightly").checkAuthSession(new AbortController().signal);
  // What a late answer from a cancelled sign-in wrote before exchanges were fenced.
  storage().setItem(
    keys.identity,
    electron.api.safeStorage.encryptString(JSON.stringify(USER)).toString("base64"),
  );
  http.answer = () => {
    throw new TypeError("offline");
  };
  const auth = client("nightly");
  const h = snapshotAccount(auth);
  await h.account.restore();
  expect(h.state).toEqual({ kind: "signedIn", ...USER });

  http.sent = [];
  http.answer = (url) => {
    if (url.endsWith("/get-session"))
      return json({ user: GRACE, session: { token: "beta-token" } });
    if (url.endsWith("/delete-user")) return json({ success: true, message: "User deleted" });
    throw new Error("Unexpected auth endpoint");
  };
  h.account.requestDeletion();
  await h.account.confirmDeletion();
  expect(requests()).toEqual([["/api/auth/get-session", "better-auth.session_token=beta-token"]]);
  expect(h.state).toEqual({
    kind: "signedIn",
    ...GRACE,
    notice: `Voice is signed in as ${GRACE.email}, so it did not delete ${USER.email}.`,
  });
  expect(auth.cachedUser()).toEqual(GRACE);
  expect(authSessionStored(electron.state.userData, "nightly")).toBe(true);

  h.account.requestDeletion();
  await h.account.confirmDeletion();
  expect(h.state).toEqual({ kind: "signedOut" });
  expect(requests()).toEqual([
    ["/api/auth/get-session", "better-auth.session_token=beta-token"],
    ["/api/auth/get-session", "better-auth.session_token=beta-token"],
    ["/api/auth/delete-user", "better-auth.session_token=beta-token"],
  ]);
  expect(authSessionStored(electron.state.userData, "nightly")).toBe(false);
  h.account.dispose();
});

test.each(["503", "missing id"])(
  "%s resolving a legacy cache id preserves auth and cannot start deletion",
  async (failure) => {
    const { h, cookie } = await legacyAccount();
    http.answer = () =>
      failure === "503"
        ? json({}, { status: 503 })
        : json({ user: legacyUser, session: { token: "old-token" } });
    h.account.requestDeletion();
    await h.account.confirmDeletion();
    expect(h.state).toMatchObject({
      kind: "signedIn",
      ...legacyUser,
      deletion: { kind: "failed" },
    });
    expect(http.sent.filter(({ url }) => url.endsWith("/delete-user"))).toEqual([]);
    await h.account.signIn();
    expect(h.state).toMatchObject({
      kind: "signedIn",
      ...legacyUser,
      deletion: { kind: "failed" },
    });
    expect(storage().getItem(keys.cookie)).toBe(cookie);
    h.account.cancelDeletion();
    expect(h.state).toEqual({ kind: "signedIn", ...legacyUser });
    h.account.dispose();
  },
);

test("sign-out during the legacy id lookup cannot start deletion or restore the old auth", async () => {
  const { h, auth } = await legacyAccount();
  const pending = Promise.withResolvers<Response>();
  http.sent = [];
  http.answer = () => pending.promise;
  h.account.requestDeletion();
  const deleting = h.account.confirmDeletion();
  await vi.waitFor(() => expect(http.sent).toHaveLength(1));
  http.answer = (url) => (url.endsWith("/sign-out") ? json({ success: true }) : json(null));
  await h.account.signOut();
  pending.resolve(signedIn("old-token"));
  await deleting;
  expect(h.state).toEqual({ kind: "signedOut" });
  expect(http.sent.filter(({ url }) => url.endsWith("/delete-user"))).toEqual([]);
  expect(authSessionStored(electron.state.userData, "nightly")).toBe(false);
  expect(auth.cachedUser()).toBeNull();
  h.account.dispose();
});

test("a legacy id lookup deadline keeps auth and allows Retry and Cancel", async () => {
  const { h, cookie } = await legacyAccount();
  const pending = Promise.withResolvers<Response>();
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  http.sent = [];
  http.answer = () => pending.promise;
  h.account.requestDeletion();
  const deleting = h.account.confirmDeletion();
  await vi.waitFor(() => expect(http.sent).toHaveLength(1));
  expect(timeout).toHaveBeenCalledWith(30_000);
  deadline.abort(new DOMException("Timed out", "TimeoutError"));
  await deleting;
  expect(h.state).toMatchObject({ kind: "signedIn", ...legacyUser, deletion: { kind: "failed" } });
  expect(http.sent.filter(({ url }) => url.endsWith("/delete-user"))).toEqual([]);
  expect(storage().getItem(keys.cookie)).toBe(cookie);
  await h.account.retryDeletion();
  expect(h.state).toEqual({ kind: "signedIn", ...legacyUser, deletion: { kind: "confirming" } });
  h.account.cancelDeletion();
  expect(h.state).toEqual({ kind: "signedIn", ...legacyUser });
  pending.resolve(json(null));
  h.account.dispose();
});
