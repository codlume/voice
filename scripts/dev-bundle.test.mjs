import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { devElectronPath } from "./dev-bundle.mjs";

// Each case fails before lsregister runs, so nothing reaches LaunchServices.
function fixture(t, { infoPlist = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dev-bundle-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const contents = join(dir, "Electron.app/Contents");
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  writeFileSync(join(contents, "MacOS/Electron"), "");
  if (infoPlist) {
    writeFileSync(
      join(contents, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleVersion</key><string>1.0.0</string></dict></plist>`,
    );
  }
  const errors = t.mock.method(console, "error", () => {});
  return {
    stock: join(contents, "MacOS/Electron"),
    devDir: join(dir, ".dev"),
    bin: join(dir, "bin"),
    errors,
  };
}

function failingCommand(t, bin, name) {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), `#!/bin/sh\necho "${name}: injected failure" >&2\nexit 1\n`);
  chmodSync(join(bin, name), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => (process.env.PATH = path));
}

const unavailable =
  /^Voice Dev bundle unavailable: .+; using stock Electron, so paste the sign-in code$/;

test(
  "a failed signature falls back to the stock Electron with one clear line",
  { skip: process.platform !== "darwin" },
  (t) => {
    const { stock, devDir, bin, errors } = fixture(t);
    failingCommand(t, bin, "codesign");

    assert.equal(devElectronPath(stock, devDir), stock);
    assert.equal(errors.mock.callCount(), 1);
    const [line] = errors.mock.calls[0].arguments;
    assert.match(line, unavailable);
    assert.match(line, /Command failed: codesign/);
    assert.equal(existsSync(join(devDir, "Voice Dev.app")), false);
  },
);

test(
  "an Electron.app without an Info.plist falls back the same way",
  { skip: process.platform !== "darwin" },
  (t) => {
    const { stock, devDir, errors } = fixture(t, { infoPlist: false });

    assert.equal(devElectronPath(stock, devDir), stock);
    assert.equal(errors.mock.callCount(), 1);
    assert.match(errors.mock.calls[0].arguments[0], unavailable);
  },
);
