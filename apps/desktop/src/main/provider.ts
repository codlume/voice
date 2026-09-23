import { Worker } from "node:worker_threads";
import {
  decodeProviderRequest,
  decodeProviderEvent,
  type ProviderRequest,
  type ProviderEvent,
  type Attempt,
} from "@voice/contracts/session";

// Each provider attempt runs in a fresh worker. A worker that crashes, exits, or sends an invalid
// message reports one `worker` failure for its attempt and is retired; only the session's next
// attempt, within its existing allowance and deadline, starts a replacement.
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
  // Reports the one failure of a still-current attempt and retires its worker.
  function failed(attempt: Attempt) {
    if (identity !== attempt) return;
    retire();
    receive({ type: "failed", ...attempt, reason: "worker" });
  }
  return {
    send(input: ProviderRequest) {
      const command = decodeProviderRequest(input);
      if (command.type === "start") {
        retire();
        const attempt = { session: command.session, attempt: command.attempt };
        identity = attempt;
        let current: Worker;
        try {
          current = new Worker(entry, { workerData: fixtureUrl ? { fixtureUrl } : {} });
        } catch {
          // Report asynchronously, as a crash would, so the session never re-enters itself.
          setImmediate(() => failed(attempt));
          return;
        }
        worker = current;
        const fail = () => {
          if (worker === current) failed(attempt);
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
    // Test hook: ends the running worker the way a crash would, without retiring it first.
    kill() {
      void worker?.terminate();
    },
    async close() {
      const old = worker;
      worker = undefined;
      identity = undefined;
      await old?.terminate();
    },
  };
}
