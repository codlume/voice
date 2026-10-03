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

import { playBrowser } from "../test/browser-play.ts";

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

let initUrl = args["init-url"];
let verifier;
if (!initUrl) {
  verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");
  initUrl = `${base}/api/auth/electron/init-oauth-proxy?provider=google&state=${state}&code_challenge=${challenge}&client_id=electron`;
}

const flow = await playBrowser(fetch, { base, initUrl, googleCode: args.code, signOut: true });
const { google, callback, landing, electronCookie } = flow;
const steps = {
  init: { status: flow.init.status, location: google.origin + google.pathname },
  callback: { status: callback.status, location: callback.headers.get("location") },
  landing: {
    status: landing.status,
    contentSecurityPolicy: landing.headers.get("content-security-policy"),
  },
  signOut: { status: flow.signOut.status },
  browserSessionAfterSignOut: flow.browserSessionAfterSignOut,
};

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
  flow.init.status === 302 &&
  google.origin === "https://accounts.google.com" &&
  callback.status === 302 &&
  electronCookie !== null &&
  landing.status === 200 &&
  flow.signOut.status === 200 &&
  steps.browserSessionAfterSignOut === null &&
  (steps.exchange === undefined || steps.exchange.status === 200);

console.log(JSON.stringify({ ok, steps, electronCookie }, null, 2));
process.exit(ok ? 0 : 1);
