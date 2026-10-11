import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import {
  AUTH_SESSION_CHECK_INTERVAL_MS,
  AUTH_SESSION_ENDED_MESSAGE,
  FIRST_NAME_REQUIRED_MESSAGE,
  NAME_SHAPE_MESSAGE,
  NAME_TOO_LONG_MESSAGE,
  UPDATE_NAME_DELETING_MESSAGE,
  UPDATE_NAME_FAILED_MESSAGE,
  UPDATE_NAME_OFFLINE_MESSAGE,
  UPDATE_NAME_SAVING_MESSAGE,
  UPDATE_NAME_SIGNED_OUT_MESSAGE,
  parseAccountName,
} from "./account.ts";
import {
  SECOND_CODE,
  USER,
  expectNoSecrets,
  flush,
  harness,
  refresh,
  signedIn,
  startSignIn,
} from "./account.test-harness.ts";

describe("parseAccountName", () => {
  test("trims both names and allows an empty last name", () => {
    expect(parseAccountName({ firstName: " Ada ", lastName: " King Lovelace " })).toEqual({
      firstName: "Ada",
      lastName: "King Lovelace",
    });
    expect(parseAccountName({ firstName: "Plato", lastName: "  " })).toEqual({
      firstName: "Plato",
      lastName: "",
    });
  });

  test("refuses anything but two strings with a first name, at most 100 characters each", () => {
    for (const value of [null, "Ada", { firstName: "Ada" }, { firstName: 1, lastName: "" }]) {
      expect(() => parseAccountName(value)).toThrow(NAME_SHAPE_MESSAGE);
    }
    expect(() => parseAccountName({ firstName: " ", lastName: "Lovelace" })).toThrow(
      FIRST_NAME_REQUIRED_MESSAGE,
    );
    expect(() => parseAccountName({ firstName: "A".repeat(101), lastName: "" })).toThrow(
      NAME_TOO_LONG_MESSAGE,
    );
    expect(() => parseAccountName({ firstName: "Ada", lastName: "L".repeat(101) })).toThrow(
      NAME_TOO_LONG_MESSAGE,
    );
  });
});

