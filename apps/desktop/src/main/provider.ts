import { Worker } from "node:worker_threads";
import {
  decodeProviderRequest,
  decodeProviderEvent,
  type ProviderRequest,
  type ProviderEvent,
  type Attempt,
} from "@voice/contracts/session";

export function createProvider(
  entry: string,
  receive: (event: ProviderEvent) => void,
  fixtureUrl?: string,
) {
  let worker: Worker | undefined;
  let identity: Attempt | undefined;
  function retire() {
    const old = worker;
    worker = undefined;
    identity = undefined;
    if (old) void old.terminate();
  }
  return {
    send(input: ProviderRequest) {
      const command = decodeProviderRequest(input);
      if (command.type === "start") {
        retire();
        identity = { session: command.session, attempt: command.attempt };
        const current = new Worker(entry, { workerData: fixtureUrl ? { fixtureUrl } : {} });
        worker = current;
        const fail = () => {
          if (worker !== current || !identity) return;
          const event: ProviderEvent = { type: "failed", ...identity, reason: "worker" };
          retire();
          receive(event);
        };
        current.on("message", (payload: unknown) => {
          if (worker !== current) return;
          try {
            receive(decodeProviderEvent(payload));
          } catch {
            fail();
          }
        });
        current.on("error", fail);
        current.on("exit", fail);
      }
      if (command.type === "cancel") {
        retire();
        return;
      }
      // This is a Node worker port, not a browser Window.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      worker?.postMessage(command);
    },
    async close() {
      const old = worker;
      worker = undefined;
      identity = undefined;
      await old?.terminate();
    },
  };
}
