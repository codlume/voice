import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { runningVoiceProcesses } from "./helper.mjs";

const dir = mkdtempSync(join(tmpdir(), "voice-processes-"));
const children = [];
after(() => {
  for (const child of children) child.stdin.end();
  rmSync(dir, { recursive: true, force: true });
});

const idle = 'process.stdin.on("end", () => process.exit()).resume()';

function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], ...options });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve(String(child.pid)));
    child.once("error", reject);
  });
}

test("a running Voice is found by its executable, not by a path in another command", async () => {
  const helper = join(dir, "bin/voice-helper");
  mkdirSync(join(dir, "bin"));
  try {
    linkSync(process.execPath, helper);
  } catch {
    copyFileSync(process.execPath, helper);
  }
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "scripts/dev.mjs"), idle);
  writeFileSync(join(dir, "scripts/dev-bundle.test.mjs"), idle);

  const pids = {
    helper: await run(helper, ["-e", idle]),
    devSession: await run(process.execPath, [join(dir, "scripts/dev.mjs")]),
    otherScript: await run(process.execPath, [join(dir, "scripts/dev-bundle.test.mjs")]),
    packagingJob: await run(process.execPath, ["-e", idle, helper]),
    swiftBuild: await run("/bin/sh", [
      "-c",
      `read _; : --package-path ${join(dir, "native/voice-helper")}`,
    ]),
    devScriptMention: await run("/bin/sh", ["-c", "read _; : scripts/dev.mjs"]),
    renamedNode: await run(process.execPath, ["-e", idle], { argv0: "voice-helper" }),
  };

  const found = new Set(runningVoiceProcesses().map((line) => line.split(" ")[0]));
  assert.deepEqual(
    Object.fromEntries(Object.entries(pids).map(([name, pid]) => [name, found.has(pid)])),
    {
      helper: true,
      devSession: true,
      otherScript: false,
      packagingJob: false,
      swiftBuild: false,
      devScriptMention: false,
      renamedNode: false,
    },
  );
});
