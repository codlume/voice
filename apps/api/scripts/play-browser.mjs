#!/usr/bin/env node
// Plays the system browser against a Worker whose Google is faked (pnpm dev:verify):
// init-oauth-proxy, the Google callback, the landing page and its sign-out.
// Prints JSON with each step's status and the code Voice receives.
//
//   node scripts/play-browser.mjs --base http://localhost:8787 --code ada-lovelace
//     Generates its own PKCE pair and also redeems the code, as Voice would.
//   node scripts/play-browser.mjs --base <url> --init-url <url Voice opened> --code ada-lovelace
//     Continues a sign-in Voice started. Voice holds the verifier and redeems the code.
import { createHash, randomBytes } from "node:crypto";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: { base: { type: "string" }, "init-url": { type: "string" }, code: { type: "string" } },
});
if (!args.base || !args.code) {
  console.error(
    "usage: play-browser.mjs --base <url> --code <fake Google code> [--init-url <url>]",
  );
  process.exit(2);
}
const base = new URL(args.base).origin;

const jar = new Map();
const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
async function browse(path, init = {}) {
  const response = await fetch(new URL(path, base), {
    ...init,
    redirect: "manual",
    headers: jar.size > 0 ? { ...init.headers, cookie: cookieHeader() } : init.headers,
  });
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";")[0];
    const at = pair.indexOf("=");
    if (at + 1 < pair.length) jar.set(pair.slice(0, at), pair.slice(at + 1));
    else jar.delete(pair.slice(0, at));
  }
  return response;
}

let initUrl = args["init-url"];
let verifier;
if (!initUrl) {
  verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");
  initUrl = `/api/auth/electron/init-oauth-proxy?provider=google&state=${state}&code_challenge=${challenge}&client_id=electron`;
}

const steps = {};
const init = await browse(initUrl);
const google = new URL(init.headers.get("location") ?? "about:blank");
steps.init = { status: init.status, location: google.origin + google.pathname };

const callback = await browse(
  `/api/auth/callback/google?code=${encodeURIComponent(args.code)}&state=${google.searchParams.get("state")}`,
);
steps.callback = { status: callback.status, location: callback.headers.get("location") };
const electronCookie = jar.get("better-auth.electron") ?? null;

const landing = await browse("/");
steps.landing = {
  status: landing.status,
  contentSecurityPolicy: landing.headers.get("content-security-policy"),
};

// What the landing page's script does before it opens Voice.
const signOut = await browse("/api/auth/sign-out", {
  method: "POST",
  headers: { "content-type": "application/json", origin: base },
  body: "{}",
});
steps.signOut = { status: signOut.status };
const browserSession = await browse("/api/auth/get-session");
steps.browserSessionAfterSignOut = await browserSession.json();

if (verifier && electronCookie) {
  const { identifier, state } = JSON.parse(
    Buffer.from(decodeURIComponent(electronCookie), "base64url").toString(),
  );
  const exchange = await fetch(new URL("/api/auth/electron/token", base), {
    method: "POST",
    headers: { "content-type": "application/json", origin: "com.codlume.voice:/" },
    body: JSON.stringify({ token: identifier, state, code_verifier: verifier }),
  });
  const body = await exchange.json();
  steps.exchange = { status: exchange.status, user: body.user ?? null, error: body.code ?? null };
}

const ok =
  init.status === 302 &&
  google.origin === "https://accounts.google.com" &&
  callback.status === 302 &&
  electronCookie !== null &&
  landing.status === 200 &&
  signOut.status === 200 &&
  steps.browserSessionAfterSignOut === null &&
  (steps.exchange === undefined || steps.exchange.status === 200);

console.log(JSON.stringify({ ok, steps, electronCookie }, null, 2));
process.exit(ok ? 0 : 1);
