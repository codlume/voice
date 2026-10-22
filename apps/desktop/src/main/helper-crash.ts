import { readdir, readFile, stat } from "node:fs/promises";
import * as NodePath from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const HELPER = "voice-helper";
const MAX_FRAMES = 64;

export type HelperFrame = { image: string; symbol: string | undefined; inApp: boolean };

export type HelperCrash = { exceptionType: string; innermostFirstFrames: HelperFrame[] };

type Fields = Record<string, unknown>;

const fields = (value: unknown): Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const string = (value: unknown) => (typeof value === "string" ? value : undefined);

const ipsBody = (text: string) => text.slice(text.indexOf("\n") + 1);

export function parseCrashReport(text: string, pid: number): HelperCrash | undefined {
  let report: Fields;
  try {
    report = fields(JSON.parse(ipsBody(text)));
  } catch {
    return;
  }
  const exceptionType = string(fields(report.exception).type);
  const thread = list(report.threads)[Number(report.faultingThread)];
  if (report.pid !== pid || exceptionType === undefined || thread === undefined) return;
  const images = list(report.usedImages).map((image) => string(fields(image).name));
  const innermostFirstFrames = list(fields(thread).frames)
    .slice(0, MAX_FRAMES)
    .map((value): HelperFrame => {
      const frame = fields(value);
      const index = frame.imageIndex;
      const image = (typeof index === "number" ? images[index] : undefined) ?? "<unknown>";
      return { image, symbol: string(frame.symbol), inApp: image === HELPER };
    });
  return { exceptionType, innermostFirstFrames };
}

// macOS writes the report a moment after the helper dies, so this waits for it to appear.
export async function findHelperCrash(
  pid: number,
  options: { dir: string; since: number; timeoutMs: number; intervalMs: number },
): Promise<HelperCrash | undefined> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const names = await readdir(options.dir).catch(() => []);
    for (const name of names) {
      if (!name.startsWith(`${HELPER}-`) || !name.endsWith(".ips")) continue;
      const path = NodePath.join(options.dir, name);
      const modified = await stat(path).then(
        ({ mtimeMs }) => mtimeMs,
        () => 0,
      );
      if (modified < options.since) continue;
      const crash = parseCrashReport(await readFile(path, "utf8").catch(() => ""), pid);
      if (crash) return crash;
    }
    if (Date.now() >= deadline) return;
    await sleep(options.intervalMs);
  }
}
