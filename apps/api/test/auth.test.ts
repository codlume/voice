import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env, exports, waitUntil } from "cloudflare:workers";
import { betterAuth } from "better-auth";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createAuth } from "../src/auth.ts";
import entry from "../src/index.ts";
import { cookieHeader, playBrowser, storeCookies } from "./browser-play.ts";
import { fakeGoogleToken, googleTokenUrl } from "./google-fake.ts";

const base = "http://localhost:8787";
const appOrigin = "com.codlume.voice:/";

let nextIp = 1;
const freshIp = () => {
  const n = nextIp++;
  return `198.18.${n >> 8}.${n & 255}`;
};

/** Sends a request into the Worker from one client IP; `ip: null` sends none, as a proxyless client would. */
function worker(input: string | Request, init?: RequestInit, ip: string | null = freshIp()) {
  const request = new Request(input, init);
  if (ip !== null && !request.headers.has("cf-connecting-ip"))
    request.headers.set("cf-connecting-ip", ip);
  return exports.default.fetch(request);
}

const server = setupServer(
  // A fetch from the Worker to its own origin re-enters through Cloudflare, which stamps every such
  // request with one Worker-side address instead of the user's IP.
  http.all(`${base}/*`, ({ request }) => {
    const reentered = new Request(request.url, request);
    reentered.headers.set("cf-connecting-ip", "2a06:98c0:3600::103");
    return exports.default.fetch(reentered);
  }),
  http.post(googleTokenUrl, async ({ request }) =>
    HttpResponse.json(fakeGoogleToken(new URLSearchParams(await request.text()))),
  ),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => vi.useRealTimers());
afterAll(() => server.close());

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const startUrl = (state = crypto.randomUUID()) =>
  `${base}/api/auth/electron/init-oauth-proxy?provider=google&state=${state}&code_challenge=${base64Url(crypto.getRandomValues(new Uint8Array(32)))}&client_id=electron`;

type PlayOptions = Partial<Pick<Parameters<typeof playBrowser>[1], "signOut" | "secFetchSite">>;

/** Starts a sign-in as Voice would (PKCE), then plays the browser through /callback/google. */
async function playSignIn(googleCode: string, options: PlayOptions = {}) {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const state = crypto.randomUUID().replaceAll("-", "");
  const ip = freshIp();
  const flow = await playBrowser((url, init) => worker(url, init, ip), {
    base,
    initUrl: `${base}/api/auth/electron/init-oauth-proxy?provider=google&state=${state}&code_challenge=${challenge}&client_id=electron`,
    googleCode,
    signOut: false,
    ...options,
  });
  return { ...flow, ip, state, verifier };
}

/** A sign-in that must reach the landing page with an Electron code. */
async function browserSignIn(googleCode: string, options: PlayOptions = {}) {
  const flow = await playSignIn(googleCode, options);
  expect(flow.init.status).toBe(302);
  expect(flow.callback.status).toBe(302);
  expect(flow.callback.headers.get("location")).toBe(base);
  // The Electron code the callback left in its cookie, as the landing page reads it.
  const { identifier } = JSON.parse(
    atob(
      decodeURIComponent(flow.electronCookie ?? "")
        .replaceAll("-", "+")
        .replaceAll("_", "/"),
    ),
  ) as { identifier: string };
  return { ...flow, identifier };
}

type SignIn = Awaited<ReturnType<typeof browserSignIn>>;

function exchange(flow: SignIn, overrides: { state?: string; code_verifier?: string } = {}) {
  return worker(`${base}/api/auth/electron/token`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appOrigin },
    body: JSON.stringify({
      token: flow.identifier,
      state: flow.state,
      code_verifier: flow.verifier,
      ...overrides,
    }),
  });
}

type SignedIn = {
  token: string;
  user: { id: string; name: string; email: string; image: string | null };
};

async function getSession(cookie: string) {
  const response = await worker(`${base}/api/auth/get-session`, { headers: { cookie } });
  expect(response.status).toBe(200);
  return response.json<{ user: { id: string; email: string } } | null>();
}

const count = async (sql: string, ...bindings: string[]) =>
  (await env.DB.prepare(sql)
    .bind(...bindings)
    .first<number>("n")) ?? 0;

// Well past the grace period that keeps a first sign-in in flight, between its two writes, safe.
const age = (userId: string) =>
  env.DB.prepare("update user set created_at = created_at - ? where id = ?")
    .bind(2 * 60_000, userId)
    .run();

const rowsOf = async (userId: string) => ({
  users: await count("select count(*) as n from user where id = ?", userId),
  accounts: await count("select count(*) as n from account where user_id = ?", userId),
  sessions: await count("select count(*) as n from session where user_id = ?", userId),
});

/** Runs `action` while one D1 write fails, as it does when D1 drops mid-request. */
async function whileWriteFails<T>(
  write: "insert on account" | "delete on user",
  action: () => Promise<T>,
) {
  await env.DB.prepare(
    `create trigger fail_write before ${write} begin select raise(abort, 'synthetic D1 interruption'); end`,
  ).run();
  try {
    return await action();
  } finally {
    await env.DB.prepare("drop trigger fail_write").run();
  }
}

async function runSweep() {
  const ctx = createExecutionContext();
  await entry.scheduled(createScheduledController(), env, ctx);
  await waitOnExecutionContext(ctx);
}

