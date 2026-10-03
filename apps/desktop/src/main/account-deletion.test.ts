import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { SIGN_IN_TIMEOUT_MS, SIGN_IN_ERRORS } from "./account.ts";
import {
  CODE,
  SECOND_CODE,
  USER,
  harness,
  startSignIn,
  flush,
  expectNoSecrets,
} from "./account.test-harness.ts";

describe("account deletion through the snapshot", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function signedIn() {
    const h = harness();
    await startSignIn(h);
    const submitted = h.account.submitSignInCode(CODE);
    await flush();
    h.exchanges[0]?.resolve();
    await submitted;
    return h;
  }

  async function staleDeletion(
    h: Awaited<ReturnType<typeof signedIn>>,
    revoke: () => Promise<void>,
  ) {
    h.account.requestDeletion();
    const deleting = h.account.confirmDeletion();
    await flush();
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

  test("requires confirmation and cancel sends no deletion request", async () => {
    const h = await signedIn();
    await h.account.confirmDeletion();
    expect(h.fake.deletions).toEqual([]);
    h.account.requestDeletion();
    expect(h.state).toEqual({ kind: "signedIn", ...USER, deletion: { kind: "confirming" } });
    expect(h.fake.deletions).toEqual([]);
    h.account.cancelDeletion();
    expect(h.state).toEqual({ kind: "signedIn", ...USER });
    expect(h.fake.forgotten).toBe(0);
  });

  test("only a successful deletion forgets the local auth session and shows signed out", async () => {
    const h = await signedIn();
    h.account.requestDeletion();
    const deleting = h.account.confirmDeletion();
    await flush();
    expect(h.state).toEqual({ kind: "signedIn", ...USER, deletion: { kind: "deleting" } });
    await h.account.confirmDeletion();
    h.account.cancelDeletion();
    expect(h.fake.deletions).toHaveLength(1);
    expect(h.fake.forgotten).toBe(0);
    h.fake.deletions[0]?.answer({ kind: "deleted" });
    await deleting;
    expect(h.fake.forgotten).toBe(1);
    expect(h.state).toEqual({ kind: "signedOut" });
  });

  test.each(["failed", "offline"] as const)(
    "%s deletion preserves signed in and the local auth session, then Retry can succeed",
    async (kind) => {
      const h = await signedIn();
      h.account.requestDeletion();
      const deleting = h.account.confirmDeletion();
      await flush();
      h.fake.deletions[0]?.answer({ kind });
      await deleting;
      expect(h.state).toMatchObject({
        kind: "signedIn",
        ...USER,
        deletion: { kind: "failed", message: expect.any(String) },
      });
      expect(h.fake.forgotten).toBe(0);
      await h.account.retryDeletion();
      expect(h.state).toEqual({ kind: "signedIn", ...USER, deletion: { kind: "confirming" } });
      const retry = h.account.confirmDeletion();
      await flush();
      h.fake.deletions[1]?.answer({ kind: "deleted" });
      await retry;
      expect(h.state).toEqual({ kind: "signedOut" });
      expect(h.fake.forgotten).toBe(1);
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
    expect(h.fake.forgotten).toBe(0);
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
          deletion: { kind: "reauthRequired", message: SIGN_IN_ERRORS.rejected },
        });
      } else {
        expect(h.state).toEqual({ kind: "signedIn", ...USER });
      }
      expect(h.fake.forgotten).toBe(0);
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
    h.account.cancelDeletion();
    h.account.requestDeletion();
    await h.account.confirmDeletion();
    expect(h.fake.deletions).toHaveLength(1);
    await h.account.retryDeletion();
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(h.state).toEqual({ kind: "signedIn", ...USER, deletion: { kind: "confirming" } });
  });

  test("a different Google account requires confirmation for its own identity", async () => {
    const h = await signedIn();
    const revoke = vi.fn(async () => {});
    await staleDeletion(h, revoke);
    const other = { name: "Grace Hopper", email: "grace@example.com" };
    h.setUser(other);
    const submitted = h.account.submitSignInCode(SECOND_CODE);
    await flush();
    h.exchanges[1]?.resolve();
    await submitted;
    expect(revoke).toHaveBeenCalledOnce();
    expect(h.state).toEqual({ kind: "signedIn", ...other, deletion: { kind: "confirming" } });
    expect(h.fake.deletions).toHaveLength(1);
  });
});
