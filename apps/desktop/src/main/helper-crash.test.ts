import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { findHelperCrash, parseCrashReport } from "./helper-crash.ts";

const PID = 4242;
const SECRET = "hi anna can we move our meeting";

function report(pid = PID) {
  const header = { app_name: "voice-helper", bug_type: "309" };
  const body = {
    pid,
    procName: "voice-helper",
    procPath: "/Users/someone/Applications/Voice.app/Contents/Resources/bin/voice-helper",
    exception: { type: "EXC_BAD_ACCESS", signal: "SIGSEGV", subtype: "KERN_INVALID_ADDRESS" },
    asi: { "libswiftCore.dylib": [`Fatal error: ${SECRET}`] },
    faultingThread: 1,
    threads: [
      {
        id: 1,
        frames: [{ imageOffset: 10, symbol: "idleLoop", symbolLocation: 4, imageIndex: 0 }],
      },
      {
        id: 2,
        triggered: true,
        threadState: { x: [{ value: 1234567 }] },
        frames: [
          { imageOffset: 80096, imageIndex: 1 },
          { imageOffset: 3104, symbol: "Capture.start()", symbolLocation: 8, imageIndex: 0 },
          { imageOffset: 12, symbol: "start", symbolLocation: 1, imageIndex: 2 },
        ],
      },
    ],
    usedImages: [
      { name: "voice-helper", path: "/Users/someone/Applications/Voice.app/voice-helper" },
      { name: "AVFAudio", path: "/System/Library/Frameworks/AVFAudio.framework/AVFAudio" },
      { name: "dyld", path: "/usr/lib/dyld" },
    ],
  };
  return `${JSON.stringify(header)}\n${JSON.stringify(body, null, 2)}`;
}

const CRASH = {
  exceptionType: "EXC_BAD_ACCESS",
  innermostFirstFrames: [
    { image: "AVFAudio", symbol: undefined, inApp: false },
    { image: "voice-helper", symbol: "Capture.start()", inApp: true },
    { image: "dyld", symbol: "start", inApp: false },
  ],
};

describe("parseCrashReport", () => {
  test("keeps only the crashed thread's image names and symbols", () => {
    const crash = parseCrashReport(report(), PID);
    expect(crash).toEqual(CRASH);
    const json = JSON.stringify(crash);
    for (const text of ["someone", "/System", SECRET, "idleLoop", "1234567", "SIGSEGV"]) {
      expect(json).not.toContain(text);
    }
  });

  test("ignores another process's report and anything unparseable", () => {
    expect(parseCrashReport(report(PID + 1), PID)).toBeUndefined();
    expect(parseCrashReport(report().slice(0, 200), PID)).toBeUndefined();
    expect(parseCrashReport("", PID)).toBeUndefined();
  });
});

const options = (dir: string) => ({
  dir,
  since: Date.now() - 1000,
  timeoutMs: 2000,
  intervalMs: 20,
});

describe("findHelperCrash", () => {
  test("waits for the report macOS writes after the helper dies", async () => {
    const dir = mkdtempSync(NodePath.join(tmpdir(), "voice-reports-"));
    writeFileSync(NodePath.join(dir, "voice-helper-2026-10-22-133000.ips"), report(PID + 1));
    writeFileSync(NodePath.join(dir, "Python-2026-10-22-133001.ips"), report());
    const found = findHelperCrash(PID, options(dir));
    setTimeout(
      () => writeFileSync(NodePath.join(dir, "voice-helper-2026-10-22-133002.ips"), report()),
      100,
    );
    expect(await found).toEqual(CRASH);
  });

  test("gives up on reports older than the exit or a missing folder", async () => {
    const dir = mkdtempSync(NodePath.join(tmpdir(), "voice-reports-"));
    const stale = NodePath.join(dir, "voice-helper-2026-10-01-120000.ips");
    writeFileSync(stale, report());
    utimesSync(stale, new Date(2026, 9, 1), new Date(2026, 9, 1));
    const quick = { timeoutMs: 100 };
    expect(await findHelperCrash(PID, { ...options(dir), ...quick })).toBeUndefined();
    expect(
      await findHelperCrash(PID, { ...options(NodePath.join(dir, "missing")), ...quick }),
    ).toBeUndefined();
  });
});
