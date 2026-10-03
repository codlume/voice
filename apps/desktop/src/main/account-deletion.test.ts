import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import {
  AUTH_SESSION_CHECK_INTERVAL_MS,
  DELETE_ACCOUNT_FAILED_MESSAGE,
  DELETE_ACCOUNT_OFFLINE_MESSAGE,
  SIGN_IN_TIMEOUT_MS,
  SIGN_IN_ERRORS,
} from "./account.ts";
import {
  SECOND_CODE,
  USER,
  harness,
  signedIn,
  flush,
  expectNoSecrets,
} from "./account.test-harness.ts";

/** Confirms, then answers the check of which account the stored cookie belongs to. */
async function confirmDeletion(h: ReturnType<typeof harness>, user = USER) {
  const done = h.account.confirmDeletion();
  await flush();
  h.checks.at(-1)?.answer({ kind: "active", user });
  await flush();
  return { done };
}

async function staleDeletion(h: Awaited<ReturnType<typeof signedIn>>, revoke: () => Promise<void>) {
  h.account.requestDeletion();
  const { done: deleting } = await confirmDeletion(h);
  h.fake.revocations.mockImplementation(revoke);
  h.fake.deletions[0]?.answer({ kind: "reauthRequired" });
  await deleting;
  expect(h.state).toMatchObject({
    kind: "signedIn",
    ...USER,
    deletion: { kind: "reauthRequired" },
  });
  const signIn = h.account.signIn();
  await flush();
  expect(h.state).toEqual({ kind: "signingIn", purpose: "deleteAccount", phase: "browser" });
  h.requests.at(-1)?.resolve("state2");
  await signIn;
}