const seedUserWithoutAccount = (id: string) =>
  env.DB.prepare("insert into user (id, name, email, updated_at) values (?, ?, ?, 0)")
    .bind(id, id, `${id}@example.com`)
    .run();

const seedSession = (id: string, userId: string, expiresAt: number) =>
  env.DB.prepare(
    "insert into session (id, token, user_id, expires_at, updated_at, ip_address, user_agent) values (?, ?, ?, ?, 0, '203.0.113.9', 'synthetic-agent')",
  )
    .bind(id, `${id}-token`, userId, expiresAt)
    .run();

const deleteUser = (cookie: string) =>
  worker(`${base}/api/auth/delete-user`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appOrigin, cookie },
    body: "{}",
  });

const signOut = (cookie: string) =>
  worker(`${base}/api/auth/sign-out`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: appOrigin, cookie },
    body: "{}",
  });

const bucketsOf = (ip: string) =>
  env.DB.prepare("select key, count from rate_limit where key like ? order by key")
    .bind(`${ip}|%`)
    .all<{ key: string; count: number }>()
    .then(({ results }) => results);

const overridden = <T extends object>(target: T, overrides: Partial<T>): T =>
  new Proxy(target, {
    get(object, property) {
      if (property in overrides) return overrides[property as keyof T];
      const value = Reflect.get(object, property);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });

const storedTokens = (userId: string) =>
  env.DB.prepare("select access_token, id_token from account where user_id = ?")
    .bind(userId)
    .first<{ access_token: string | null; id_token: string | null }>();

describe("Google sign-in", () => {
  it("creates one user and one account, then reuses them on a second sign-in (catches duplicate users or accounts per Google subject, or a sweep that deletes users with an account)", async () => {
    const first = await exchange(await browserSignIn("ada-lovelace"));
    expect(first.status).toBe(200);
    const { user } = await first.json<SignedIn>();
    expect(user).toMatchObject({ name: "Ada Lovelace", email: "ada-lovelace@example.com" });
    expect((await getSession(cookieHeader(storeCookies(first))))?.user.id).toBe(user.id);
    expect(await count("select count(*) as n from user where email = ?", user.email)).toBe(1);
    expect(await count("select count(*) as n from account where user_id = ?", user.id)).toBe(1);

    // Past the sweep's grace period: a user with an account is never swept.
    await age(user.id);
    const second = await exchange(await browserSignIn("ada-lovelace"));
    expect(second.status).toBe(200);
    expect((await second.json<SignedIn>()).user.id).toBe(user.id);
    expect(await count("select count(*) as n from user where email = ?", user.email)).toBe(1);
    expect(await count("select count(*) as n from account where user_id = ?", user.id)).toBe(1);
  });

  it("asks Google only for openid, email and profile and always prompts for the account (catches widened scopes or offline access)", async () => {
    const { google } = await browserSignIn("grace-hopper");

    expect(google.origin + google.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(google.searchParams.get("scope")?.split(" ").toSorted()).toEqual([
      "email",
      "openid",
      "profile",
    ]);
    expect(google.searchParams.get("prompt")).toBe("select_account");
    expect(google.searchParams.get("access_type")).toBeNull();
  });

  it("returns the Google picture as the user's image (catches a dropped picture claim)", async () => {
    const { user } = await (await exchange(await browserSignIn("grace-hopper"))).json<SignedIn>();
    expect(user.image).toBe("https://lh3.googleusercontent.com/a/default-user=s96-c");
  });

  it("stores the access token encrypted and no ID token, on the first and a repeat sign-in (catches plaintext OAuth tokens or a stored ID token in D1)", async () => {
    const { user } = await (await exchange(await browserSignIn("ida-wells"))).json<SignedIn>();

    const created = await storedTokens(user.id);
    expect(created?.access_token).toBeTruthy();
    expect(created?.access_token).not.toContain("fake-access");
    expect(created?.id_token).toBeNull();

    expect((await exchange(await browserSignIn("ida-wells"))).status).toBe(200);
    const updated = await storedTokens(user.id);
    // Encryption uses a random nonce, so new ciphertext proves the repeat sign-in rewrote the row.
    expect(updated?.access_token).not.toBe(created?.access_token);
    expect(updated?.access_token).not.toContain("fake-access");
    expect(updated?.id_token).toBeNull();
  });
});

describe("disabled sign-in paths", () => {
  it("do not route email and password (catches a re-enabled password sign-in or sign-up)", async () => {
    const credentials = JSON.stringify({
      name: "Mallory",
      email: "mallory@example.com",
      password: "correct horse battery staple",
    });
    const headers = { "content-type": "application/json" };

    const signUp = await worker(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers,
      body: credentials,
    });
    const signIn = await worker(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers,
      body: credentials,
    });

    expect(signUp.status).toBe(404);
    expect(signIn.status).toBe(404);
    expect(
      await count("select count(*) as n from user where email = ?", "mallory@example.com"),
    ).toBe(0);
  });

  it("do not route a direct social sign-in, so a Google ID token has no way in (catches re-enabled ID-token sign-in)", async () => {
    const idToken = fakeGoogleToken(
      new URLSearchParams({ code: "eve-intruder", client_id: env.GOOGLE_CLIENT_ID }),
    ).id_token;

    const response = await worker(`${base}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "google", idToken: { token: idToken } }),
    });

    expect(response.status).toBe(404);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(
      await count("select count(*) as n from user where email = ?", "eve-intruder@example.com"),
    ).toBe(0);
  });

  it("refuses another Google identity with the email of a user that has an account (catches account linking turned on)", async () => {
    const { user } = await (
      await exchange(await browserSignIn("mary-shelley", { signOut: true }))
    ).json<SignedIn>();

    const other = await playSignIn("mary-shelley/other-google-account");

    expect(other.callback.headers.get("location")).toContain("error=account_not_linked");
    expect(other.electronCookie).toBeNull();
    expect(await count("select count(*) as n from user where email = ?", user.email)).toBe(1);
    expect(await rowsOf(user.id)).toEqual({ users: 1, accounts: 1, sessions: 1 });
  });
});

describe("a user row with no account", () => {
  /** The user row a cut-off write left for `email`. */
  async function orphanOf(email: string) {
    const id = await env.DB.prepare("select id from user where email = ?")
      .bind(email)
      .first<string>("id");
    expect(id).not.toBeNull();
    expect(await rowsOf(id ?? "")).toEqual({ users: 1, accounts: 0, sessions: 0 });
    return id ?? "";
  }

  it("survives a callback request with no state and no cookie (catches the sweep back on the request path, where any client can make it scan the user table)", async () => {
    await seedUserWithoutAccount("junk-callback-orphan");
    await age("junk-callback-orphan");

    for (const provider of ["google", "not-a-provider"]) {
      const ip = freshIp();
      const response = await worker(
        `${base}/api/auth/callback/${provider}`,
        { redirect: "manual" },
        ip,
      );
      if (provider === "google") {
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toContain("error=state_not_found");
      } else {
        expect(response.status).toBe(404);
        expect(await bucketsOf(ip)).toEqual([]);
      }
    }

    expect(await rowsOf("junk-callback-orphan")).toEqual({ users: 1, accounts: 0, sessions: 0 });
  });

  it("is swept by the scheduled sweep, so a first sign-in that D1 cut off after the user row can start over (catches the lockout, and a sweep that takes a sign-in in flight)", async () => {
    const cutOff = await whileWriteFails("insert on account", () => playSignIn("cut-off-create"));
    expect(cutOff.callback.headers.get("location")).toContain("error=unable_to_create_user");
    expect(cutOff.electronCookie).toBeNull();
    const orphan = await orphanOf("cut-off-create@example.com");

    await runSweep();
    expect(await rowsOf(orphan)).toEqual({ users: 1, accounts: 0, sessions: 0 });
    const atOnce = await playSignIn("cut-off-create");
    expect(atOnce.callback.headers.get("location")).toContain("error=account_not_linked");
    expect(atOnce.electronCookie).toBeNull();

    // Google may have reported the email unverified the first time; the row must not stay for that.
    await env.DB.prepare("update user set email_verified = 0 where id = ?").bind(orphan).run();
    await age(orphan);
    await runSweep();
    expect(await rowsOf(orphan)).toEqual({ users: 0, accounts: 0, sessions: 0 });
    const retry = await exchange(await browserSignIn("cut-off-create", { signOut: true }));

    expect(retry.status).toBe(200);
    const { user } = await retry.json<SignedIn>();
    expect(user.email).toBe("cut-off-create@example.com");
    expect(user.id).not.toBe(orphan);
    expect(await count("select count(*) as n from user where email = ?", user.email)).toBe(1);
    expect(await rowsOf(user.id)).toEqual({ users: 1, accounts: 1, sessions: 1 });
  });

  it("is swept after a deletion D1 cut off before the user row, which completes the deletion (catches the same lockout after a failed delete-user)", async () => {
    const signedIn = await exchange(await browserSignIn("cut-off-delete", { signOut: true }));
    const { user } = await signedIn.json<SignedIn>();
    const cookie = cookieHeader(storeCookies(signedIn));
    const deletion = await whileWriteFails("delete on user", () => deleteUser(cookie));
    expect(deletion.status).toBe(500);
    expect(await rowsOf(user.id)).toEqual({ users: 1, accounts: 0, sessions: 0 });

    // The row is as old as the sign-up, which here was a moment ago.
    await age(user.id);
    await runSweep();
    expect(await rowsOf(user.id)).toEqual({ users: 0, accounts: 0, sessions: 0 });
    const retry = await exchange(await browserSignIn("cut-off-delete", { signOut: true }));

    expect(retry.status).toBe(200);
    const fresh = (await retry.json<SignedIn>()).user;
    expect(fresh.id).not.toBe(user.id);
    expect(await count("select count(*) as n from user where email = ?", user.email)).toBe(1);
    expect(await rowsOf(fresh.id)).toEqual({ users: 1, accounts: 1, sessions: 1 });
  });
});

describe("the scheduled sweep", () => {
  it("deletes expired sessions and keeps live ones, users with accounts and a sign-in in flight, and a second run changes nothing (catches a sweep that takes live rows, and expired sessions kept with their IP and user agent)", async () => {
    const signedIn = await exchange(await browserSignIn("sweep-live", { signOut: true }));
    const { user, token } = await signedIn.json<SignedIn>();
    await age(user.id);
    await seedSession("sweep-expired", user.id, Date.now() - 1000);
    await seedSession("sweep-live-later", user.id, Date.now() + 60_000);
    await seedUserWithoutAccount("sweep-in-flight");
    const sessionIds = () =>
      env.DB.prepare("select id from session where user_id = ?")
        .bind(user.id)
        .all<{ id: string }>()
        .then(({ results }) => results.map(({ id }) => id));
    expect(await sessionIds()).toHaveLength(3);

    for (let run = 0; run < 2; run++) {
      await runSweep();
      expect(await sessionIds()).not.toContain("sweep-expired");
      expect(await sessionIds()).toContain("sweep-live-later");
      expect(await count("select count(*) as n from session where token = ?", token)).toBe(1);
      expect(await rowsOf(user.id)).toEqual({ users: 1, accounts: 1, sessions: 2 });
      expect(await rowsOf("sweep-in-flight")).toEqual({ users: 1, accounts: 0, sessions: 0 });
    }
    expect((await getSession(cookieHeader(storeCookies(signedIn))))?.user.id).toBe(user.id);
  });

  it("finishes the other rule when one fails, and the next run completes the work (catches one failed delete ending the run or leaving the lockout for good)", async () => {
    await seedUserWithoutAccount("sweep-rule-fails");
    await age("sweep-rule-fails");
    await seedSession("sweep-rule-fails-expired", "sweep-rule-fails", Date.now() - 1000);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await whileWriteFails("delete on user", runSweep);
    } finally {
      consoleError.mockRestore();
    }

    expect(await rowsOf("sweep-rule-fails")).toEqual({ users: 1, accounts: 0, sessions: 0 });

    await runSweep();
    expect(await rowsOf("sweep-rule-fails")).toEqual({ users: 0, accounts: 0, sessions: 0 });
  });
});

describe("account-info", () => {
  it("is not served, even to a signed-in user (catches the route re-enabled while it can only fail without the ID token)", async () => {
    const signedIn = await exchange(await browserSignIn("account-info"));
    const cookie = cookieHeader(storeCookies(signedIn));
    const { user } = await signedIn.json<SignedIn>();
    const account = await env.DB.prepare("select id from account where user_id = ?")
      .bind(user.id)
      .first<{ id: string }>();
    expect(account?.id).toBeTruthy();

    for (const path of ["/api/auth/account-info", "/api/auth/account-info/"]) {
      const response = await worker(`${base}${path}?accountId=${account?.id}`, {
        headers: { cookie },
      });
      expect(response.status).toBe(404);
    }
  });
});

describe("origins", () => {
  const exchangeFrom = (origin: string, url = `${base}/api/auth/electron/token`) =>
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": freshIp(),
        // Better Auth checks the origin only when the request carries cookies, and the Electron client always sends them.
        cookie: "better-auth.session_token=none",
        origin,
      },
      body: JSON.stringify({ token: "unknown", state: "unknown", code_verifier: "unknown" }),
    });

  it("rejects an untrusted origin (catches a disabled or widened origin check)", async () => {
    expect((await worker(exchangeFrom("https://evil.example"))).status).toBe(403);
  });

  it("trust only the environment origin and the app scheme in production (catches localhost trusted outside local development)", async () => {
    const nightly = "https://api-nightly.voice.codlume.com";
    const auth = createAuth({ ...env, BETTER_AUTH_URL: nightly }, waitUntil);
    const from = (origin: string) => exchangeFrom(origin, `${nightly}/api/auth/electron/token`);

    expect((await auth.handler(from("http://localhost:8787"))).status).toBe(403);
    expect((await auth.handler(from("https://evil.example"))).status).toBe(403);
    expect((await auth.handler(from(appOrigin))).status).toBe(404);
    expect((await auth.handler(from(nightly))).status).toBe(404);
  });
});

describe("electron token exchange", () => {
  it("rejects a wrong verifier (catches a PKCE check that is skipped)", async () => {
    const flow = await browserSignIn("wrong-verifier");

    const response = await exchange(flow, { code_verifier: base64Url(new Uint8Array(32)) });

    expect(response.status).toBe(400);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("rejects a wrong state (catches a state check that is skipped)", async () => {
    const flow = await browserSignIn("wrong-state");

    const response = await exchange(flow, { state: "not-the-state" });

    expect(response.status).toBe(400);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("rejects a code that was already redeemed (catches a reusable code)", async () => {
    const flow = await browserSignIn("reused-code");
    expect((await exchange(flow)).status).toBe(200);

    const replay = await exchange(flow);

    expect(replay.status).toBe(404);
  });

  it("rejects a code older than 300 seconds, with the clock moved by fake timers (catches a code that never expires)", async () => {
    const flow = await browserSignIn("expired-code");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 301_000);

    const response = await exchange(flow);

    expect(response.status).toBe(404);
  });
});

describe("rate limiting", () => {
  const getSessionFrom = (ip: string | null, headers: Record<string, string> = {}) =>
    worker(`${base}/api/auth/get-session`, { headers }, ip);
  const limited = [...Array<number>(100).fill(200), 429];

  it("is on although NODE_ENV is unset, as on a real Worker (catches Better Auth's NODE_ENV default)", async () => {
    expect(process.env.NODE_ENV).toBeUndefined();
    const implicit = betterAuth({ baseURL: base, secret: env.BETTER_AUTH_SECRET });
    expect((await implicit.$context).rateLimit.enabled).toBe(false);
    expect((await createAuth(env, waitUntil).$context).rateLimit).toMatchObject({
      enabled: true,
      storage: "database",
    });

    const ip = freshIp();
    const statuses = [];
    for (let attempt = 0; attempt < limited.length; attempt++)
      statuses.push(await getSessionFrom(ip));

    expect(statuses.map((response) => response.status)).toEqual(limited);
    expect(statuses.at(-1)?.headers.get("X-Retry-After")).toMatch(/^\d+$/);
    expect((await getSessionFrom(freshIp())).status).toBe(200);
  });

  it("keys only on cf-connecting-ip (catches a spoofable x-forwarded-for key)", async () => {
    const statuses = [];
    for (let attempt = 0; attempt < limited.length; attempt++)
      statuses.push((await getSessionFrom(null, { "x-forwarded-for": freshIp() })).status);

    expect(statuses).toEqual(limited);
  });

  it("lets one IP start sign-in four times within 10 s (catches Better Auth's 3-per-10 s /sign-in rule turning the fourth init-oauth-proxy into a 500)", async () => {
    const ip = freshIp();
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await worker(startUrl(), { redirect: "manual" }, ip);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toMatch(/^https:\/\/accounts\.google\.com\//);
    }
  });

  it("keys sign-in starts on the user, not on one shared bucket (catches the electron plugin fetching the Worker's own /sign-in/social through Cloudflare)", async () => {
    const start = (ip: string) => worker(startUrl(), { redirect: "manual" }, ip);
    const crowd = freshIp();
    const statuses = new Set<number>();
    for (let attempt = 0; attempt < 100; attempt++) statuses.add((await start(crowd)).status);
    statuses.add((await start(freshIp())).status);

    expect([...statuses]).toEqual([302]);
  });

  it("answers a junk path with a 404 that mints no rate_limit row (catches a wildcard auth route in front of a limiter keyed on the raw path)", async () => {
    const ip = freshIp();
    const statuses = new Set<number>();
    for (let i = 0; i < 150; i++)
      statuses.add(
        (await worker(`${base}/api/auth/callback/x${i}`, { redirect: "manual" }, ip)).status,
      );
    for (let i = 0; i < 50; i++)
      statuses.add((await worker(`${base}/api/auth/nope-${i}`, { method: "POST" }, ip)).status);

    expect([...statuses]).toEqual([404]);
    expect(await bucketsOf(ip)).toEqual([]);
  });

  it("counts every spelling of a real path in its one bucket (catches a limit dodged by a provider id, percent-encoding, case or a trailing slash)", async () => {
    const ip = freshIp();
    const google = `${base}/api/auth/callback/google`;
    const manual = { redirect: "manual" } as const;
    expect((await worker(google, manual, ip)).status).toBe(302);
    for (const variant of [
      `${base}/api/auth/callback/goog%6ce`,
      `${base}/api/auth/callback/Google`,
      `${base}/api/auth/callback/google2`,
      `${base}/api/auth//callback/google`,
      `${google}/`,
    ])
      expect((await worker(variant, manual, ip)).status, variant).toBe(404);
    expect((await worker(`${google}?state=stale`, manual, ip)).status).toBe(302);

    expect(await bucketsOf(ip)).toEqual([{ key: `${ip}|/callback/google`, count: 2 }]);
  });

  it("answers before the expired rate_limit rows are pruned, and still prunes them (catches the prune awaited on the request path)", async () => {
    const prune = Promise.withResolvers<void>();
    const holdPrune = (statement: D1PreparedStatement): D1PreparedStatement =>
      overridden(statement, {
        bind: (...values) => holdPrune(statement.bind(...values)),
        run: async () => {
          await prune.promise;
          return statement.run();
        },
      });
    const db = overridden(env.DB, {
      prepare: (sql) =>
        sql.startsWith('delete from "rate_limit"')
          ? holdPrune(env.DB.prepare(sql))
          : env.DB.prepare(sql),
    });
    const background: Promise<unknown>[] = [];
    const auth = createAuth({ ...env, DB: db }, (task) => background.push(task));
    const ip = freshIp();
    const getSessionDirect = () =>
      auth.handler(
        new Request(`${base}/api/auth/get-session`, { headers: { "cf-connecting-ip": ip } }),
      );
    const staleRows = () =>
      count("select count(*) as n from rate_limit where key = ?", `${ip}|/stale`);
    await env.DB.prepare(
      "insert into rate_limit (id, key, count, last_request) values (?, ?, 1, ?)",
    )
      .bind(crypto.randomUUID(), `${ip}|/stale`, Date.now() - 120_000)
      .run();
    await getSessionDirect();
    // Past the 10 s window, so the next request takes Better Auth's reset-and-prune branch.
    await env.DB.prepare("update rate_limit set last_request = last_request - ? where key = ?")
      .bind(20_000, `${ip}|/get-session`)
      .run();
    expect(await staleRows()).toBe(1);

    expect((await getSessionDirect()).status).toBe(200);
    expect(await staleRows()).toBe(1);

    prune.resolve();
    await Promise.all(background);
    expect(await staleRows()).toBe(0);
  });
});

