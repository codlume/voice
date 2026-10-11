import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("voice-verify.mjs", import.meta.url));
const worktree = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const id = `${basename(worktree).replace(/[^\w.-]/g, "_")}-${createHash("sha256").update(worktree).digest("hex").slice(0, 8)}`;

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "voice-verify-stop-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const userData = join(dir, `voice-verify-${id}`);
  const statePath = `${userData}.json`;
  mkdirSync(userData);
  return {
    userData,
    statePath,
    write: (state) => writeFileSync(statePath, JSON.stringify({ worktree, userData, ...state })),
    stop: () =>
      new Promise((resolveStop) => {
        execFile(
          process.execPath,
          [script, "stop"],
          {
            env: { ...process.env, TMPDIR: dir },
            encoding: "utf8",
            timeout: 15_000,
          },
          (error, stdout, stderr) => resolveStop({ status: error?.code ?? 0, stdout, stderr }),
        );
      }),
  };
}

async function child(t, command, args) {
  const proc = spawn(command, args, { detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(proc, "exit");
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) process.kill(-proc.pid, "SIGTERM");
    await exited;
  });
  await once(proc.stdout, "data");
  return proc;
}

test("stop leaves an unrelated live process with a stale recorded identity alone", async (t) => {
  const f = fixture(t);
  const proc = await child(t, process.execPath, [
    "-e",
    'process.stdout.write("ready"); process.stdin.resume()',
  ]);
  f.write({
    ownerPid: proc.pid,
    ownerIdentity: "old process",
    electronPid: proc.pid,
    electronIdentity: "old Electron",
    runId: "synthetic",
  });
  const result = await f.stop();
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotThrow(() => process.kill(proc.pid, 0));
  assert.equal(existsSync(f.statePath), false);
  assert.equal(existsSync(f.userData), false);
});

test("a contending stop cannot enter cleanup and the OS releases a dead holder's lock", async (t) => {
  const f = fixture(t);
  f.write({ ownerPid: 99999999, runId: "synthetic" });
  const holder = await child(t, "/usr/bin/lockf", [
    "-k",
    "-t",
    "0",
    `${f.statePath}.stop-lock`,
    process.execPath,
    "-e",
    'process.stdout.write("locked"); process.stdin.resume()',
  ]);
  const blocked = await f.stop();
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.match(blocked.stderr, /stop already in progress/);
  assert.equal(existsSync(f.statePath), true);
  assert.equal(existsSync(f.userData), true);
  const ended = once(holder, "exit");
  process.kill(-holder.pid, "SIGTERM");
  await ended;
  const recovered = await f.stop();
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(existsSync(f.statePath), false);
});

test("stop accepts an exited owner before its parent reaps it", { timeout: 3000 }, async (t) => {
  const f = fixture(t);
  const proc = await child(t, process.execPath, [
    "-e",
    'process.stdout.write("ready"); process.stdin.resume()',
  ]);
  const identity = execFileSync("ps", ["-p", String(proc.pid), "-o", "lstart=", "-o", "ucomm="], {
    encoding: "utf8",
  }).trim();
  f.write({ ownerPid: proc.pid, ownerIdentity: identity });
  const result = spawnSync(process.execPath, [script, "stop"], {
    env: { ...process.env, TMPDIR: dirname(f.statePath) },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(f.statePath), false);
  assert.equal(existsSync(f.userData), false);
  await once(proc, "exit");
});
