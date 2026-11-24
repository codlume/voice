import { randomUUID } from "node:crypto";

import type { MicrophoneTest as MicrophoneTestState } from "../shared/api.ts";
import { START_TIMEOUT_MS } from "./dictation.ts";
import type { HelperCommand, HelperEvent } from "./protocol.ts";
import type { Store } from "./store.ts";

export const MICROPHONE_TEST_MAX_MS = 30_000;

type FailureReason = Extract<HelperEvent, { type: "microphone.test.failed" }>["reason"];

const FAILURE_MESSAGES: Record<FailureReason, string> = {
  permission:
    "Voice does not have microphone access. Turn it on in System Settings > Privacy & Security > Microphone, then test again.",
  device:
    "Voice could not open this microphone. Choose another microphone, or check that it is connected.",
  busy: "Finish dictating, then test again.",
  unknown: "The microphone test failed. Test again, or choose another microphone.",
};

export type MicrophoneTest = {
  start(): void;
  stop(): void;
  onHelperEvent(event: HelperEvent): void;
  helperExited(): void;
};

export function createMicrophoneTest(options: {
  store: Store;
  send: (command: HelperCommand) => void;
  onLevel: (level: number) => void;
}): MicrophoneTest {
  const { store, send, onLevel } = options;
  let id: string | null = null;
  let deadline: NodeJS.Timeout | null = null;
  let episode = 0;

  function show(microphoneTest: MicrophoneTestState) {
    store.update((s) => ({ ...s, microphoneTest }));
  }

  function arm(ms: number, expire: () => void) {
    if (deadline) clearTimeout(deadline);
    deadline = setTimeout(expire, ms);
  }

  function clear() {
    if (deadline) clearTimeout(deadline);
    deadline = null;
    id = null;
  }

  function start() {
    if (id) return;
    id = randomUUID();
    arm(START_TIMEOUT_MS, startTimedOut);
    send({ type: "microphone.test.start", id, microphone: store.state.settings.microphone });
    show({ kind: "starting" });
  }

  function stop() {
    if (id) send({ type: "microphone.test.stop", id });
    clear();
    if (store.state.microphoneTest.kind !== "off") show({ kind: "off" });
  }

  function startTimedOut() {
    if (id) send({ type: "microphone.test.stop", id });
    clear();
    show({ kind: "failed", message: "Voice could not start the microphone. Test again." });
  }

  function onHelperEvent(event: HelperEvent) {
    switch (event.type) {
      case "microphone.test.started":
        if (event.id !== id) return;
        if (store.state.microphoneTest.kind === "starting") arm(MICROPHONE_TEST_MAX_MS, stop);
        show({ kind: "listening", episode: ++episode });
        return;
      case "microphone.test.level":
        if (event.id === id) onLevel(event.level);
        return;
      case "microphone.test.ended":
        if (event.id !== id) return;
        clear();
        show({ kind: "off" });
        return;
      case "microphone.test.failed":
        if (event.id !== id) return;
        clear();
        show({ kind: "failed", message: FAILURE_MESSAGES[event.reason] });
        return;
    }
  }

  function helperExited() {
    if (!id) return;
    clear();
    show({
      kind: "failed",
      message: "The microphone test stopped while Voice reconnected. Test again.",
    });
  }

  return { start, stop, onHelperEvent, helperExited };
}
