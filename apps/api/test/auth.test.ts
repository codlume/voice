import { env, exports } from "cloudflare:workers";
import { betterAuth } from "better-auth";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createAuth } from "../src/auth.ts";
import { cookieHeader, playBrowser, storeCookies } from "./browser-play.ts";
import { fakeGoogleToken, googleTokenUrl } from "./google-fake.ts";

const base = "http://localhost:8787";
const appOrigin = "com.codlume.voice:/";

let nextIp = 1;
const freshIp = () => `198.51.100.${nextIp++}`;

/** Sends a request into the Worker from one client IP; `ip: null` sends none, as a proxyless client would. */
function worker(input: string | Request, init?: RequestInit, ip: string | null = freshIp()) {
  const request = new Request(input, init);
  if (ip !== null && !request.headers.has("cf-connecting-ip"))
    request.headers.set("cf-connecting-ip", ip);
  return exports.default.fetch(request);
}

const server = setupServer(
  // init-oauth-proxy calls /sign-in/social on its own base URL. Route that request back into the Worker.
  http.all(`${base}/*`, ({ request }) => worker(request.url, request)),
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

/** Starts a sign-in as Voice would (PKCE), then plays the browser through /callback/google. */
async function playSignIn(googleCode: string, options = { signOut: false }) {
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
    ...options,
  });
  return { ...flow, ip, state, verifier };
}

