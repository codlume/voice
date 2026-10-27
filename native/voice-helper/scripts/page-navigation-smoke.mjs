import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { stopChildrenOnSignal } from "../../../scripts/voice-app.mjs";

import { chromeTarget } from "../../../scripts/targets.mjs";
import {
  assert,
  dictateFixture,
  prepareAsr,
  refuseIfVoiceIsRunning,
  withHelper,
} from "./helper.mjs";

refuseIfVoiceIsRunning();
stopChildrenOnSignal();

async function settle(read, expected, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (value !== expected && Date.now() < deadline) {
    await sleep(50);
    value = await read();
  }
  return value;
}

const userData = mkdtempSync(join(tmpdir(), "voice-page-navigation-"));
const target = await chromeTarget(userData);
try {
  await target.open();
  const firstUrl = await target.url();
  await target.navigate("location.href = location.pathname + '?page=2'");
  const secondUrl = await target.url();
  await withHelper({}, async (helper) => {
    await prepareAsr(helper);
    const id = "page-navigation";
    const text = `Voice page navigation ${randomUUID()}`;
    const from = helper.events.length;
    const baselineCaptured = () =>
      helper
        .eventsSince(from)
        .some((event) => event.type === "log" && event.message === "target focus captured");
    const capture = await dictateFixture(helper, "short.wav", id, "en", {
      onStarted: async () => {
        assert(await settle(baselineCaptured, true), "the focus baseline was not captured");
        // A two-finger swipe back arrives as scroll events, so the page changes with no counted
        // press. history.back() stands in for the swipe.
        await target.navigate("history.back()");
        const seen = await target.url();
        assert(seen === firstUrl, `target URL is ${JSON.stringify(seen)} after history.back()`);
      },
    });
    assert(capture.transcript.text.trim() !== "", "capture returned an empty transcript");
    helper.send({ type: "insert", id, text, html: null });
    const result = await helper.waitFor(
      (event) => event.type === "insert.result" && event.id === id,
      { label: "insert.result" },
    );
    assert(
      result.method === "none" && result.reason === "focusChanged",
      `insert.result method ${result.method} reason ${result.reason ?? ""}`,
    );
    const refusedByFocus = helper
      .eventsSince(from)
      .some(
        (event) => event.type === "log" && event.message === "insert refused: target focus changed",
      );
    assert(refusedByFocus, "the refusal did not come from the focus comparison");
    const landed = await target.read();
    assert(
      landed === "",
      `refused insert still wrote ${JSON.stringify(landed)} into the first page`,
    );
    console.log(
      JSON.stringify({
        from: secondUrl,
        to: firstUrl,
        method: result.method,
        reason: result.reason,
      }),
    );
  });
} finally {
  await target.close();
  rmSync(userData, { recursive: true, force: true });
}
