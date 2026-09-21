import { parentPort, workerData } from "node:worker_threads";
import { Schema } from "effect";
import { startStream } from "@voice/providers/stream";
import { decodeProviderRequest, decodeProviderEvent, type Attempt } from "@voice/contracts/session";
const options = Schema.decodeUnknownSync(
  Schema.Struct({ fixtureUrl: Schema.optionalKey(Schema.String) }),
  { onExcessProperty: "error" },
)(workerData);
if (!parentPort) throw new Error("Provider worker needs a parent");
const port = parentPort;
let stream: ReturnType<typeof startStream> | undefined;
let identity: Attempt | undefined;
port.on("message", (payload: unknown) => {
  try {
    const command = decodeProviderRequest(payload);
    if (command.type === "start") {
      stream?.cancel();
      identity = { session: command.session, attempt: command.attempt };
      stream = startStream(
        command,
        (event) => port.postMessage(decodeProviderEvent(event)),
        options.fixtureUrl,
      );
    } else if (identity?.session === command.session && identity.attempt === command.attempt) {
      if (command.type === "audio") stream?.audio(command.sequence, command.pcm);
      else if (command.type === "stop") stream?.stop(command.frames, command.samples);
      else {
        stream?.cancel();
        stream = undefined;
        identity = undefined;
      }
    }
  } catch {
    stream?.cancel();
    if (identity) port.postMessage({ type: "failed", ...identity, reason: "protocol" });
    stream = undefined;
    identity = undefined;
  }
});
port.on("close", () => stream?.cancel());
