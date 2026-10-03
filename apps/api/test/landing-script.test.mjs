// Runs the landing page's inline script against a stub DOM. The workerd tests
// cannot execute it, because Workers forbid eval.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { landingPage } from "../src/landing.ts";

const script = landingPage.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

function open(cookie, { clipboard = () => Promise.resolve() } = {}) {
  const listeners = {};
  const elements = {
    "signed-in": { hidden: true },
    expired: { hidden: true },
    open: { href: "" },
    code: { textContent: "" },
    copy: {
      textContent: "Copy",
      addEventListener: (type, listener) => (listeners[type] = listener),
    },
  };
  const calls = [];
  const selected = [];
  runInNewContext(script, {
    document: { cookie, getElementById: (id) => elements[id] },
    navigator: { clipboard: { writeText: (text) => (calls.push({ copy: text }), clipboard()) } },
    getSelection: () => ({ selectAllChildren: (node) => selected.push(node) }),
    fetch: (url, init) => {
      // The init object comes from the page's realm, so copy it before comparing.
      calls.push({ fetch: url, init: structuredClone(init) });
      return Promise.resolve(new Response());
    },
    location: { replace: (url) => calls.push({ replace: url }) },
  });
  const clickCopy = async () => {
    listeners.click();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { elements, calls, selected, clickCopy };
}

const code = "eyJpZGVudGlmaWVyIjoiYSIsInN0YXRlIjoiYiJ9%3D";
const cookie = `better-auth.state=s; better-auth.electron=${code}; other=1`;
// The cookie serializer already percent-encoded the value, so the fragment carries it as is.
const callbackUrl = `com.codlume.voice://auth/callback#token=${code}`;

test("signs the browser out, then opens Voice with the code", () => {
  const { elements, calls } = open(cookie);

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
    { replace: callbackUrl },
  ]);
});

test("the Open Voice button links to the same callback URL", () => {
  const { elements } = open(cookie);

  assert.equal(elements.open.href, callbackUrl);
});

test("Copy puts the code on the clipboard, or selects it when the browser refuses", async () => {
  const copied = open(cookie);
  await copied.clickCopy();
  assert.deepEqual(copied.calls.at(-1), { copy: code });
  assert.equal(copied.elements.copy.textContent, "Copied");

  const refused = open(cookie, { clipboard: () => Promise.reject(new Error("denied")) });
  await refused.clickCopy();
  assert.equal(refused.elements.copy.textContent, "Copy");
  assert.deepEqual(refused.selected, [refused.elements.code]);
});

test("says the link expired when the electron cookie is gone", () => {
  const { elements, calls } = open("better-auth.session_token=t");

  assert.equal(elements.expired.hidden, false);
  assert.equal(elements["signed-in"].hidden, true);
  assert.equal(elements.open.href, "");
  assert.deepEqual(calls, []);
});
