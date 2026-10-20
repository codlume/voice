import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const claims = new Map();

export function worktreeIdentity(worktree) {
  const canonical = realpathSync(worktree);
  return `${basename(canonical).replace(/[^\w.-]/g, "_")}-${createHash("sha256").update(canonical).digest("hex").slice(0, 8)}`;
}

export function scratchPath(name, worktree, root = tmpdir()) {
  if (!/^[\w.-]+$/.test(name))
    throw new Error(
      "scratch name must contain only letters, numbers, dots, underscores or hyphens",
    );
  return join(root, `${name}-${worktreeIdentity(worktree)}`);
}

export function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  // lstart follows the locale and time zone, and the identity must read the same from any shell.
  const result = spawnSync(
    "ps",
    ["-p", String(pid), "-o", "stat=", "-o", "lstart=", "-o", "ucomm="],
    { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } },
  );
  if (result.status === 1 && !result.stdout.trim() && !result.stderr.trim()) return null;
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`cannot inspect process ${pid}: ${result.stderr}`);
  const match = /^(\S+)\s+(.+)$/.exec(result.stdout.trim());
  return match && !match[1].startsWith("Z") ? match[2].trim() : null;
}

export function sameProcess(pid, identity) {
  return Boolean(identity) && processIdentity(pid) === identity;
}

export async function claimScratch(userData) {
  if (claims.has(userData)) throw new Error(`scratch already owned by this process: ${userData}`);
  // The OS releases this lock on EOF or death. The file stays so contenders always lock the same inode.
  const holder = spawn(
    "/usr/bin/lockf",
    [
      "-k",
      "-t",
      "0",
      `${userData}.lock`,
      process.execPath,
      "-e",
      'process.stdout.write("locked"); process.stdin.resume()',
    ],
    { detached: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  const exited = new Promise((resolveExit) => holder.once("exit", resolveExit));
  await new Promise((ready, reject) => {
    holder.once("error", reject);
    holder.stdout.once("data", ready);
    holder.once("exit", () => reject(new Error(`scratch is owned by another run: ${userData}`)));
  });
  const recordPath = `${userData}.owner.json`;
  const record = {
    ownerPid: process.pid,
    ownerIdentity: processIdentity(process.pid),
    processes: [],
  };
  const save = () => writeFileSync(recordPath, JSON.stringify(record));
  const liveChildren = (state) =>
    state.processes?.some(({ pid, identity }) => sameProcess(pid, identity));
  try {
    const previous = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, "utf8")) : null;
    if (
      previous &&
      (sameProcess(previous.ownerPid, previous.ownerIdentity) || liveChildren(previous))
    ) {
      throw new Error(`scratch still has a live owner or child: ${userData}`);
    }
    save();
  } catch (error) {
    holder.stdin.end();
    await exited;
    throw error;
  }
  const claim = {
    userData,
    reset() {
      requireOwnership();
      if (liveChildren(record)) throw new Error(`scratch still has a live child: ${userData}`);
      rmSync(userData, { recursive: true, force: true });
      mkdirSync(userData, { recursive: true });
    },
    track(child) {
      requireOwnership();
      record.processes.push({ pid: child.pid, identity: processIdentity(child.pid) });
      save();
    },
    async release({ remove = false } = {}) {
      requireOwnership();
      if (liveChildren(record)) throw new Error(`scratch still has a live child: ${userData}`);
      if (remove) rmSync(userData, { recursive: true, force: true });
      rmSync(recordPath, { force: true });
      claims.delete(userData);
      holder.stdin.end();
      await exited;
    },
  };
  function requireOwnership() {
    if (claims.get(userData) !== claim || holder.exitCode !== null || holder.signalCode !== null) {
      throw new Error(`scratch is not owned by this claim: ${userData}`);
    }
  }
  claims.set(userData, claim);
  return claim;
}

export function trackScratchChild(child) {
  for (const claim of claims.values()) claim.track(child);
}

export async function releaseScratch(userData, options) {
  const claim = claims.get(userData);
  if (!claim) throw new Error(`scratch is not owned by this process: ${userData}`);
  await claim.release(options);
}
