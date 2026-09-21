import { createServer } from "vite-plus";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import electron from "electron";
import { buildDesktop } from "./build-desktop.mjs";

const startup = new AbortController();
let server;
const httpServer = createHttpServer((request, response) => server.middlewares(request, response));
const sockets = new Set();
httpServer.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});
let child;
let stopping;
async function stopApp() {
  if (stopping) return stopping;
  stopping = (async () => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
      try {
        await closed;
      } finally {
        clearTimeout(timeout);
      }
    }
  })();
  return stopping;
}
function cancel() {
  startup.abort();
  void stopApp();
}
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
try {
  await buildDesktop({ renderer: false, signal: startup.signal });
  startup.signal.throwIfAborted();
  server = await createServer({
    configFile: "apps/desktop/vite.config.ts",
    server: { middlewareMode: true, hmr: { server: httpServer } },
  });
  startup.signal.throwIfAborted();
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  startup.signal.throwIfAborted();
  const address = httpServer.address();
  if (!address || typeof address === "string")
    throw new Error("Renderer server has no ready address");
  const url = `http://127.0.0.1:${address.port}/`;
  const env = { ...process.env, VOICE_DEV_URL: url };
  delete env.ELECTRON_RUN_AS_NODE;
  const testArgument = process.argv.find((argument) => argument.startsWith("--voice-test-data="));
  child = spawn(electron, ["apps/desktop/dist", ...(testArgument ? [testArgument] : [])], {
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    env,
  });
  child.on("message", (message) => {
    if (message.type === "ready") {
      console.log("Voice ready. Renderer, storage and native helper are connected.");
      process.send?.({ ...message, url });
    } else if (message.type === "startup-failed") {
      console.error("Voice startup failed. Inspect Settings for the failed service.");
    }
  });
  const [code] = await once(child, "exit");
  if (!startup.signal.aborted && code !== 0) process.exitCode = 1;
} catch (error) {
  if (!startup.signal.aborted) {
    console.error(error);
    process.exitCode = 1;
  }
} finally {
  await stopApp();
  await server?.close();
  for (const socket of sockets) socket.destroy();
  if (httpServer.listening)
    await new Promise((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  process.disconnect?.();
  // Vite retains internal handles after middleware shutdown. All owned resources are closed above.
  process.exit(process.exitCode ?? 0);
}