describe("account deletion through the snapshot", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("deletion aborts a launch check before publishing confirmation and a late answer cannot restore auth", async () => {
    const h = harness({ hasStoredAuthSession: () => true });
    const restoring = h.account.restore();
    await flush();
    h.store.subscribe((value) => {
      if (value.account.kind === "signedIn" && value.account.deletion?.kind === "confirming")
        expect(h.checks[0]?.signal.aborted).toBe(true);
    });
    h.account.requestDeletion();
    expect(h.checks[0]?.signal.aborted).toBe(true);
    const { done: deleting } = await confirmDeletion(h);
    h.fake.deletions[0]?.answer({ kind: "deleted" });
    await deleting;
    h.checks[0]?.answer({ kind: "active", user: USER });
    await restoring;
    expect(h.state).toEqual({ kind: "signedOut" });
    expect(h.fake.stored).toBe(false);
    expect(h.fake.client.cachedUser()).toBeNull();
  });

  test("a refresh waiting for the client cannot check after deletion starts", async () => {
    const h = await signedIn();
    await vi.advanceTimersByTimeAsync(AUTH_SESSION_CHECK_INTERVAL_MS);
    const refreshing = h.account.refresh();
    h.account.requestDeletion();
    await refreshing;
    expect(h.checks).toEqual([]);
    expect(h.state).toEqual({ kind: "signedIn", ...USER, deletion: { kind: "confirming" } });
  });

  test("deletion asks the API whose account the cookie is and refuses any other account", async () => {
    const h = await signedIn();
    const other = { id: "grace-id", name: "Grace Hopper", email: "grace@example.com" };
    h.account.requestDeletion();
    const deleting = h.account.confirmDeletion();
    await flush();
    expect(h.fake.deletions).toEqual([]);
    expect(h.state).toEqual({ kind: "signedIn", ...USER, deletion: { kind: "deleting" } });
    h.checks.at(-1)?.answer({ kind: "active", user: other });
    await deleting;
    expect(h.fake.deletions).toEqual([]);
    expect(h.fake.forgotten).toBe(1);
    expect(h.state).toEqual({
      kind: "signedIn",
      ...other,
      notice: `Voice is signed in as ${other.email}, so it did not delete ${USER.email}.`,
    });

    // A fresh confirmation names the account the cookie belongs to.
    h.account.requestDeletion();
    expect(h.state).toEqual({ kind: "signedIn", ...other, deletion: { kind: "confirming" } });
    const { done: retried } = await confirmDeletion(h, other);
    h.fake.deletions[0]?.answer({ kind: "deleted" });
    await retried;
    expect(h.state).toEqual({ kind: "signedOut" });
    expectNoSecrets(h);
  });

  test("requires confirmation and cancel sends no deletion request", async () => {
    const h = await signedIn();
    await h.account.confirmDeletion();
    expect(h.fake.deletions).toEqual([]);
    h.account.requestDeletion();
    expect(h.state).toEqual({ kind: "signedIn", ...USER, deletion: { kind: "confirming" } });
    expect(h.fake.deletions).toEqual([]);
    h.account.cancelDeletion();
    expect(h.state).toEqual({ kind: "signedIn", ...USER });
    expect(h.fake.forgotten).toBe(1);
  });

  test("only a successful deletion forgets the local auth session and shows signed out", async () => {
    const h = await signedIn();
    h.account.requestDeletion();
    const { done: deleting } = await confirmDeletion(h);
    expect(h.state).toEqual({ kind: "signedIn", ...USER, deletion: { kind: "deleting" } });
    await h.account.confirmDeletion();
    h.account.cancelDeletion();
    expect(h.fake.deletions).toHaveLength(1);
    expect(h.fake.forgotten).toBe(1);
    h.fake.deletions[0]?.answer({ kind: "deleted" });
    await deleting;
    expect(h.fake.forgotten).toBe(2);
    expect(h.state).toEqual({ kind: "signedOut" });
  });

  test.each(["failed", "offline"] as const)(
    "%s deletion preserves signed in and the local auth session, then Retry can succeed",
    async (kind) => {
      const h = await signedIn();
      h.account.requestDeletion();
      const { done: deleting } = await confirmDeletion(h);
      h.fake.deletions[0]?.answer({ kind });
      await deleting;
      expect(h.state).toMatchObject({
        kind: "signedIn",
        ...USER,
        deletion: {
          kind: "failed",
          message:
            kind === "offline" ? DELETE_ACCOUNT_OFFLINE_MESSAGE : DELETE_ACCOUNT_FAILED_MESSAGE,
        },
      });
      expect(h.fake.forgotten).toBe(1);
      await h.account.retryDeletion();
      expect(h.state).toEqual({ kind: "signedIn", ...USER, deletion: { kind: "confirming" } });
      const { done: retry } = await confirmDeletion(h);
      h.fake.deletions[1]?.answer({ kind: "deleted" });
      await retry;
      expect(h.state).toEqual({ kind: "signedOut" });
      expect(h.fake.forgotten).toBe(2);
    },
  );

  test("re-authentication revokes the older device session before offering another confirmation", async () => {
    const h = await signedIn();
    let revoked = false;
    const revocation = Promise.withResolvers<void>();
    const revoke = async () => {
      await revocation.promise;
      revoked = true;
    };
    await staleDeletion(h, revoke);
    const submitted = h.account.submitSignInCode(SECOND_CODE);
    await flush();
    h.exchanges[1]?.resolve();
    await flush();
    expect(h.state).toEqual({ kind: "signedIn", ...USER, deletion: { kind: "revoking" } });
    h.account.cancelDeletion();
    expect(h.state).toMatchObject({ deletion: { kind: "revoking" } });
    expect(h.fake.deletions).toHaveLength(1);
    revocation.resolve();
    await submitted;
    expect(revoked).toBe(true);
    expect(h.state).toEqual({ kind: "signedIn", ...USER, deletion: { kind: "confirming" } });
    h.account.cancelDeletion();
    expect(h.state).toEqual({ kind: "signedIn", ...USER });
    expect(h.fake.deletions).toHaveLength(1);
    expect(h.fake.forgotten).toBe(1);
    expectNoSecrets(h);
  });

  test.each(["cancel", "timeout", "rejected"] as const)(
    "%s during re-authentication preserves the original signed-in account",
    async (ending) => {
      const h = await signedIn();
      const revoke = vi.fn(async () => {});
      await staleDeletion(h, revoke);
      if (ending === "cancel") h.account.cancelSignIn();
      else if (ending === "timeout") await vi.advanceTimersByTimeAsync(SIGN_IN_TIMEOUT_MS);
      else {
        const submitted = h.account.submitSignInCode(SECOND_CODE);
        await flush();
        h.exchanges[1]?.reject(new Error("rejected"));
        await submitted;
      }
      if (ending === "rejected") {
        expect(h.state).toEqual({
          kind: "signedIn",
          ...USER,
          deletion: { kind: "reauthFailed", message: SIGN_IN_ERRORS.rejected },
        });
      } else {
        expect(h.state).toEqual({ kind: "signedIn", ...USER });
      }
      expect(h.fake.forgotten).toBe(1);
      expect(revoke).not.toHaveBeenCalled();
    },
  );

  test("a failed revocation can retry and cannot proceed to deletion", async () => {
    const h = await signedIn();
    const revoke = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValue(undefined);
    await staleDeletion(h, revoke);
    const submitted = h.account.submitSignInCode(SECOND_CODE);
    await flush();
    h.exchanges[1]?.resolve();
    await submitted;
    expect(h.state).toMatchObject({
      kind: "signedIn",
      ...USER,
      deletion: { kind: "revocationFailed" },
    });
    h.account.requestDeletion();
    await h.account.confirmDeletion();
    expect(h.fake.deletions).toHaveLength(1);
    await h.account.retryDeletion();
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(h.state).toEqual({ kind: "signedIn", ...USER, deletion: { kind: "confirming" } });
  });

  test.each(["different email", "same email"])(
    "a different user id cancels deletion even with %s",
    async (emailCase) => {
      const h = await signedIn();
      const revoke = vi.fn(async () => {});
      await staleDeletion(h, revoke);
      const other = {
        id: "grace-id",
        name: "Grace Hopper",
        email: emailCase === "same email" ? USER.email : "grace@example.com",
      };
      h.setUser(other);
      const submitted = h.account.submitSignInCode(SECOND_CODE);
      await flush();
      h.exchanges[1]?.resolve();
      await submitted;
      expect(revoke).toHaveBeenCalledOnce();
      expect(h.state).toEqual({
        kind: "signedIn",
        ...other,
        notice: `You signed in as ${other.email}, so Voice did not delete ${USER.email}.`,
      });
      await h.account.confirmDeletion();
      expect(h.fake.stored).toBe(true);
      expect(h.fake.deletions).toHaveLength(1);
    },
  );
});
