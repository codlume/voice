import { env, exports } from "cloudflare:workers";
import { betterAuth } from "better-auth";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createAuth } from "../src/auth.ts";
import { fakeGoogleToken, googleTokenUrl } from "./google-fake.ts";

const base = "http://localhost:8787";
const appOrigin = "com.codlume.voice:/";

let nextIp = 1;
const freshIp = () => `198.51.100.${nextIp++}`;

function worker(input: string | Request, init?: RequestInit, ip = freshIp()) {
  const request = new Request(input, init);
  if (!request.headers.has("cf-connecting-ip")) request.headers.set("cf-connecting-ip", ip);
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

type Jar = Map<string, string>;

function store(response: Response, jar: Jar = new Map()) {
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";")[0] ?? "";
    const at = pair.indexOf("=");
    const value = pair.slice(at + 1);
    if (value) jar.set(pair.slice(0, at), value);
    else jar.delete(pair.slice(0, at));
  }
  return jar;
}

const cookieHeader = (jar: Jar) => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

/** Plays the system browser from init-oauth-proxy through /callback/google. */
async function browserSignIn(googleCode: string) {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const state = crypto.randomUUID().replaceAll("-", "");
  const ip = freshIp();
  const init = await worker(
    `${base}/api/auth/electron/init-oauth-proxy?provider=google&state=${state}&code_challenge=${challenge}&client_id=electron`,
    { redirect: "manual" },
    ip,
  );
  expect(init.status).toBe(302);
  const google = new URL(init.headers.get("location") ?? "");
  const jar = store(init);
  const callback = await worker(
    `${base}/api/auth/callback/google?code=${googleCode}&state=${google.searchParams.get("state")}`,
    { headers: { cookie: cookieHeader(jar) }, redirect: "manual" },
    ip,
  );
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe(base);
  store(callback, jar);
  const code = jar.get("better-auth.electron") ?? "";
  const { identifier } = JSON.parse(
    atob(decodeURIComponent(code).replaceAll("-", "+").replaceAll("_", "/")),
  ) as {
    identifier: string;
  };
  return { google, jar, ip, identifier, state, verifier };
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

describe("Google sign-in", () => {
  it("creates one user and one account, then reuses them on a second sign-in (catches duplicate users or accounts per Google subject)", async () => {
    const first = await exchange(await browserSignIn("ada-lovelace"));
    expect(first.status).toBe(200);
    const { user } = await first.json<SignedIn>();
    expect(user).toMatchObject({ name: "Ada Lovelace", email: "ada-lovelace@example.com" });
    expect((await getSession(cookieHeader(store(first))))?.user.id).toBe(user.id);
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

  it("keep account linking off (catches linking turned on; no HTTP path shows it with one provider)", async () => {
    const context = await createAuth(env).$context;

    expect(context.options.account?.accountLinking?.enabled).toBe(false);
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
  const signInSocial = (headers: Record<string, string>) =>
    exports.default.fetch(
      new Request(`${base}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ provider: "google" }),
      }),
    );

  it("is on although NODE_ENV is unset, as on a real Worker (catches Better Auth's NODE_ENV default)", async () => {
    expect(process.env.NODE_ENV).toBeUndefined();
    const implicit = betterAuth({ baseURL: base, secret: env.BETTER_AUTH_SECRET });
    expect((await implicit.$context).rateLimit.enabled).toBe(false);
    expect((await createAuth(env).$context).rateLimit).toMatchObject({
      enabled: true,
      storage: "database",
    });

    const ip = { "cf-connecting-ip": freshIp() };
    const statuses = [];
    for (let attempt = 0; attempt < 4; attempt++) statuses.push(await signInSocial(ip));

    expect(statuses.map((response) => response.status)).toEqual([200, 200, 200, 429]);
    expect(statuses[3]?.headers.get("X-Retry-After")).toMatch(/^\d+$/);
    expect((await signInSocial({ "cf-connecting-ip": freshIp() })).status).toBe(200);
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
    const flow = await browserSignIn("browser-session");
    expect(flow.jar.has("better-auth.session_token")).toBe(true);

    const signOut = await worker(
      `${base}/api/auth/sign-out`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: base,
          cookie: cookieHeader(flow.jar),
        },
        body: "{}",
      },
      flow.ip,
    );
    expect(signOut.status).toBe(200);
    expect(await getSession(cookieHeader(flow.jar))).toBeNull();

    const response = await exchange(flow);
    expect(response.status).toBe(200);
    const { user } = await response.json<SignedIn>();
    expect(user.email).toBe("browser-session@example.com");
    expect(await count("select count(*) as n from session where user_id = ?", user.id)).toBe(1);
  });
});
