import { build } from "vite-plus";
import { builtinModules } from "node:module";
import { spawn } from "node:child_process";
import { mkdir, cp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? resolveRun() : reject(new Error(`${command} failed: ${code ?? signal}`)),
    );
  });
}
export async function buildDesktop({ renderer = true } = {}) {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Desktop build requires Apple Silicon macOS");
  await run("swift", ["build", "--package-path", "packages/platform/native", "-c", "release"]);
  const output = resolve("apps/desktop/dist");
  await mkdir(`${output}/native`, { recursive: true });
  await cp("packages/platform/native/.build/release/voice-helper", `${output}/native/voice-helper`);
  await cp("packages/storage/migrations", `${output}/migrations`, { recursive: true });
  for (const [name, entry] of [
    ["main", "main/index.ts"],
    ["preload", "preload.ts"],
    ["storage-worker", "workers/storage.ts"],
  ]) {
    await build({
      configFile: false,
      logLevel: "warn",
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
  await writeFile(
    `${output}/package.json`,
    JSON.stringify({
      name: "voice-development",
      productName: "Voice Development",
      version: "0.0.0",
      main: "electron/main.cjs",
    }),
  );
  if (renderer) await build({ configFile: resolve("apps/desktop/vite.config.ts") });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildDesktop();
