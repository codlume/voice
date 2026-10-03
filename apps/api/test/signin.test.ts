import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { setupServer } from "msw/node";
import { http } from "msw";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { googleTokenHandler, tokenRequests } from "./google-fake";

const BASE = "http://localhost:8787";
const worker = (input: string | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  if (!request.headers.has("cf-connecting-ip"))
    request.headers.set("cf-connecting-ip", "203.0.113.7");
  return exports.default.fetch(request);
};

// The init-oauth-proxy route calls its own origin. Route that self-request back into the Worker.
const server = setupServer(
  http.all(`${BASE}/*`, ({ request }) => worker(request)),
  googleTokenHandler({ sub: "google-sub-1", email: "ada@example.com", name: "Ada Lovelace" }),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const pkce = async () => {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  return { verifier, challenge, state: crypto.randomUUID().replaceAll("-", "") };
};
const cookieJar = (res: Response, jar = new Map<string, string>()) => {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const i = pair.indexOf("=");
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return jar;
};
const cookieHeader = (jar: Map<string, string>) =>
  [...jar]
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

async function browserSignIn() {
  const { verifier, challenge, state } = await pkce();
  const init = await worker(
    `${BASE}/api/auth/electron/init-oauth-proxy?provider=google&state=${state}&code_challenge=${challenge}&client_id=electron`,
    { redirect: "manual" },
  );
  expect(init.status).toBe(302);
  const google = new URL(init.headers.get("location")!);
  expect(google.origin).toBe("https://accounts.google.com");
  const jar = cookieJar(init);
  const callback = await worker(
    `${BASE}/api/auth/callback/google?code=fake-code&state=${google.searchParams.get("state")}`,
    {
      headers: { cookie: cookieHeader(jar) },
      redirect: "manual",
    },
  );
  cookieJar(callback, jar);
  return { verifier, state, google, callback, electronCookie: jar.get("better-auth.electron") };
}

it("signs up with Google, exchanges the electron code, and reads the auth session from D1", async () => {
  const flow = await browserSignIn();
  expect(flow.google.searchParams.get("scope")).toBe("email profile openid");
  expect(flow.google.searchParams.get("prompt")).toBe("select_account");
  expect(flow.callback.status).toBe(302);
  expect(flow.electronCookie).toBeTruthy();

  const decoded = JSON.parse(
    atob(decodeURIComponent(flow.electronCookie!).replaceAll("-", "+").replaceAll("_", "/")),
  );
  expect(decoded.state).toBe(flow.state);

  const exchange = await worker(`${BASE}/api/auth/electron/token`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "com.codlume.voice:/" },
    body: JSON.stringify({
      token: decoded.identifier,
      state: decoded.state,
      code_verifier: flow.verifier,
    }),
  });
  expect(exchange.status).toBe(200);
  const { token, user } = await exchange.json<{ token: string; user: { email: string } }>();
  expect(user.email).toBe("ada@example.com");

  const session = await worker(`${BASE}/api/auth/get-session`, {
    headers: { authorization: `Bearer ${token}`, cookie: cookieHeader(cookieJar(exchange)) },
  });
  expect((await session.json<{ user: { email: string } }>()).user.email).toBe("ada@example.com");

  const counts = await env.DB.batch(
    ["user", "account", "session"].map((t) => env.DB.prepare(`select count(*) as n from ${t}`)),
  );
  // One auth session for the system browser (set by /callback/google), one for the app (from /electron/token).
  expect(counts.map((r) => (r.results[0] as { n: number }).n)).toEqual([1, 1, 2]);
  expect(
    flow.callback.headers.getSetCookie().some((c) => c.startsWith("better-auth.session_token=")),
  ).toBe(true);
  const account = await env.DB.prepare("select access_token from account").first<{
    access_token: string;
  }>();
  expect(account?.access_token).not.toBe("fake-access");
  expect(tokenRequests.at(-1)?.get("code_verifier")).toBeTruthy();

  const rateRows = await env.DB.prepare("select count(*) as n from rate_limit").first<{
    n: number;
  }>();
  console.log("rate_limit rows after sign-in:", rateRows?.n);

  const again = await browserSignIn();
  expect(again.electronCookie).toBeTruthy();
  const users = await env.DB.prepare("select count(*) as n from user").first<{ n: number }>();
  expect(users?.n).toBe(1);
});

it("rejects the exchange with a wrong verifier and a reused code", async () => {
  const flow = await browserSignIn();
  const decoded = JSON.parse(
    atob(decodeURIComponent(flow.electronCookie!).replaceAll("-", "+").replaceAll("_", "/")),
  );
  const post = (verifier: string) =>
    worker(`${BASE}/api/auth/electron/token`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "com.codlume.voice:/" },
      body: JSON.stringify({
        token: decoded.identifier,
        state: decoded.state,
        code_verifier: verifier,
      }),
    });
  const wrong = await post("not-the-verifier-not-the-verifier-not-the-verifier");
  expect(wrong.status).toBe(400);
  const reused = await post(flow.verifier);
  expect(reused.status).toBe(404);
});