const fromPage = (secFetchSite: string) =>
  ({ redirect: "manual", headers: { "sec-fetch-site": secFetchSite } }) as const;

const cookieNames = (response: Response) =>
  response.headers.getSetCookie().map((line) => line.split("=")[0]);

describe("a sign-in start that a web page opened", () => {
  const codesMinted = () =>
    count("select count(*) as n from verification where identifier like 'electron:%'");

  it("is sent to the landing page's start-in-voice state before Better Auth sees it, with one log line that names the header and not the state (catches a missing gate, one behind the limiter, or a log that quotes the query)", async () => {
    const rows = () => count("select count(*) as n from verification");
    const before = await rows();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      for (const secFetchSite of ["cross-site", "same-site", "same-origin"]) {
        const ip = freshIp();
        const state = crypto.randomUUID();
        log.mockClear();
        const response = await worker(startUrl(state), fromPage(secFetchSite), ip);

        expect(response.status, secFetchSite).toBe(302);
        expect(response.headers.get("location")).toBe("/#start-in-voice");
        expect(response.headers.getSetCookie()).toEqual([]);
        expect(await bucketsOf(ip)).toEqual([]);
        const printed = log.mock.calls.map((call) => call.join(" "));
        expect(printed).toHaveLength(1);
        expect(JSON.parse(printed[0] ?? "")).toEqual({
          requestId: expect.any(String),
          route: "/api/auth/electron/init-oauth-proxy",
          status: 302,
          refused: "sec-fetch-site",
          secFetchSite,
        });
        expect(printed[0]).not.toContain(state);
      }
    } finally {
      log.mockRestore();
    }
    expect(await rows()).toBe(before);
  });

  it("does not consume the IP's own sign-in bucket (catches a gate that answers after the limiter counted the request)", async () => {
    const ip = freshIp();
    for (let attempt = 0; attempt < 100; attempt++)
      expect((await worker(startUrl(), fromPage("cross-site"), ip)).headers.get("location")).toBe(
        "/#start-in-voice",
      );
    const own = await worker(startUrl(), fromPage("none"), ip);

    expect(own.status).toBe(302);
    expect(own.headers.get("location")).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(await bucketsOf(ip)).toEqual([{ key: `${ip}|/electron/init-oauth-proxy`, count: 1 }]);
  });

  it("is not routed as a POST, so a page's cross-site form or no-cors fetch takes no step in the IP's bucket (catches a gate that covers only GET while the auth route still accepts POST)", async () => {
    const ip = freshIp();
    const response = await worker(
      startUrl(),
      { method: "POST", redirect: "manual", headers: { "sec-fetch-site": "cross-site" } },
      ip,
    );

    expect(response.status).toBe(404);
    expect(await bucketsOf(ip)).toEqual([]);
  });

  it("logs an unexpected header value as other, so the log stays one of four values (catches a client-chosen string written to the log)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await worker(startUrl(), fromPage("x".repeat(500)));
      expect(JSON.parse(String(log.mock.calls[0]?.[0])).secFetchSite).toBe("other");
    } finally {
      log.mockRestore();
    }
  });

  it("completes a sign-in whose browser sends no Fetch Metadata, as older browsers and header-less clients do (catches a gate that refuses a missing header)", async () => {
    const flow = await browserSignIn("no-fetch-metadata", {
      secFetchSite: { init: null, callback: null },
    });

    expect((await exchange(flow)).status).toBe(200);
  });

  it("cannot be finished by another browser: a start made elsewhere leaves the victim's callback with no code (pins the state cookie binding a callback to the browser that started the sign-in)", async () => {
    const before = await codesMinted();
    const attacker = await worker(startUrl(), { redirect: "manual" });
    expect(attacker.status).toBe(302);
    const google = new URL(attacker.headers.get("location") ?? "about:blank");

    const victim = await worker(
      `${base}/api/auth/callback/google?code=victim-google-account&state=${google.searchParams.get("state")}`,
      fromPage("cross-site"),
    );

    expect(victim.status).toBe(302);
    expect(victim.headers.get("location")).toContain(`${base}/?error=`);
    expect(cookieNames(victim)).not.toContain("better-auth.electron");
    expect(await codesMinted()).toBe(before);
  });
});

