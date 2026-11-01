import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const vp = fileURLToPath(import.meta.resolve("vite-plus/bin"));
const desktop = "apps/desktop/src";
const restrictedImports = "eslint(no-restricted-imports)";
const noRequire = "typescript(no-require-imports)";

function lint(paths, cwd = root) {
  const result = spawnSync(
    process.execPath,
    [vp, "lint", ...paths, "--format", "json", "--no-ignore"],
    { cwd, encoding: "utf8", timeout: 60_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(Array.isArray(report.diagnostics), result.stdout);
  return { ...report, status: result.status, stderr: result.stderr };
}

test("the real linter enforces desktop import boundaries", async (t) => {
  await t.test("current renderer and shared sources have no boundary errors", () => {
    const result = lint([`${desktop}/renderer`, `${desktop}/shared`]);
    assert.equal(result.status, 0, JSON.stringify(result));
    assert.ok(result.number_of_files > 0);
    assert.deepEqual(
      result.diagnostics.filter(({ code }) => code === restrictedImports || code === noRequire),
      [],
    );
  });

  const probeRoot = mkdtempSync(join(tmpdir(), "voice-import-boundary-test-"));
  t.after(() => rmSync(probeRoot, { recursive: true, force: true }));
  writeFileSync(join(probeRoot, "package.json"), '{"type":"module"}');
  writeFileSync(join(probeRoot, "vite.config.ts"), readFileSync(join(root, "vite.config.ts")));
  symlinkSync(join(root, "node_modules"), join(probeRoot, "node_modules"), "dir");
  const dirs = /** @type {Record<"renderer" | "shared" | "main" | "preload", string>} */ (
    Object.fromEntries(
      ["renderer", "shared", "main", "preload"].map((area) => {
        const dir = join(probeRoot, desktop, area);
        mkdirSync(dir, { recursive: true });
        return [area, dir];
      }),
    )
  );

  function fixture(area, name, source) {
    const file = join(dirs[area], name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${source}\n`);
    return relative(probeRoot, file);
  }

  await t.test(
    "shared contracts, cleanup style, test utilities and native imports stay allowed",
    () => {
      const allowed = [
        fixture(
          "renderer",
          "contracts.tsx",
          'export type { Snapshot } from "../../shared/api.ts";\nexport { finishText } from "@voice/cleanup/style";',
        ),
        fixture(
          "renderer",
          "contracts-import.ts",
          'import type { Snapshot } from "../../shared/api.ts";\nexport type State = Snapshot;',
        ),
        fixture(
          "shared",
          "style.ts",
          'export { finishText } from "@voice/cleanup/style";\nexport type { Snapshot } from "../api.ts";',
        ),
        ...["utilities.test.ts", "utilities.spec.tsx"].map((name) =>
          fixture(
            "renderer",
            name,
            'export { readFileSync } from "node:fs";\nexport * from "../../main/session.ts";\nexport const fs = require("node:fs");',
          ),
        ),
        fixture(
          "renderer",
          "__tests__/utilities.ts",
          'export { readFileSync } from "node:fs";\nexport * from "../../../main/session.ts";',
        ),
        fixture("shared", "utilities.test.ts", 'export { readFileSync } from "node:fs";'),
        fixture(
          "main",
          "native.ts",
          'export { app, BrowserWindow } from "electron";\nexport { readFileSync } from "node:fs";',
        ),
        fixture(
          "preload",
          "bridge.ts",
          'export { contextBridge, ipcRenderer } from "electron";\nexport { readFileSync } from "node:fs";',
        ),
      ];
      const result = lint(allowed, probeRoot);
      assert.equal(result.status, 0, JSON.stringify(result));
      assert.equal(result.number_of_files, allowed.length);
      assert.deepEqual(result.diagnostics, []);
    },
  );

  await t.test("privileged imports and re-exports report the intended restriction", () => {
    /** @type {{ file: string, rule: string, specifier?: string | undefined }[]} */
    const cases = [
      [
        "node-prefix",
        'import { readFileSync } from "node:fs";\nexport { readFileSync };',
        "node:fs",
      ],
      ["node-bare", 'export { readFileSync } from "fs";', "fs"],
      ["node-subpath", 'export { readFile } from "fs/promises";', "fs/promises"],
      ["node-process", 'export { spawn } from "child_process";', "child_process"],
      ["node-prefix-only", 'import "node:sqlite";', "node:sqlite"],
      ["electron", 'import { shell } from "electron";\nexport { shell };', "electron"],
      ["electron-subpath", 'import "electron/renderer";', "electron/renderer"],
      ["cleanup-engine", 'import "@voice/cleanup";', "@voice/cleanup"],
      ["cleanup-download", 'import "@voice/cleanup/download";', "@voice/cleanup/download"],
      ["native-model", 'import "node-llama-cpp";', "node-llama-cpp"],
      ["main-export", 'export * from "../../main/session.ts";', "../../main/session.ts"],
      [
        "main-import",
        'import * as session from "../../main/session.ts";\nexport { session };',
        "../../main/session.ts",
      ],
      [
        "main-type-export",
        'export type { Session } from "../../main/session.ts";',
        "../../main/session.ts",
      ],
      ["main-no-extension", 'export * from "../../main/session";', "../../main/session"],
      [
        "main-path-traversal",
        'export * from "../../shared/../main/session.ts";',
        "../../shared/../main/session.ts",
      ],
      ["main-alias", 'export * from "@main/session.ts";', "@main/session.ts"],
      ["main-root-alias", 'export * from "@/main/session.ts";', "@/main/session.ts"],
      ["main-source-alias", 'export * from "~/main/session.ts";', "~/main/session.ts"],
      ["main-hash-alias", 'export * from "#main/session.ts";', "#main/session.ts"],
      [
        "main-absolute",
        `export * from ${JSON.stringify(join(root, desktop, "main/session.ts"))};`,
        "main/session.ts",
      ],
      ["main-query", 'export * from "../../main/session.ts?raw";', "../../main/session.ts?raw"],
      ["main-case", 'export * from "../../Main/session.ts";', "../../Main/session.ts"],
      [
        "main-windows-path",
        'export * from "..\\\\..\\\\main\\\\session.ts";',
        "..\\..\\main\\session.ts",
      ],
      ["preload-export", 'export * from "../../preload/hub.ts";', "../../preload/hub.ts"],
      ["node-dynamic", 'export const fs = import("node:fs");', "node:fs"],
      ["electron-dynamic", 'export const shell = import("electron");', "electron"],
      [
        "main-dynamic",
        'export const session = import("../../main/session.ts");',
        "../../main/session.ts",
      ],
    ].flatMap(([name, source, specifier]) =>
      ["renderer", "shared"].map((area) => ({
        file: fixture(area, `${name}.ts`, source),
        rule: restrictedImports,
        specifier,
      })),
    );
    for (const area of ["renderer", "shared"]) {
      for (const [name, source] of [
        ["node", 'export const fs = require("node:fs");'],
        ["electron", 'export const electron = require("electron");'],
        ["main", 'export const session = require("../../main/session.ts");'],
        ["preload", 'export const bridge = require("../../preload/hub.ts");'],
      ]) {
        cases.push({ file: fixture(area, `${name}-require.ts`, source), rule: noRequire });
      }
    }
    for (const [area, name, source] of [
      ["main", "ipc", 'export { ipcMain } from "electron";'],
      ["main", "ipc-subpath", 'export { ipcMain } from "electron/main";'],
      ["main", "ipc-default", 'import electron from "electron";\nexport { electron };'],
      ["preload", "ipc", 'export { ipcMain } from "electron";'],
      ["renderer", "ipc.test", 'export { ipcMain } from "electron";'],
    ]) {
      cases.push({
        file: fixture(area, `${name}.ts`, source),
        rule: restrictedImports,
        specifier: "electron",
      });
    }

    const result = lint(
      cases.map(({ file }) => file),
      probeRoot,
    );
    assert.equal(result.number_of_files, cases.length);
    for (const { file, rule, specifier } of cases) {
      const diagnostics = result.diagnostics.filter(
        ({ filename }) => resolve(probeRoot, filename) === resolve(probeRoot, file),
      );
      assert.ok(diagnostics.length > 0, `${file}: ${JSON.stringify(diagnostics)}`);
      for (const diagnostic of diagnostics) {
        assert.equal(diagnostic.severity, "error", file);
        assert.equal(diagnostic.code, rule, file);
        if (specifier) assert.ok(diagnostic.message.includes(specifier), file);
      }
    }
    assert.deepEqual(
      new Set(result.diagnostics.map(({ filename }) => resolve(probeRoot, filename))),
      new Set(cases.map(({ file }) => resolve(probeRoot, file))),
    );
    assert.equal(result.status, 1, JSON.stringify(result));
  });
});
