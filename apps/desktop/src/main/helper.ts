import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

import { parseHelperEvent, type HelperCommand, type HelperEvent } from "./protocol.ts";

export const RESTART_MIN_MS = 250;
export const RESTART_MAX_MS = 5000;
// A run this long counts as healthy, so the next crash restarts at the minimum delay again.
const HEALTHY_RUN_MS = 10_000;

export type HelperOptions = {
  binary: string;
  modelsDir: string;
  onEvent: (event: HelperEvent) => void;
  /** Called on every unexpected exit, before the restart is scheduled. */
  onExit: () => void;
  /** Commands to send after every `ready`, so a restarted helper is configured again. */
  configure: () => HelperCommand[];
  log: (message: string) => void;
};

export type Helper = {
  send(command: HelperCommand): void;
  stop(): Promise<void>;
};

export function startHelper(options: HelperOptions): Helper {
  let child: ChildProcess | null = null;
  let restartTimer: NodeJS.Timeout | null = null;
  let restartDelay = RESTART_MIN_MS;
  let stopping = false;

  function launch() {
    const startedAt = Date.now();
    const proc = spawn(options.binary, ["--models-dir", options.modelsDir], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = proc;
    let ended = false;

    createInterface({ input: proc.stdout! }).on("line", (line) => {
      if (line.trim() === "") return;
      const event = parseHelperEvent(line);
      if (!event) {
        // Only the type and size: a malformed transcript line would otherwise leak its text.
        const type = /"type"\s*:\s*"([^"]*)"/.exec(line)?.[1] ?? "?";
        options.log(`helper: unparseable ${type} line (${line.length} chars)`);
        return;
      }
      if (event.type === "ready") {
        for (const command of options.configure()) send(command);
      }
      options.onEvent(event);
    });
    createInterface({ input: proc.stderr! }).on("line", (line) => options.log(`helper: ${line}`));

    const onEnd = (reason: string) => {
      if (ended) return;
      ended = true;
      if (child === proc) child = null;
      if (stopping) return;
      options.log(`helper: ${reason}`);
      options.onExit();
      if (Date.now() - startedAt > HEALTHY_RUN_MS) restartDelay = RESTART_MIN_MS;
      restartTimer = setTimeout(launch, restartDelay);
      restartDelay = Math.min(restartDelay * 2, RESTART_MAX_MS);
    };
    proc.on("error", (error) => onEnd(`failed to start (${error.message})`));
    proc.on("close", (code, signal) => onEnd(`exited (${signal ?? code})`));
  }

  function send(command: HelperCommand) {
    if (!child?.stdin?.writable) {
      options.log(`helper: dropped ${command.type} while not running`);
      return;
    }
    child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async function stop() {
    stopping = true;
    if (restartTimer) clearTimeout(restartTimer);
    const proc = child;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => proc.once("close", () => resolve()));
    proc.stdin?.end();
    const force = setTimeout(() => proc.kill("SIGKILL"), 2000);
    await exited;
    clearTimeout(force);
  }

  launch();
  return { send, stop };
}