describe("a sign-in Google did not finish", () => {
  it("sends the browser to the landing page with the error code, so the user sees Voice's own page (catches Better Auth's unstyled developer error page with its better-auth.com links)", async () => {
    const ip = freshIp();
    const start = await worker(startUrl(), { redirect: "manual" }, ip);
    const google = new URL(start.headers.get("location") ?? "about:blank");

    const cancelled = await worker(
      `${base}/api/auth/callback/google?error=access_denied&state=${google.searchParams.get("state")}`,
      { headers: { cookie: cookieHeader(storeCookies(start)) }, redirect: "manual" },
      ip,
    );

    expect(cancelled.status).toBe(302);
    expect(cancelled.headers.get("location")).toBe(`${base}/?error=access_denied`);
    expect(cookieNames(cancelled)).not.toContain("better-auth.electron");
  });
});

describe("browser auth session", () => {
  it("ends after the landing page signs it out, and the app's exchange still works (catches a 60-day browser session left behind)", async () => {
    const flow = await browserSignIn("browser-session", { signOut: true });
    expect(
      flow.callback.headers.getSetCookie().some((c) => c.startsWith("better-auth.session_token=")),
    ).toBe(true);
    expect(flow.landing?.status).toBe(200);
    expect(flow.signOut?.status).toBe(200);
    expect(flow.browserSessionAfterSignOut).toBeNull();
    expect(await getSession(cookieHeader(flow.jar))).toBeNull();

    const response = await exchange(flow);
    expect(response.status).toBe(200);
    const { user } = await response.json<SignedIn>();
    expect(user.email).toBe("browser-session@example.com");
    expect(await count("select count(*) as n from session where user_id = ?", user.id)).toBe(1);
  });
});

