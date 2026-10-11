import assert from "node:assert/strict";
import { test } from "node:test";
import { openLanding as open } from "./landing-harness.ts";

const code = "eyJpZGVudGlmaWVyIjoiYSIsInN0YXRlIjoiYiJ9%3D";
const cookie = `better-auth.state=s; better-auth.electron=${code}; other=1`;
// The cookie serializer already percent-encoded the value, so the fragment carries it as is.
const callbackUrl = `com.codlume.voice://auth/callback#token=${code}`;
const signOut = {
  fetch: "/api/auth/sign-out",
  init: {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    keepalive: true,
  },
};
const shown = (elements) => Object.keys(elements).filter((id) => elements[id].hidden === false);

test("signs the browser out, then opens Voice with the code", () => {
  const { elements, calls } = open(cookie);

  assert.equal(elements.code.textContent, code);
  assert.deepEqual(shown(elements), ["signed-in"]);
  assert.deepEqual(calls, [signOut, { replace: callbackUrl }]);
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

  assert.deepEqual(shown(elements), ["expired"]);
  assert.equal(elements.open.href, "");
  assert.deepEqual(calls, []);
});

test("tells a refused start to begin from Voice, and neither shows a leftover code nor opens Voice with it", () => {
  const { elements, calls } = open(cookie, { hash: "#start-in-voice" });

  assert.deepEqual(shown(elements), ["start-in-voice"]);
  assert.equal(elements.code.textContent, "");
  assert.equal(elements.open.href, "");
  assert.deepEqual(calls, [signOut]);
});

test("keeps the code off a phone or tablet, and still signs the browser out", () => {
  for (const device of [
    { platform: "iPhone" },
    { platform: "Linux armv8l", userAgentData: { platform: "Android" } },
    // iPadOS Safari reports itself as a Mac, with touch points.
    { platform: "MacIntel", maxTouchPoints: 5 },
  ]) {
    const { elements, calls } = open(cookie, device);
    const label = JSON.stringify(device);

    assert.deepEqual(shown(elements), ["not-desktop"], label);
    assert.equal(elements.code.textContent, "", label);
    assert.equal(elements.open.href, "", label);
    assert.deepEqual(calls, [signOut], label);
  }
});

test("opens Voice on Windows and on macOS, whichever platform API the browser offers", () => {
  for (const device of [
    { platform: "Win32" },
    { platform: "Win32", userAgentData: { platform: "Windows" } },
    { platform: "MacIntel", userAgentData: { platform: "macOS" } },
    { platform: "MacIntel", userAgentData: { platform: "" } },
    { platform: "MacIntel", userAgentData: { platform: "Unknown" } },
    { platform: "Win32", maxTouchPoints: 10 },
  ]) {
    const { elements, calls } = open(cookie, device);
    const label = JSON.stringify(device);

    assert.deepEqual(shown(elements), ["signed-in"], label);
    assert.equal(elements.code.textContent, code, label);
    assert.equal(elements.open.href, callbackUrl, label);
    assert.deepEqual(calls, [signOut, { replace: callbackUrl }], label);
  }
});