/** A sign-in that must reach the landing page with an Electron code. */
async function browserSignIn(googleCode: string, options = { signOut: false }) {
  const flow = await playSignIn(googleCode, options);
  expect(flow.init.status).toBe(302);
  expect(flow.callback.status).toBe(302);
  expect(flow.callback.headers.get("location")).toBe(base);
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

type SignedIn = { token: string; user: { id: string; name: string; email: string } };

async function getSession(cookie: string) {
  const response = await worker(`${base}/api/auth/get-session`, { headers: { cookie } });
  expect(response.status).toBe(200);
  return response.json<{ user: { id: string; email: string } } | null>();
}

const count = async (sql: string, ...bindings: string[]) =>
  (await env.DB.prepare(sql)
    .bind(...bindings)
    .first<number>("n")) ?? 0;

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

describe("Google sign-in", () => {
  it("creates one user and one account, then reuses them on a second sign-in (catches duplicate users or accounts per Google subject)", async () => {
    const first = await exchange(await browserSignIn("ada-lovelace"));
    expect(first.status).toBe(200);
    const { user } = await first.json<SignedIn>();
    expect(user).toMatchObject({ name: "Ada Lovelace", email: "ada-lovelace@example.com" });
    expect((await getSession(cookieHeader(storeCookies(first))))?.user.id).toBe(user.id);
    expect(await count("select count(*) as n from user where email = ?", user.email)).toBe(1);
    expect(await count("select count(*) as n from account where user_id = ?", user.id)).toBe(1);

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

  it("stores Google's tokens encrypted (catches plaintext OAuth tokens in D1)", async () => {
    const response = await exchange(await browserSignIn("ida-wells"));
    const { user } = await response.json<SignedIn>();

    const row = await env.DB.prepare("select access_token from account where user_id = ?")
      .bind(user.id)
      .first<{ access_token: string }>();
    expect(row?.access_token).toBeTruthy();
    expect(row?.access_token).not.toContain("fake-access");
  });
});

describe("disabled sign-in paths", () => {
  it("reject email and password (catches a re-enabled password sign-in or sign-up)", async () => {
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

    expect(signUp.status).toBe(400);
    expect(await signUp.json()).toMatchObject({ code: "EMAIL_PASSWORD_SIGN_UP_DISABLED" });
    expect(signIn.status).toBe(400);
    expect(await signIn.json()).toMatchObject({ code: "EMAIL_PASSWORD_DISABLED" });
    expect(
      await count("select count(*) as n from user where email = ?", "mallory@example.com"),
    ).toBe(0);
  });

  it("reject a Google ID token (catches re-enabled ID-token sign-in)", async () => {
    const idToken = fakeGoogleToken(
      new URLSearchParams({ code: "eve-intruder", client_id: env.GOOGLE_CLIENT_ID }),
    ).id_token;

    const response = await worker(`${base}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "google", idToken: { token: idToken } }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "ID_TOKEN_NOT_SUPPORTED" });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(
      await count("select count(*) as n from user where email = ?", "eve-intruder@example.com"),
    ).toBe(0);
  });
});

describe("a user row with no account", () => {
  // Better Auth writes the user row and then the account row, and deletes the account rows and
  // then the user row. D1 cannot make either pair one transaction, so a cut-off in between
  // leaves a user row every later Google sign-in for that email trips over.

  /** The user row a cut-off write left for `email`. */
  async function orphanOf(email: string) {
    const id = await env.DB.prepare("select id from user where email = ?")
      .bind(email)
      .first<string>("id");
    expect(id).not.toBeNull();
    expect(await rowsOf(id ?? "")).toEqual({ users: 1, accounts: 0, sessions: 0 });
    return id ?? "";
  }

  // Well past the grace period that keeps a first sign-in in flight, between its two writes, safe.
  const age = (userId: string) =>
    env.DB.prepare("update user set created_at = created_at - ? where id = ?")
      .bind(2 * 60_000, userId)
      .run();

  const deleteUser = (cookie: string) =>
    worker(`${base}/api/auth/delete-user`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: appOrigin, cookie },
      body: "{}",
    });

  it("is swept by a later Google callback, so a first sign-in that D1 cut off after the user row can start over (catches the lockout, and a sweep that takes a sign-in in flight)", async () => {
    const cutOff = await whileWriteFails("insert on account", () => playSignIn("cut-off-create"));
    expect(cutOff.callback.headers.get("location")).toContain("error=unable_to_create_user");
    expect(cutOff.electronCookie).toBeNull();
    const orphan = await orphanOf("cut-off-create@example.com");

    const atOnce = await playSignIn("cut-off-create");
    expect(atOnce.electronCookie).toBeNull();
    expect(await rowsOf(orphan)).toEqual({ users: 1, accounts: 0, sessions: 0 });

    // Google may have reported the email unverified the first time; the row must not stay for that.
    await env.DB.prepare("update user set email_verified = 0 where id = ?").bind(orphan).run();
    await age(orphan);
    const retry = await exchange(await browserSignIn("cut-off-create", { signOut: true }));

    expect(retry.status).toBe(200);
    const { user } = await retry.json<SignedIn>();
    expect(user.email).toBe("cut-off-create@example.com");
    expect(user.id).not.toBe(orphan);
    expect(await rowsOf(orphan)).toEqual({ users: 0, accounts: 0, sessions: 0 });
    expect(await count("select count(*) as n from user where email = ?", user.email)).toBe(1);
    expect(await rowsOf(user.id)).toEqual({ users: 1, accounts: 1, sessions: 1 });
  });

  it("is swept after a deletion D1 cut off before the user row, which completes the deletion (catches the same lockout after a failed delete-user)", async () => {
    const signedIn = await exchange(await browserSignIn("cut-off-delete", { signOut: true }));
    const { user } = await signedIn.json<SignedIn>();
    const deletion = await whileWriteFails("delete on user", () =>
      deleteUser(cookieHeader(storeCookies(signedIn))),
    );
    expect(deletion.status).toBe(500);
    expect(await rowsOf(user.id)).toEqual({ users: 1, accounts: 0, sessions: 0 });

    // The row is as old as the sign-up, which here was a moment ago.
    await age(user.id);
    const retry = await exchange(await browserSignIn("cut-off-delete", { signOut: true }));

    expect(retry.status).toBe(200);
    const fresh = (await retry.json<SignedIn>()).user;
    expect(fresh.id).not.toBe(user.id);
    expect(await rowsOf(user.id)).toEqual({ users: 0, accounts: 0, sessions: 0 });
    expect(await count("select count(*) as n from user where email = ?", user.email)).toBe(1);
    expect(await rowsOf(fresh.id)).toEqual({ users: 1, accounts: 1, sessions: 1 });
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
    const auth = createAuth({ ...env, BETTER_AUTH_URL: nightly });
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
  const signInSocial = (headers: Record<string, string>, ip: string | null = null) =>
    worker(
      `${base}/api/auth/sign-in/social`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ provider: "google" }),
      },
      ip,
    );

  it("is on although NODE_ENV is unset, as on a real Worker (catches Better Auth's NODE_ENV default)", async () => {
    expect(process.env.NODE_ENV).toBeUndefined();
    const implicit = betterAuth({ baseURL: base, secret: env.BETTER_AUTH_SECRET });
    expect((await implicit.$context).rateLimit.enabled).toBe(false);
    expect((await createAuth(env).$context).rateLimit).toMatchObject({
      enabled: true,
      storage: "database",
    });

    const ip = freshIp();
    const statuses = [];
    for (let attempt = 0; attempt < 4; attempt++) statuses.push(await signInSocial({}, ip));

    expect(statuses.map((response) => response.status)).toEqual([200, 200, 200, 429]);
    expect(statuses[3]?.headers.get("X-Retry-After")).toMatch(/^\d+$/);
    expect((await signInSocial({}, freshIp())).status).toBe(200);
  });

  it("keys only on cf-connecting-ip (catches a spoofable x-forwarded-for key)", async () => {
    const statuses = [];
    for (let attempt = 0; attempt < 4; attempt++)
      statuses.push((await signInSocial({ "x-forwarded-for": freshIp() })).status);

    expect(statuses).toEqual([200, 200, 200, 429]);
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