describe("logs", () => {
  it("never print request data, however Better Auth phrases its own errors (catches an email, code or state in Workers Logs)", async () => {
    const markers = {
      email: "review-synthetic-private@example.com",
      code: "fake-code-9f3c2a7b1d",
      state: "fake-state-5e8d1c4a",
    };
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    try {
      const params = new URLSearchParams({
        error: markers.email,
        code: markers.code,
        state: markers.state,
      });
      const response = await worker(`${base}/api/auth/callback/google?${params}`, {
        headers: { cookie: `better-auth.state=${markers.state}` },
        redirect: "manual",
      });
      expect(response.status).toBeGreaterThanOrEqual(300);

      const printed = spies.flatMap((spy) => spy.mock.calls.map((call) => call.join(" ")));
      expect(printed.length).toBeGreaterThan(0);
      for (const line of printed) {
        for (const marker of Object.values(markers)) expect(line).not.toContain(marker);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("revoked auth session", () => {
  it("is rejected on the next request, and get-session answers null (catches a cached session that outlives its revocation, and pins the answer the desktop reads as ended)", async () => {
    const revoked = await exchange(await browserSignIn("revoked-session"));
    const { user } = await revoked.json<SignedIn>();
    const revokedCookie = cookieHeader(storeCookies(revoked));
    const other = cookieHeader(
      storeCookies(await exchange(await browserSignIn("revoked-session"))),
    );
    expect((await getSession(revokedCookie))?.user.id).toBe(user.id);

    await createAuth(env, waitUntil).api.revokeOtherSessions({ headers: { cookie: other } });

    const next = await worker(`${base}/api/auth/get-session`, {
      headers: { cookie: revokedCookie },
    });
    expect(next.status).toBe(200);
    expect(await next.json()).toBeNull();
    expect(next.headers.getSetCookie().join("\n")).toMatch(/better-auth\.session_token=;/);
    expect((await deleteUser(revokedCookie)).status).toBe(401);
    expect((await getSession(other))?.user.id).toBe(user.id);
  });
});

describe("sign out", () => {
  it("rejects the old app session and returns null for its old cookie, including a repeated sign-out", async () => {
    const response = await exchange(await browserSignIn("sign-out-session", { signOut: true }));
    const { user, token } = await response.json<SignedIn>();
    const cookie = cookieHeader(storeCookies(response));
    expect((await getSession(cookie))?.user.id).toBe(user.id);

    expect(await (await signOut(cookie)).json()).toEqual({ success: true });
    expect(await count("select count(*) as n from session where token = ?", token)).toBe(0);
    expect(await getSession(cookie)).toBeNull();
    expect((await deleteUser(cookie)).status).toBe(401);
    expect(await (await signOut(cookie)).json()).toEqual({ success: true });
    expect(await getSession(cookie)).toBeNull();
  });
});

describe("account deletion", () => {
  it("refuses deletion at the ten-minute freshness boundary and preserves the account", async () => {
    const response = await exchange(await browserSignIn("stale-deletion", { signOut: true }));
    const { user } = await response.json<SignedIn>();
    const cookie = cookieHeader(storeCookies(response));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 600_000);

    const refused = await deleteUser(cookie);

    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: "SESSION_EXPIRED" });
    expect((await getSession(cookie))?.user.id).toBe(user.id);
    expect(await count("select count(*) as n from user where id = ?", user.id)).toBe(1);
    expect(await count("select count(*) as n from session where user_id = ?", user.id)).toBe(1);
    expect(await count("select count(*) as n from account where user_id = ?", user.id)).toBe(1);
  });

  it("deletes a fresh account, every auth session, and its linked Google account", async () => {
    const first = await exchange(await browserSignIn("fresh-deletion", { signOut: true }));
    const { user } = await first.json<SignedIn>();
    const oldCookie = cookieHeader(storeCookies(first));
    const second = await exchange(await browserSignIn("fresh-deletion", { signOut: true }));
    const currentCookie = cookieHeader(storeCookies(second));
    expect(await count("select count(*) as n from session where user_id = ?", user.id)).toBe(2);

    const deleted = await deleteUser(currentCookie);

    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ success: true, message: "User deleted" });
    expect(await count("select count(*) as n from user where id = ?", user.id)).toBe(0);
    expect(await count("select count(*) as n from session where user_id = ?", user.id)).toBe(0);
    expect(await count("select count(*) as n from account where user_id = ?", user.id)).toBe(0);
    expect(await getSession(oldCookie)).toBeNull();
    expect(await getSession(currentCookie)).toBeNull();

    const queued = await signOut(oldCookie);
    expect(queued.status).toBe(200);
    expect(await queued.json()).toEqual({ success: true });
    expect(await getSession(oldCookie)).toBeNull();
    expect(await count("select count(*) as n from user where id = ?", user.id)).toBe(0);
    expect(await count("select count(*) as n from session where user_id = ?", user.id)).toBe(0);
    expect(await count("select count(*) as n from account where user_id = ?", user.id)).toBe(0);
  });

  it("creates a new user when the deleted Google account signs in again", async () => {
    const first = await exchange(await browserSignIn("new-after-deletion", { signOut: true }));
    const previous = await first.json<SignedIn>();
    expect((await deleteUser(cookieHeader(storeCookies(first)))).status).toBe(200);

    const next = await exchange(await browserSignIn("new-after-deletion", { signOut: true }));
    expect(next.status).toBe(200);
    const { user } = await next.json<SignedIn>();
    expect(user.id).not.toBe(previous.user.id);
    expect(user.email).toBe(previous.user.email);
    expect(await count("select count(*) as n from user where email = ?", user.email)).toBe(1);
    expect(await count("select count(*) as n from account where user_id = ?", user.id)).toBe(1);
    expect(await count("select count(*) as n from session where user_id = ?", user.id)).toBe(1);
    expect(await count("select count(*) as n from user where id = ?", previous.user.id)).toBe(0);
  });

  it("signs out an older device credential at the freshness boundary while leaving the new sign-in active", async () => {
    const first = await exchange(await browserSignIn("old-device", { signOut: true }));
    const { user } = await first.json<SignedIn>();
    const oldCookie = cookieHeader(storeCookies(first));
    const next = await exchange(await browserSignIn("new-device-account", { signOut: true }));
    const currentCookie = cookieHeader(storeCookies(next));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 600_000);

    const revoked = await signOut(oldCookie);

    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ success: true });
    expect(await getSession(oldCookie)).toBeNull();
    expect(await count("select count(*) as n from session where user_id = ?", user.id)).toBe(0);
    expect(await getSession(currentCookie)).not.toBeNull();
    expect(await count("select count(*) as n from user where id = ?", user.id)).toBe(1);
  });
});

