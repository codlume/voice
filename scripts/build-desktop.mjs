import { build } from "vite-plus";
import { builtinModules } from "node:module";
import { spawn } from "node:child_process";
import { mkdir, cp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function run(command, args, signal) {
  signal?.throwIfAborted();
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    let timeout;
    const cancel = () => {
      child.kill("SIGTERM");
      timeout ??= setTimeout(() => child.kill("SIGKILL"), 5_000);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    child.once("error", reject);
    child.once("close", (code, exitSignal) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      if (signal?.aborted) reject(signal.reason);
      else if (code === 0) resolveRun();
      else reject(new Error(`${command} failed: ${code ?? exitSignal}`));
    });
  });
}
export async function buildDesktop({ renderer = true, signal } = {}) {
  signal?.throwIfAborted();
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Desktop build requires Apple Silicon macOS");
  await run(
    "swift",
    ["build", "--package-path", "packages/platform/native", "-c", "release"],
    signal,
  );
  signal?.throwIfAborted();
  const output = resolve("apps/desktop/dist");
  await mkdir(`${output}/native`, { recursive: true });
  await cp("packages/platform/native/.build/release/voice-helper", `${output}/native/voice-helper`);
  await cp("packages/storage/migrations", `${output}/migrations`, { recursive: true });
  for (const [name, entry] of [
    ["main", "main/index.ts"],
    ["preload", "preload.ts"],
    ["storage-worker", "workers/storage.ts"],
    ["provider-worker", "workers/provider.ts"],
  ]) {
    signal?.throwIfAborted();
    await build({
      configFile: false,
      logLevel: "warn",
      // Desktop entry points must resolve Node exports, including the WebSocket transport.
      resolve: { conditions: ["node"], mainFields: ["module", "main"] },
      build: {
        target: "node24",
        outDir: `${output}/electron`,
        emptyOutDir: false,
        minify: false,
        lib: {
          entry: resolve(`apps/desktop/src/${entry}`),
          formats: ["cjs"],
          fileName: () => `${name}.cjs`,
        },
        rolldownOptions: {
          external: [
            "electron",
            ...builtinModules,
            ...builtinModules.map((module) => `node:${module}`),
          ],
        },
      },
    });
  }
  signal?.throwIfAborted();
  await writeFile(
    `${output}/package.json`,
    JSON.stringify({
      name: "voice-development",
      productName: "Voice Development",
      version: "0.0.0",
      main: "electron/main.cjs",
    }),
  );
  signal?.throwIfAborted();
  if (renderer) await build({ configFile: resolve("apps/desktop/vite.config.ts") });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildDesktop();
