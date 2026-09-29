import { randomUUID } from "node:crypto";

import type { MicrophoneTest as MicrophoneTestState } from "../shared/api.ts";
import type { HelperCommand, HelperEvent } from "./protocol.ts";
import type { Store } from "./store.ts";

// A forgotten test must not keep the microphone open.
export const MICROPHONE_TEST_MAX_MS = 30_000;

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
  let cap: NodeJS.Timeout | null = null;

  function show(microphoneTest: MicrophoneTestState) {
    store.update((s) => ({ ...s, microphoneTest }));
  }

  function clear() {
    if (cap) clearTimeout(cap);
    cap = null;
    id = null;
  }

  function start() {
    if (id) return;
    id = randomUUID();
    cap = setTimeout(stop, MICROPHONE_TEST_MAX_MS);
    send({ type: "microphone.test.start", id, microphone: store.state.settings.microphone });
    show({ kind: "starting" });
  }

  function stop() {
    if (id) send({ type: "microphone.test.stop", id });
    clear();
    if (store.state.microphoneTest.kind !== "off") show({ kind: "off" });
  }

  function onHelperEvent(event: HelperEvent) {
    switch (event.type) {
      case "microphone.test.started":
        if (event.id === id) show({ kind: "listening" });
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
        show({ kind: "failed", message: event.message });
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
