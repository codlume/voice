import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

test(
  "the bundle asks for the microphone and system audio in Voice's own words",
  { skip: process.platform !== "darwin" },
  (t) => {
    const { stock, devDir, bin } = fixture(t);
    // Stops right after the Info.plist edits, which leaves the staged copy to read.
    failingCommand(t, bin, "codesign");
    devElectronPath(stock, devDir);
    const plist = join(devDir, "staging/Voice Dev.app/Contents/Info.plist");
    const read = (key) =>
      execFileSync("plutil", ["-extract", key, "raw", plist], { encoding: "utf8" }).trim();
    assert.equal(
      read("NSMicrophoneUsageDescription"),
      "Voice uses your microphone only while you dictate or during a meeting you start.",
    );
    assert.match(read("NSAudioCaptureUsageDescription"), /^Voice records sound from other apps/);
  },
);
