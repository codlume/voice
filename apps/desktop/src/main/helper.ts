import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import type { Log } from "./diagnostics-scrub.ts";
import {
  HELPER_PROTOCOL_VERSION,
  parseHelperEvent,
  type HelperCommand,
  type HelperEvent,
} from "./protocol.ts";

export const RESTART_MIN_MS = 250;
const RESTART_MAX_MS = 5000;
const HEALTHY_RUN_MS = 10_000;

// Only codes, never error messages or stderr: this can leave the machine as a diagnostic.
export type HelperExit =
  | { code: number | null; signal: NodeJS.Signals | null }
  | { spawnError: string };

export type HelperOptions = {
  binary: string;
  modelsDir: string;
  env: NodeJS.ProcessEnv;
  onEvent: (event: HelperEvent) => void;
  onExit: (exit: HelperExit) => void;
  configure: () => HelperCommand[];
  log: Log;
};

export type Helper = {
  send(command: HelperCommand): void;
  stop(): Promise<void>;
};

export function startHelper(options: HelperOptions): Helper {
  let child: ChildProcessWithoutNullStreams | null = null;
  let restartTimer: NodeJS.Timeout | null = null;
  let restartDelay = RESTART_MIN_MS;
  let stopping = false;

  function launch() {
    const startedAt = Date.now();
    const proc = spawn(options.binary, ["--models-dir", options.modelsDir], { env: options.env });
    child = proc;
    let ended = false;

    createInterface({ input: proc.stdout }).on("line", (line) => {
      if (line.trim() === "") return;
      const event = parseHelperEvent(line);
      if (!event) {
        const type = /"type"\s*:\s*"([^"]*)"/.exec(line)?.[1] ?? "?";
        options.log(`helper: unparseable ${type} line (${line.length} chars)`, {
          message: "helper event unparseable",
          level: "error",
        });
        return;
      }
      if (event.type === "ready") {
        if (event.version !== HELPER_PROTOCOL_VERSION) {
          // A restart would only meet the same binary, so this ends the helper for good.
          options.log(
            `helper: speaks protocol v${event.version} but this build expects v${HELPER_PROTOCOL_VERSION}; refusing to use it`,
            {
              message: "helper protocol mismatch",
              level: "fatal",
              attributes: {
                "helper.protocol_version": event.version,
                "helper.expected_version": HELPER_PROTOCOL_VERSION,
              },
            },
          );
          void stop();
          return;
        }
        for (const command of options.configure()) send(command);
      }
      options.onEvent(event);
    });
    createInterface({ input: proc.stderr }).on("line", (line) => options.log(`helper: ${line}`));
    // A write racing the helper's exit fails with EPIPE; without a listener that would throw
    // out of the event loop and take main down with it. The close handler does the recovery.
    proc.stdin.on("error", (error: NodeJS.ErrnoException) =>
      options.log(`helper: stdin ${error.message}`, {
        message: "helper stdin failed",
        level: "warn",
        attributes: { "error.code": error.code },
      }),
    );

    const onEnd = (reason: string, exit: HelperExit) => {
      if (ended) return;
      ended = true;
      if (child === proc) child = null;
      if (stopping) return;
      options.log(`helper: ${reason}`);
      options.onExit(exit);
      if (Date.now() - startedAt > HEALTHY_RUN_MS) restartDelay = RESTART_MIN_MS;
      restartTimer = setTimeout(launch, restartDelay);
      restartDelay = Math.min(restartDelay * 2, RESTART_MAX_MS);
    };
    proc.on("error", (error: NodeJS.ErrnoException) =>
      onEnd(`failed to start (${error.message})`, { spawnError: error.code ?? "unknown" }),
    );
    proc.on("close", (code, signal) => onEnd(`exited (${signal ?? code})`, { code, signal }));
  }

  function send(command: HelperCommand) {
    if (!child?.stdin.writable) {
      options.log(`helper: dropped ${command.type} while not running`, {
        message: "helper command dropped",
        level: "warn",
        attributes: { "command.type": command.type },
      });
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
    proc.stdin.end();
    const force = setTimeout(() => proc.kill("SIGKILL"), 2000);
    await exited;
    clearTimeout(force);
  }

  launch();
  return { send, stop };
}
