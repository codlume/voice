import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  claimScratch,
  processIdentity,
  scratchPath,
  trackScratchChild,
} from "./smoke-resources.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "voice-scratch-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("scratch paths are stable per canonical worktree and runner", (t) => {
  const dir = fixture(t);
  const first = join(dir, "first");
  const second = join(dir, "second");
  const alias = join(dir, "alias");
  mkdirSync(first);
  mkdirSync(second);
  symlinkSync(first, alias);
  assert.equal(scratchPath("voice-e2e", first, dir), scratchPath("voice-e2e", alias, dir));
  assert.notEqual(scratchPath("voice-e2e", first, dir), scratchPath("voice-e2e", second, dir));
  assert.notEqual(scratchPath("voice-e2e", first, dir), scratchPath("voice-idle", first, dir));
  assert.throws(() => scratchPath("../unsafe", first, dir), /scratch name/);
});

test("a second process cannot reset a live owner's scratch", async (t) => {
  const dir = fixture(t);
  const userData = join(dir, "owned");
  const claim = await claimScratch(userData);
  try {
    claim.reset();
    const marker = join(userData, "keep.txt");
    writeFileSync(marker, "synthetic state");
    const module = new URL("smoke-resources.mjs", import.meta.url).href;
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { claimScratch } from ${JSON.stringify(module)}; const claim = await claimScratch(${JSON.stringify(userData)}); claim.reset(); await claim.release();`,
          ],
          { stdio: "pipe" },
        ),
      /scratch is owned by another run/,
    );
    assert.equal(readFileSync(marker, "utf8"), "synthetic state");
    await assert.rejects(claimScratch(userData), /already owned by this process/);
  } finally {
    await claim.release();
  }
  const next = await claimScratch(userData);
  assert.throws(() => claim.reset(), /not owned by this claim/);
  next.reset();
  assert.equal(existsSync(join(userData, "keep.txt")), false);
  await next.release({ remove: true });
  assert.equal(existsSync(userData), false);
});

test("stale ownership can recover but a surviving child prevents deletion", async (t) => {
  const dir = fixture(t);
  const userData = join(dir, "orphan");
  const record = `${userData}.owner.json`;
  const stale = { ownerPid: process.pid, ownerIdentity: "an old process", processes: [] };
  writeFileSync(record, JSON.stringify(stale));
  const claim = await claimScratch(userData);
  claim.reset();
  const child = spawn(
    process.execPath,
    ["-e", 'process.stdout.write("ready"); process.stdin.resume()'],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const exited = once(child, "exit");
  await once(child.stdout, "data");
  trackScratchChild(child);
  assert.throws(() => claim.reset(), /live child/);
  await assert.rejects(claim.release({ remove: true }), /live child/);
  child.stdin.end();
  await exited;
  await claim.release();

  writeFileSync(
    record,
    JSON.stringify({
      ...stale,
      processes: [{ pid: process.pid, identity: processIdentity(process.pid) }],
    }),
  );
  await assert.rejects(claimScratch(userData), /live owner or child/);
  assert.equal(existsSync(userData), true);
  writeFileSync(record, JSON.stringify(stale));
  const recovered = await claimScratch(userData);
  await recovered.release({ remove: true });
});
