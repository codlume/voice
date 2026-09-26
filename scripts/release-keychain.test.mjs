import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const require = createRequire(
  realpathSync(
    new URL("../apps/desktop/node_modules/electron-builder/package.json", import.meta.url),
  ),
);
const macCodeSign = require("app-builder-lib/out/codeSign/macCodeSign.js");

test("release keychain exports an electron-builder qualifier and full native signing identity", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "voice-release-keychain-test-"));
  const cachedIdentities = macCodeSign.findIdentityRawResult;
  t.after(() => {
    macCodeSign.findIdentityRawResult = cachedIdentities;
    rmSync(directory, { recursive: true, force: true });
  });
  const identity = "Developer ID Application: Voice Test (TESTTEAM01)";
  const hash = "0123456789ABCDEF0123456789ABCDEF01234567";
  writeFileSync(
    join(directory, "security"),
    `#!/bin/bash
if [[ "$1" == find-identity ]]; then
  echo '  1) ${hash} "${identity}"'
fi
`,
    { mode: 0o755 },
  );
  const githubEnv = join(directory, "github-env");
  execFileSync("/bin/bash", [fileURLToPath(new URL("./release-keychain.sh", import.meta.url))], {
    env: {
      PATH: `${directory}:/usr/bin:/bin`,
      RUNNER_TEMP: directory,
      GITHUB_ENV: githubEnv,
      CERTIFICATE: Buffer.from("synthetic certificate").toString("base64"),
      CERTIFICATE_PASSWORD: "test-password",
      APPLE_ID: "release@example.test",
      APPLE_APP_SPECIFIC_PASSWORD: "test-password",
      APPLE_TEAM_ID: "TESTTEAM01",
    },
  });
  const exported = Object.fromEntries(
    readFileSync(githubEnv, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
  assert.equal(exported.APPLE_SIGN_IDENTITY, identity);
  macCodeSign.findIdentityRawResult = Promise.resolve([`${hash} "${identity}"`]);
  const selected = await macCodeSign.findIdentity("Developer ID Application", exported.CSC_NAME);
  assert.equal(selected.name, identity);
  assert.equal(selected.hash, hash);
  assert.equal(exported.CSC_NAME, "Voice Test (TESTTEAM01)");
});
