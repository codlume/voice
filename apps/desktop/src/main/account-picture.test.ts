// Load the Electron mock before plugin storage.
import {
  USER,
  http,
  signedIn,
  client,
  config,
  signIn,
  snapshotAccount,
  writeCachedIdentity,
} from "./account-client.test-harness.ts";
import { expect, test, vi } from "vite-plus/test";
import { CODE, flush, harness, startSignIn } from "./account.test-harness.ts";

const PICTURE = "https://lh3.googleusercontent.com/a/ada-picture=s96-c";
const PICTURED = { ...USER, image: PICTURE };

test("a sign-in keeps the Google picture, encrypted, and an offline relaunch shows it", async () => {
  http.answer = (url) =>
    url.endsWith("/electron/token")
      ? signedIn("token-1", PICTURED)
      : Promise.reject(new TypeError("fetch failed"));
  expect(await signIn(client("nightly"))).toStrictEqual({ kind: "signedIn", user: PICTURED });
  expect(config()).not.toContain("ada-picture");

  const relaunched = snapshotAccount(client("nightly"));
  await relaunched.account.restore();
  expect(relaunched.states).toStrictEqual([{ kind: "signedIn", ...PICTURED }]);
  relaunched.account.dispose();
});

test.each([
  ["a null picture", null],
  ["a non-string picture", 42],
  ["an http picture", "http://lh3.googleusercontent.com/a/ada-picture=s96-c"],
  ["a data URL", "data:image/png;base64,iVBORw0KGgo="],
  ["a relative picture", "lh3.googleusercontent.com/a/ada-picture"],
  ["a picture on another host", "https://tracker.example/a/ada-picture=s96-c"],
  ["a host that only ends like Google's", "https://evilgoogleusercontent.com/a/ada-picture"],
])("%s signs in without a picture", async (_name, image) => {
  http.answer = () => signedIn("token-1", { ...USER, image });
  expect(await signIn(client("nightly"))).toStrictEqual({ kind: "signedIn", user: USER });
  expect(client("nightly").cachedUser()).toStrictEqual(USER);
});

test.each([
  ["gains", USER, PICTURED],
  ["loses", PICTURED, USER],
])(
  "an account that %s a picture since the cache was written shows the live one after the launch check",
  async (_name, cached, live) => {
    http.answer = () => signedIn("token-1");
    await client("nightly").checkAuthSession(new AbortController().signal);
    writeCachedIdentity(cached);

    http.answer = () => signedIn("token-1", live);
    const relaunched = snapshotAccount(client("nightly"));
    await relaunched.account.restore();
    expect(relaunched.states).toStrictEqual([
      { kind: "signedIn", ...cached },
      { kind: "signedIn", ...live },
    ]);
    expect(client("nightly").cachedUser()).toStrictEqual(live);
    relaunched.account.dispose();
  },
);

test("the picture stays on every signed-in state through deletion, re-authentication and cancel", async () => {
  vi.useFakeTimers();
  try {
    const h = harness();
    h.setUser(PICTURED);
    await startSignIn(h);
    const submitted = h.account.submitSignInCode(CODE);
    await flush();
    h.exchanges[0]?.resolve();
    await submitted;

    h.account.requestDeletion();
    const deleting = h.account.confirmDeletion();
    await flush();
    h.checks[0]?.answer({ kind: "active", user: PICTURED });
    await flush();
    h.fake.deletions[0]?.answer({ kind: "reauthRequired" });
    await deleting;
    const signingIn = h.account.signIn();
    await flush();
    h.requests.at(-1)?.resolve("state2");
    await signingIn;
    h.account.cancelSignIn();

    const signedInStates = h.states.filter((state) => state.kind === "signedIn");
    expect(signedInStates.map(({ deletion }) => deletion?.kind)).toEqual([
      undefined,
      "confirming",
      "deleting",
      "reauthRequired",
      undefined,
    ]);
    for (const state of signedInStates) expect(state.image).toBe(PICTURE);
    h.account.dispose();
  } finally {
    vi.useRealTimers();
  }
});
