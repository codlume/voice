import { describe, expect, test } from "vite-plus/test";

import type { MicrophoneTest } from "../shared/api.ts";
import { microphoneTestAction, microphoneTestStatus } from "./microphoneTestView.ts";

const off: MicrophoneTest = { kind: "off" };
const listening: MicrophoneTest = { kind: "listening", episode: 1 };
const nothing = { heard: false, quiet: false, accessRequested: false };
const access = { text: "Voice needs microphone access to test.", failed: false };

describe("microphoneTestStatus", () => {
  test("an idle test has nothing to report, so its region stays closed", () => {
    expect(microphoneTestStatus(off, "granted", nothing)).toBeNull();
    expect(microphoneTestStatus(off, "denied", nothing)).toBeNull();
  });

  test("starting reads the same whatever was heard", () => {
    expect(
      microphoneTestStatus({ kind: "starting" }, "granted", {
        ...nothing,
        heard: true,
        quiet: true,
      }),
    ).toEqual({ text: "Starting microphone…", failed: false });
  });

  test("listening moves from a prompt to a confirmation once speech is heard", () => {
    expect(microphoneTestStatus(listening, "granted", nothing)?.text).toBe(
      "Listening. Say something.",
    );
    expect(microphoneTestStatus(listening, "granted", { ...nothing, heard: true })?.text).toBe(
      "Voice can hear you.",
    );
  });

  test("a quiet microphone gets a hint, until speech arrives", () => {
    expect(microphoneTestStatus(listening, "granted", { ...nothing, quiet: true })?.text).toBe(
      "No sound yet. Speak up, or choose another microphone.",
    );
    expect(
      microphoneTestStatus(listening, "granted", { ...nothing, heard: true, quiet: true })?.text,
    ).toBe("Voice can hear you.");
  });

  test("a failure shows the helper's message as an error", () => {
    const message = "The microphone test stopped while Voice reconnected. Test again.";
    expect(microphoneTestStatus({ kind: "failed", message }, "granted", nothing)).toEqual({
      text: message,
      failed: true,
    });
  });

  test.each(["denied", "notDetermined"] as const)(
    "pressing Test without access (%s) explains why nothing is listening",
    (permission) => {
      const requested = { ...nothing, accessRequested: true };
      expect(microphoneTestStatus(off, permission, requested)).toEqual(access);
      expect(
        microphoneTestStatus({ kind: "failed", message: "Gone" }, permission, requested),
      ).toEqual(access);
    },
  );

  test("the access explanation goes away once access is granted", () => {
    expect(microphoneTestStatus(off, "granted", { ...nothing, accessRequested: true })).toBeNull();
  });
});

describe("microphoneTestAction", () => {
  test("a running test can always be stopped", () => {
    for (const state of [{ kind: "starting" }, listening] as const) {
      expect(microphoneTestAction(state, "denied", false)).toEqual({ kind: "stop", label: "Stop" });
    }
  });

  test.each(["denied", "notDetermined"] as const)(
    "without microphone access (%s) the button still reads Test and asks for access",
    (permission) => {
      expect(microphoneTestAction(off, permission, false)).toEqual({
        kind: "requestAccess",
        label: "Test",
      });
    },
  );

  test("with access, Test starts, including after a failure", () => {
    const failed: MicrophoneTest = { kind: "failed", message: "Gone" };
    const start = { kind: "start", label: "Test", disabled: false };
    expect(microphoneTestAction(off, "granted", true)).toEqual(start);
    expect(microphoneTestAction(failed, "granted", true)).toEqual(start);
  });

  test("Test is disabled when no microphone can be tested", () => {
    expect(microphoneTestAction(off, "granted", false)).toEqual({
      kind: "start",
      label: "Test",
      disabled: true,
    });
  });
});
