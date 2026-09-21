import { createServer } from "vite-plus";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import electron from "electron";
import { buildDesktop } from "./build-desktop.mjs";

await buildDesktop({ renderer: false });
const httpServer = createHttpServer((request, response) => server.middlewares(request, response));
const server = await createServer({
  configFile: "apps/desktop/vite.config.ts",
  server: { middlewareMode: true, hmr: { server: httpServer } },
});
let child;
let stopping;
async function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "exit");
      child.kill("SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
      try {
        await closed;
      } finally {
        clearTimeout(timeout);
      }
    }
    await server.close();
    if (httpServer.listening)
      await new Promise((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
  })();
  return stopping;
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
try {
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
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
  await once(child, "exit");
} finally {
  await stop();
}