describe("names", () => {
  type Named = { name: string; firstName: string; lastName: string };
  const namesOf = async (cookie: string) => {
    const response = await worker(`${base}/api/auth/get-session`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const { user } = await response.json<{ user: Named }>();
    return { name: user.name, firstName: user.firstName, lastName: user.lastName };
  };
  const signInCookie = async (googleCode: string) =>
    cookieHeader(storeCookies(await exchange(await browserSignIn(googleCode, { signOut: true }))));
  const updateUser = (cookie: string | null, body: unknown) =>
    worker(`${base}/api/auth/update-user`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: appOrigin,
        ...(cookie && { cookie }),
      },
      body: JSON.stringify(body),
    });

  it.each([
    ["jean-paul-sartre", { name: "Jean Paul Sartre", firstName: "Jean Paul", lastName: "Sartre" }],
    ["mary-ann-evans", { name: "Mary Ann Evans", firstName: "Mary", lastName: "Ann Evans" }],
  ])(
    "takes a new %s's first and last name from Google, splitting the full name when Google sends no parts (catches a sign-up with empty names)",
    async (googleCode, names) => {
      expect(await namesOf(await signInCookie(googleCode))).toEqual(names);
    },
  );

  it("renames the user, derives the full name, and keeps the edit through the next sign-in (catches a rename the server drops, or Google overwriting it)", async () => {
    const cookie = await signInCookie("rename-me");
    const updated = await updateUser(cookie, { firstName: "  Ada ", lastName: " King Lovelace " });
    expect(updated.status).toBe(200);
    const renamed = { name: "Ada King Lovelace", firstName: "Ada", lastName: "King Lovelace" };
    expect(await namesOf(cookie)).toEqual(renamed);

    expect(await namesOf(await signInCookie("rename-me"))).toEqual(renamed);
  });

  it("accepts an empty last name, so a mononym has no trailing space (catches a required last name)", async () => {
    const cookie = await signInCookie("mononym");
    expect((await updateUser(cookie, { firstName: "Plato", lastName: "" })).status).toBe(200);
    expect(await namesOf(cookie)).toEqual({ name: "Plato", firstName: "Plato", lastName: "" });
  });

  it("refuses an empty first name, a missing or overlong name, and any other field, leaving the user unchanged (catches update-user writing any field the client sends)", async () => {
    const cookie = await signInCookie("refused-rename");
    const before = await namesOf(cookie);
    const refusals = [
      { firstName: "   ", lastName: "Lovelace" },
      { firstName: "Ada" },
      { firstName: 1, lastName: "Lovelace" },
      { firstName: "A".repeat(101), lastName: "Lovelace" },
      { firstName: "Ada", lastName: "L".repeat(101) },
      { firstName: "Ada", lastName: "Lovelace", image: "https://example.com/a.png" },
      { firstName: "Ada", lastName: "Lovelace", name: "Someone Else" },
      { firstName: "Ada", lastName: "Lovelace", email: "other@example.com" },
    ];
    for (const body of refusals) {
      expect((await updateUser(cookie, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await namesOf(cookie)).toEqual(before);
    const stored = await env.DB.prepare("select image, email from user where email = ?")
      .bind("refused-rename@example.com")
      .first();
    expect(stored).toEqual({ image: null, email: "refused-rename@example.com" });
  });

  it("refuses an update without an auth session (catches update-user open to anyone)", async () => {
    const refused = await updateUser(null, { firstName: "Ada", lastName: "Lovelace" });
    expect(refused.status).toBe(401);
  });
});
