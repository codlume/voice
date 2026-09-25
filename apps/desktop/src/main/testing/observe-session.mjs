#!/usr/bin/env node
// Drives one dictation session through the fake helper's control socket and records the
// pill page's snapshot sequence over CDP. Run the app first:
//   VOICE_HELPER_PATH=src/main/testing/fake-helper.ts \
//   VOICE_FAKE_HELPER='{"control":"/tmp/voice-fake.sock"}' \
//   pnpm dev -- --remote-debugging-port=9333
// then: node src/main/testing/observe-session.mjs 9333 /tmp/voice-fake.sock down:900,up
// Steps are "action[:waitMs]" pairs sent to the fake helper: down, up, cancel, or exit.
import { connect } from "node:net";

const [port = "9333", control = "/tmp/voice-fake.sock", script = "down:900,up"] =
  process.argv.slice(2);
const steps = script.split(",").map((step) => {
  const [action, wait = "0"] = step.split(":");
  return { action, wait: Number(wait) };
});

async function pillTarget() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const pill = targets.find((t) => t.type === "page" && t.url.includes("pill"));
      if (pill) return pill;
    } catch {
      // Electron is not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("pill page not found over CDP");
}

const target = await pillTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message.result);
    pending.delete(message.id);
  }
});
function evaluate(expression) {
  const id = nextId++;
  ws.send(
    JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: { expression, returnByValue: true, awaitPromise: true },
    }),
  );
  return new Promise((resolve) => pending.set(id, (result) => resolve(result.result.value)));
}

await evaluate(`
  window.__seq = [];
  window.__unsubscribe?.();
  window.__unsubscribe = window.voice.onSnapshot((s) => window.__seq.push({ at: Date.now(), kind: s.session.kind, outcome: s.session.outcome?.kind ?? null }));
  window.voice.getSnapshot().then((s) => window.__seq.push({ at: Date.now(), kind: s.session.kind, outcome: null, initial: true }));
  "recording"
`);
await new Promise((resolve) => setTimeout(resolve, 300));

// A control path of "-" means no fake helper: only report the snapshot the real helper produced.
const t0 = Date.now();
if (control !== "-") {
  const socket = connect(control);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  for (const { action, wait } of steps) {
    socket.write(`${action}\n`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  await new Promise((resolve) => setTimeout(resolve, 3500));
  socket.end();
}

const status = await evaluate(
  "window.voice.getSnapshot().then((s) => JSON.stringify({ permissions: s.permissions, models: s.models, last: s.last }))",
);
console.log(`snapshot ${status}`);
const seq = await evaluate("JSON.stringify(window.__seq)");
for (const entry of JSON.parse(seq)) {
  const outcome = entry.outcome ? `(${entry.outcome})` : "";
  console.log(
    `${String(entry.at - t0).padStart(6)} ms  ${entry.kind}${outcome}${entry.initial ? "  [initial]" : ""}`,
  );
}
ws.close();
