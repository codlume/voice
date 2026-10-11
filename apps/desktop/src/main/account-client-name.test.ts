// Load the Electron mock before the adapter and plugin storage.
import {
  USER,
  http,
  json,
  client,
  storedIdentity,
  signedInClient,
} from "./account-client.test-harness.ts";
import { describe, expect, test, vi } from "vite-plus/test";

describe("name update through the real auth client", () => {
  const renamed = { ...USER, name: "Augusta King", firstName: "Augusta", lastName: "King" };

  test("sends only the two names in one request, then caches the identity it was given", async () => {
    const auth = await signedInClient("name-token");
    http.sent = [];
    http.answer = () => json({ status: true });

    expect(await auth.updateName(renamed)).toEqual({ kind: "updated" });
    expect(http.sent.map(({ url, cookie }) => [new URL(url).pathname, cookie])).toEqual([
      ["/api/auth/update-user", "better-auth.session_token=name-token"],
    ]);
    expect(JSON.parse(http.sent[0]?.body ?? "")).toEqual({
      firstName: "Augusta",
      lastName: "King",
    });
    expect(auth.cachedUser()).toEqual(renamed);
    expect(client("nightly").cachedUser()).toEqual(renamed);
  });

  test.each([
    ["a refused update", "failed", () => json({ code: "BAD_REQUEST" }, { status: 400 })],
    ["no connection", "offline", () => Promise.reject(new TypeError("fetch failed"))],
  ] as const)("%s is %s and keeps the cached identity", async (_case, kind, answer) => {
    const auth = await signedInClient("name-token");
    http.answer = answer;
    expect(await auth.updateName(renamed)).toEqual({ kind });
    expect(auth.cachedUser()).toEqual(USER);
  });

  test.each([401, 403])(
    "a %i update says the auth session ended, for the module to forget",
    async (status) => {
      const auth = await signedInClient("name-token");
      http.answer = () => json({ code: "UNAUTHORIZED" }, { status });
      expect(await auth.updateName(renamed)).toEqual({ kind: "ended", status });
      expect(auth.cachedUser()).toEqual(USER);
    },
  );

  test("a sign-out while the update is in flight leaves no identity behind", async () => {
    const auth = await signedInClient("name-token");
    const pending = Promise.withResolvers<Response>();
    http.answer = () => pending.promise;
    const saving = auth.updateName(renamed);
    await vi.waitFor(() => expect(http.sent.at(-1)?.url).toMatch(/update-user$/));
    auth.forget();
    pending.resolve(json({ status: true }));
    await saving;
    expect(auth.cachedUser()).toBeNull();
    expect(storedIdentity("nightly")).toBeNull();
  });
});
