// Runs the landing page's inline script against a stub DOM. The workerd tests
// cannot execute it, because Workers forbid eval.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { landingPage } from "../src/landing.ts";

const script = landingPage.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

function open(cookie) {
  const elements = {
    "signed-in": { hidden: true },
    expired: { hidden: true },
    code: { textContent: "" },
  };
  const calls = [];
  runInNewContext(script, {
    document: { cookie, getElementById: (id) => elements[id] },
    fetch: (url, init) => {
      // The init object comes from the page's realm, so copy it before comparing.
      calls.push({ fetch: url, init: structuredClone(init) });
      return Promise.resolve(new Response());
    },
    location: { replace: (url) => calls.push({ replace: url }) },
  });
  return { elements, calls };
}

test("shows the code, signs the browser out, then opens Voice with the code", () => {
  const code = "eyJpZGVudGlmaWVyIjoiYSIsInN0YXRlIjoiYiJ9%3D";
  const { elements, calls } = open(`better-auth.state=s; better-auth.electron=${code}; other=1`);

  assert.equal(elements.code.textContent, code);
  assert.equal(elements["signed-in"].hidden, false);
  assert.equal(elements.expired.hidden, true);
  assert.deepEqual(calls, [
    {
      fetch: "/api/auth/sign-out",
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        keepalive: true,
      },
    },
    { replace: `com.codlume.voice://auth/callback#token=${encodeURIComponent(code)}` },
  ]);
});

test("says the link expired when the electron cookie is gone", () => {
  const { elements, calls } = open("better-auth.session_token=t");

  assert.equal(elements.expired.hidden, false);
  assert.equal(elements["signed-in"].hidden, true);
  assert.deepEqual(calls, []);
});
