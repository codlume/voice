import { parentPort, workerData } from "node:worker_threads";
import { openSettings } from "@voice/storage/settings";
import {
  decodeWorkerOptions,
  decodeWorkerRequest,
  type WorkerEvent,
} from "@voice/contracts/worker";

const port = parentPort;
if (!port) throw new Error("Storage requires a worker port");
const send = (event: typeof WorkerEvent.Type) => port.postMessage(event);
async function start() {
  const store = await openSettings(decodeWorkerOptions(workerData));
  let queue = Promise.resolve();
  port!.on("message", (payload: unknown) => {
    queue = queue
      .then(async () => {
        const request = decodeWorkerRequest(payload);
        if (request.type === "close") {
          await store.close();
          send({ type: "closed", id: request.id });
          port!.close();
        } else {
          send({ type: "result", id: request.id, settings: await store.set(request.settings) });
        }
      })
      .catch(async () => {
        send({ type: "failed" });
        await store.close();
        port!.close();
      });
  });
  send({ type: "ready", settings: await store.get() });
}
start().catch(() => {
  send({ type: "failed" });
  port.close();
});