describe("updateName", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const renamed = { ...USER, name: "Augusta King", firstName: "Augusta", lastName: "King" };

  test("publishes and caches the signed-in identity with the saved names", async () => {
    const h = await signedIn();
    const saving = h.account.updateName({ firstName: "Augusta", lastName: "King" });
    await flush();
    expect(h.fake.nameUpdates.map(({ user }) => user)).toEqual([renamed]);
    expect(h.state).toEqual({ kind: "signedIn", ...USER });
    h.fake.nameUpdates[0]?.answer({ kind: "updated" });
    await saving;
    expect(h.state).toEqual({ kind: "signedIn", ...renamed });
    expect(h.fake.client.cachedUser()).toEqual(renamed);
  });

  test("a last name cleared to empty leaves the first name as the full name", async () => {
    const h = await signedIn();
    const saving = h.account.updateName({ firstName: "Ada", lastName: "" });
    await flush();
    h.fake.nameUpdates[0]?.answer({ kind: "updated" });
    await saving;
    expect(h.state).toEqual({ kind: "signedIn", ...USER, name: "Ada", lastName: "" });
  });

  test("a sign-out while the update is in flight stays signed out and caches nothing", async () => {
    const h = await signedIn();
    const saving = h.account.updateName({ firstName: "Augusta", lastName: "King" });
    await flush();
    void h.account.signOut();
    h.fake.nameUpdates[0]?.answer({ kind: "updated" });
    await saving;
    expect(h.state).toEqual({ kind: "signedOut" });
    expect(h.fake.client.cachedUser()).toBeNull();
  });

  test("a sign-in as another account while the update is in flight keeps that account's identity", async () => {
    const grace = {
      id: "grace-id",
      name: "Grace Hopper",
      firstName: "Grace",
      lastName: "Hopper",
      email: "grace@example.com",
    };
    const h = await signedIn();
    const saving = h.account.updateName({ firstName: "Augusta", lastName: "King" });
    await flush();
    const signingOut = h.account.signOut();
    await flush();
    h.fake.signOuts[0]?.answer({ kind: "ended", status: 200 });
    await signingOut;
    h.setUser(grace);
    await startSignIn(h, "state2");
    const submitted = h.account.submitSignInCode(SECOND_CODE);
    await flush();
    h.exchanges[1]?.resolve();
    await submitted;
    expect(h.state).toEqual({ kind: "signedIn", ...grace });
    h.fake.nameUpdates[0]?.answer({ kind: "updated" });
    await saving;
    expect(h.state).toEqual({ kind: "signedIn", ...grace });
    expect(h.fake.client.cachedUser()).toEqual(grace);
  });

  test.each([
    ["failed", UPDATE_NAME_FAILED_MESSAGE],
    ["offline", UPDATE_NAME_OFFLINE_MESSAGE],
  ] as const)(
    "a %s update keeps the identity and rejects with a message for the user",
    async (kind, message) => {
      const h = await signedIn();
      const statesBefore = h.states.length;
      const saving = h.account.updateName({ firstName: "Augusta", lastName: "King" });
      await flush();
      h.fake.nameUpdates[0]?.answer({ kind });
      await expect(saving).rejects.toThrow(message);
      expect(h.state).toEqual({ kind: "signedIn", ...USER });
      expect(h.states).toHaveLength(statesBefore);
      expect(h.fake.client.cachedUser()).toEqual(USER);
      expect(h.entries.at(-1)).toEqual({
        message: "account name update failed",
        level: "warn",
        attributes: { "account.failure": kind },
      });
      expectNoSecrets(h);
    },
  );

  test("an ended auth session lands in error, forgets it, and rejects with the same message", async () => {
    const h = await signedIn();
    const { forgotten } = h.fake;
    const entriesBefore = h.entries.length;
    const saving = h.account.updateName({ firstName: "Augusta", lastName: "King" });
    await flush();
    h.fake.nameUpdates[0]?.answer({ kind: "ended", status: 401 });
    await expect(saving).rejects.toThrow(AUTH_SESSION_ENDED_MESSAGE);
    expect(h.state).toEqual({ kind: "error", message: AUTH_SESSION_ENDED_MESSAGE });
    expect(h.fake.forgotten).toBe(forgotten + 1);
    expect(h.fake.client.cachedUser()).toBeNull();
    expect(h.entries.slice(entriesBefore)).toEqual([
      {
        message: "account auth session ended",
        level: "warn",
        attributes: { "http.response.status_code": 401 },
      },
    ]);
  });

  test("is refused while signed out and while a deletion is in progress, without asking the API", async () => {
    const h = harness();
    await expect(h.account.updateName({ firstName: "Ada", lastName: "" })).rejects.toThrow(
      UPDATE_NAME_SIGNED_OUT_MESSAGE,
    );

    const deleting = await signedIn();
    deleting.account.requestDeletion();
    await expect(
      deleting.account.updateName({ firstName: "Augusta", lastName: "King" }),
    ).rejects.toThrow(UPDATE_NAME_DELETING_MESSAGE);
    expect(deleting.fake.nameUpdates).toEqual([]);
    expect(deleting.state).toEqual({ kind: "signedIn", ...USER, deletion: { kind: "confirming" } });
  });

  test("a second save while one is in flight is refused without asking the API, so the first name lands", async () => {
    const h = await signedIn();
    const first = h.account.updateName({ firstName: "Augusta", lastName: "King" });
    await flush();
    const refused = expect(
      h.account.updateName({ firstName: "Grace", lastName: "Hopper" }),
    ).rejects.toThrow(UPDATE_NAME_SAVING_MESSAGE);
    await flush();
    expect(h.fake.nameUpdates.map(({ user }) => user)).toEqual([renamed]);
    await refused;
    h.fake.nameUpdates[0]?.answer({ kind: "updated" });
    await first;
    expect(h.state).toEqual({ kind: "signedIn", ...renamed });
  });

  test("a deletion requested while the update is in flight is ignored, so the new name lands", async () => {
    const h = await signedIn();
    const saving = h.account.updateName({ firstName: "Augusta", lastName: "King" });
    await flush();
    h.account.requestDeletion();
    expect(h.state).toEqual({ kind: "signedIn", ...USER });
    h.fake.nameUpdates[0]?.answer({ kind: "updated" });
    await saving;
    expect(h.state).toEqual({ kind: "signedIn", ...renamed });
  });

  test("aborts a check in flight, so its answer cannot put the old name back", async () => {
    const h = await signedIn();
    await vi.advanceTimersByTimeAsync(AUTH_SESSION_CHECK_INTERVAL_MS);
    const { done: refreshed } = await refresh(h);
    expect(h.checks).toHaveLength(1);
    const saving = h.account.updateName({ firstName: "Augusta", lastName: "King" });
    await flush();
    expect(h.checks[0]?.signal.aborted).toBe(true);
    h.fake.nameUpdates[0]?.answer({ kind: "updated" });
    await saving;
    h.checks[0]?.answer({ kind: "active", user: USER });
    await refreshed;
    expect(h.state).toEqual({ kind: "signedIn", ...renamed });
  });

  test("a check it aborts is not logged as a failed check", async () => {
    const h = await signedIn();
    await vi.advanceTimersByTimeAsync(AUTH_SESSION_CHECK_INTERVAL_MS);
    const { done: refreshed } = await refresh(h);
    const saving = h.account.updateName({ firstName: "Augusta", lastName: "King" });
    await flush();
    // The real adapter answers an aborted get-session at once, before the update returns.
    h.checks[0]?.answer({
      kind: "unreachable",
      error: new DOMException("This operation was aborted", "AbortError"),
    });
    await refreshed;
    h.fake.nameUpdates[0]?.answer({ kind: "updated" });
    await saving;
    expect(h.entries.map(({ message }) => message)).not.toContain(
      "account auth session check failed",
    );
  });

  test("a window shown while the update is in flight starts no check", async () => {
    const h = await signedIn();
    await vi.advanceTimersByTimeAsync(AUTH_SESSION_CHECK_INTERVAL_MS);
    const saving = h.account.updateName({ firstName: "Augusta", lastName: "King" });
    await flush();
    await refresh(h);
    expect(h.checks).toEqual([]);
    h.fake.nameUpdates[0]?.answer({ kind: "updated" });
    await saving;
    await refresh(h);
    expect(h.checks).toHaveLength(1);
  });
});
