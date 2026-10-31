import { ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, test, vi } from "vite-plus/test";

import { dictationLanguages } from "../shared/dictation-language.ts";
import type { TransformId } from "../shared/transforms.ts";
import { startHelper } from "./helper.ts";
import { READ_TIMEOUT_MS } from "./transform-run.ts";
import {
  decodeTarget,
  HELPER_PROTOCOL_VERSION,
  parseHelperEvent,
  type HelperCommand,
  type HelperEvent,
} from "./protocol.ts";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

const line = (value: unknown) => JSON.stringify(value);

describe("parseHelperEvent", () => {
  test("accepts every event variant with exactly the typed fields", () => {
    const events = [
      { type: "ready", version: 17 },
      { type: "hotkey", action: "down", uptimeMs: 1234.5 },
      { type: "hotkey", action: "up", uptimeMs: 2345.5 },
      { type: "hotkey", action: "chord", uptimeMs: 1 },
      { type: "hotkey", action: "cancel", uptimeMs: 1 },
      { type: "hotkey", action: "toggle", uptimeMs: 1 },
      { type: "transform", transformId: "polish" },
      { type: "meeting.shortcut" },
      { type: "selection.result", id: "r", outcome: "selected", text: "hi", via: "accessibility" },
      { type: "selection.result", id: "r", outcome: "selected", text: "hi", via: "copy" },
      { type: "selection.result", id: "r", outcome: "failed", reason: "noSelection" },
      { type: "selection.result", id: "r", outcome: "failed", reason: "keysHeld" },
      { type: "capture.started", id: "a", startMs: 42, relayMs: null, asrState: null },
      { type: "capture.started", id: "a", startMs: 42, relayMs: 3.25, asrState: null },
      { type: "capture.level", id: "a", level: 0.5 },
      { type: "capture.failed", id: "a", message: "denied" },
      { type: "capture.cancelled", id: "a" },
      { type: "capture.stopped", id: "a", reason: "deviceChanged" },
      { type: "capture.stopped", id: "a", reason: "maxDuration" },
      { type: "microphone.test.started", id: "t" },
      { type: "microphone.test.level", id: "t", level: 0.3 },
      { type: "microphone.test.ended", id: "t" },
      { type: "microphone.test.failed", id: "t", message: "Finish dictating, then test again." },
      {
        type: "transcript",
        id: "a",
        text: "hi",
        audioMs: 1200,
        asrMs: 300,
        speechMs: 900,
        relayMs: null,
        target: { bundleId: "com.google.chrome", host: "mail.google.com" },
      },
      {
        type: "transcript",
        id: "a",
        text: "hi",
        audioMs: 1200,
        asrMs: 300,
        speechMs: 900,
        relayMs: null,
        target: { bundleId: "com.apple.mobilesms", host: null },
      },
      {
        type: "transcript",
        id: "a",
        text: "",
        audioMs: 40,
        asrMs: 0,
        speechMs: null,
        relayMs: null,
        target: null,
      },
      { type: "transcript.failed", id: "a", message: "no model" },
      {
        type: "insert.result",
        id: "a",
        method: "accessibility",
        route: "direct",
      },
      {
        type: "insert.result",
        id: "a",
        method: "accessibility",
        route: "late",
      },
      {
        type: "insert.result",
        id: "a",
        method: "paste",
        route: "pasteOnlyApp",
        clipboardSaveMs: 1.5,
      },
      {
        type: "insert.result",
        id: "a",
        method: "none",
        reason: "focusChanged",
      },
      {
        type: "insert.result",
        id: "a",
        method: "none",
        reason: "selectionChanged",
      },
      {
        type: "permissions",
        microphone: "granted",
        accessibility: "denied",
        systemAudio: "notDetermined",
      },
      { type: "asr.status", state: "ready", message: null },
      { type: "log", level: "info", message: "hello" },
      {
        type: "apps.listed",
        apps: [
          {
            bundleId: "com.apple.mail",
            name: "Mail",
            path: "/System/Applications/Mail.app",
            modifiedMs: 1760000000123,
            browser: false,
          },
          {
            bundleId: "com.google.Chrome",
            name: "Google Chrome",
            path: "/Applications/Google Chrome.app",
            modifiedMs: 1,
            browser: true,
          },
        ],
      },
      {
        type: "icons.rendered",
        id: "7",
        icons: [{ path: "/Applications/Slack.app", png: "iVBORw0KGgo=" }],
      },
    ];
    for (const event of events) expect(parseHelperEvent(line(event))).toEqual(event);
  });

  test("drops unknown fields and fills optional ones", () => {
    expect(
      parseHelperEvent(line({ type: "insert.result", id: "a", method: "paste", extra: 1 })),
    ).toEqual({
      type: "insert.result",
      id: "a",
      method: "paste",
      route: null,
      clipboardSaveMs: null,
    });
    expect(
      parseHelperEvent(line({ type: "asr.status", state: "failed", message: "boom" })),
    ).toEqual({
      type: "asr.status",
      state: "failed",
      message: "boom",
    });
  });

  test("accepts method none without a reason, as the spec marks reason optional", () => {
    expect(parseHelperEvent(line({ type: "insert.result", id: "a", method: "none" }))).toEqual({
      type: "insert.result",
      id: "a",
      method: "none",
      reason: null,
    });
    expect(
      parseHelperEvent(line({ type: "capture.failed", id: "a", reason: "novel", message: "m" })),
    ).toEqual({ type: "capture.failed", id: "a", message: "m" });
  });

  test("accepts a busy capture failure, which the helper reports while it still holds a capture", () => {
    expect(
      parseHelperEvent(
        line({ type: "capture.failed", id: "a", reason: "busy", message: "still capturing" }),
      ),
    ).toEqual({ type: "capture.failed", id: "a", message: "still capturing" });
  });

  test("clamps levels into 0..1", () => {
    expect(parseHelperEvent(line({ type: "capture.level", id: "a", level: 3 }))).toEqual({
      type: "capture.level",
      id: "a",
      level: 1,
    });
    expect(parseHelperEvent(line({ type: "capture.level", id: "a", level: -3 }))).toEqual({
      type: "capture.level",
      id: "a",
      level: 0,
    });
    expect(parseHelperEvent(line({ type: "microphone.test.level", id: "t", level: 2 }))).toEqual({
      type: "microphone.test.level",
      id: "t",
      level: 1,
    });
  });

  test.each([undefined, null, 42, {}, [], "unknown"])(
    "normalizes an unsupported insertion reason %j to null",
    (reason) => {
      expect(
        parseHelperEvent(line({ type: "insert.result", id: "a", method: "none", reason })),
      ).toEqual({
        type: "insert.result",
        id: "a",
        method: "none",
        reason: null,
      });
    },
  );

  test.each([undefined, null, 42, {}, []])(
    "normalizes a missing or invalid ASR message %j to null",
    (message) => {
      expect(parseHelperEvent(line({ type: "asr.status", state: "ready", message }))).toEqual({
        type: "asr.status",
        state: "ready",
        message: null,
      });
    },
  );

  test.each([undefined, "900", {}])(
    "keeps a transcript whose speech span %j is missing or invalid, with a null span",
    (speechMs) => {
      expect(
        parseHelperEvent(
          line({ type: "transcript", id: "a", text: "hi", audioMs: 1200, asrMs: 300, speechMs }),
        ),
      ).toEqual({
        type: "transcript",
        id: "a",
        text: "hi",
        audioMs: 1200,
        asrMs: 300,
        speechMs: null,
        relayMs: null,
        target: null,
      });
    },
  );

  test.each([
    [{ bundleId: " com.google.Chrome ", host: "Mail.Google.com" }, "mail.google.com"],
    [{ bundleId: "com.google.Chrome", host: "127.0.0.1" }, null],
    [{ bundleId: "com.google.Chrome", host: "not a host" }, null],
    [{ bundleId: "com.google.Chrome", host: 7 }, null],
  ])("decodes the target %j to a lowercase bundle id and the host %j", (target, host) => {
    expect(
      parseHelperEvent(
        line({ type: "transcript", id: "a", text: "hi", audioMs: 1, asrMs: 1, target }),
      ),
    ).toMatchObject({ target: { bundleId: "com.google.chrome", host } });
  });

  test.each([
    undefined,
    "x",
    42,
    [],
    {},
    { bundleId: 1, host: null },
    { bundleId: "a" },
    { bundleId: null, host: null },
    { bundleId: null, host: "mail.google.com" },
    { bundleId: "com.apple/mail", host: null },
    { bundleId: "com.google.Chrome" },
  ])("keeps a transcript whose target %j is missing or invalid, with a null target", (target) => {
    expect(
      parseHelperEvent(
        line({ type: "transcript", id: "a", text: "hi", audioMs: 1, asrMs: 1, target }),
      ),
    ).toEqual({
      type: "transcript",
      id: "a",
      text: "hi",
      audioMs: 1,
      asrMs: 1,
      speechMs: null,
      relayMs: null,
      target: null,
    });
  });

  test("keeps the rest of an app list when one entry is malformed", () => {
    const mail = {
      bundleId: "com.apple.mail",
      name: "Mail",
      path: "/System/Applications/Mail.app",
      modifiedMs: 1,
      browser: false,
    };
    const slack = {
      bundleId: "com.tinyspeck.slackmacgap",
      name: "Slack",
      path: "/Applications/Slack.app",
      modifiedMs: 1,
      browser: false,
    };
    expect(
      parseHelperEvent(
        line({
          type: "apps.listed",
          apps: [
            mail,
            {
              bundleId: 7,
              name: "Seven",
              path: "/Applications/Seven.app",
              modifiedMs: 1,
              browser: false,
            },
            {
              bundleId: "a.c",
              name: "C",
              path: "/Applications/C.app",
              modifiedMs: "new",
              browser: false,
            },
            {
              bundleId: "a.d",
              name: "D",
              path: "/Applications/D.app",
              modifiedMs: 1,
              browser: "yes",
            },
            { bundleId: "a.b", name: "B" },
            null,
            slack,
          ],
        }),
      ),
    ).toEqual({ type: "apps.listed", apps: [mail, slack] });
  });

  test("keeps the rest of the icons when one entry is malformed", () => {
    const slack = { path: "/Applications/Slack.app", png: "iVBORw0KGgo=" };
    expect(
      parseHelperEvent(
        line({
          type: "icons.rendered",
          id: "7",
          icons: [{ path: "/Applications/Mail.app" }, slack, { path: 3, png: "x" }],
        }),
      ),
    ).toEqual({ type: "icons.rendered", id: "7", icons: [slack] });
  });

  test.each([
    '{"type":"ready","version":1e400}',
    '{"type":"capture.started","id":"a","startMs":1e400}',
    '{"type":"capture.level","id":"a","level":-1e400}',
    '{"type":"transcript","id":"a","text":"hi","audioMs":1e400,"asrMs":1}',
    '{"type":"transcript","id":"a","text":"hi","audioMs":1,"asrMs":1e400}',
  ])("rejects non-finite numbers in valid JSON %s", (input) => {
    expect(parseHelperEvent(input)).toBeNull();
  });

  test.each([
    ["not json", "{nope"],
    ["an array", "[1]"],
    ["an unknown type", line({ type: "capture.exploded", id: "a" })],
    ["a missing id", line({ type: "capture.started", startMs: 1 })],
    ["a test failure without a message", line({ type: "microphone.test.failed", id: "t" })],
    ["a wrong field type", line({ type: "transcript", id: "a", text: 5, audioMs: 1, asrMs: 1 })],
    ["an unknown enum value", line({ type: "hotkey", action: "sideways" })],
    ["a NaN number", '{"type":"capture.level","id":"a","level":NaN}'],
    ["an app list that is not a list", line({ type: "apps.listed", apps: "Mail" })],
    ["icons without their request id", line({ type: "icons.rendered", icons: [] })],
    [
      "an unknown permission state",
      line({
        type: "permissions",
        microphone: "maybe",
        accessibility: "granted",
        systemAudio: "notDetermined",
      }),
    ],
  ])("rejects %s", (_name, input) => {
    expect(parseHelperEvent(input)).toBeNull();
  });
});

describe("microphone catalog", () => {
  test("decodes input devices and the system default", () => {
    const event = {
      type: "microphones.changed",
      devices: [{ uid: "usb", name: "USB Microphone" }],
      defaultUid: "usb",
    };
    expect(parseHelperEvent(JSON.stringify(event))).toEqual(event);
    expect(parseHelperEvent(JSON.stringify({ ...event, devices: [], defaultUid: null }))).toEqual({
      ...event,
      devices: [],
      defaultUid: null,
    });
  });

  test.each([
    { devices: [{}], defaultUid: null },
    { devices: [{ uid: "", name: "USB" }], defaultUid: null },
    { devices: [], defaultUid: 4 },
    { devices: [] },
  ])("rejects a malformed catalog %j", (fields) =>
    expect(parseHelperEvent(JSON.stringify({ type: "microphones.changed", ...fields }))).toBeNull(),
  );

  test("decodes enumeration failure", () => {
    const event = { type: "microphones.unavailable", message: "Unavailable" };
    expect(parseHelperEvent(JSON.stringify(event))).toEqual(event);
  });
});

const WireSchema = Schema.Record(Schema.String, Schema.Unknown);
const WireCaseSchema = Schema.Struct({ name: Schema.String, wire: WireSchema });
const RequiredCaseSchema = Schema.Struct({
  ...WireCaseSchema.fields,
  required: Schema.Array(Schema.String),
});
const ParsedCaseSchema = Schema.Struct({ ...WireCaseSchema.fields, parsed: Schema.Unknown });
const InvalidCaseSchema = Schema.Struct({ name: Schema.String, line: Schema.String });
const CorpusSchema = Schema.Struct({
  protocolVersion: Schema.Int,
  selectionReadMaxMs: Schema.Finite,
  languages: Schema.Array(Schema.String),
  versions: Schema.Array(Schema.Struct({ version: Schema.Int, compatible: Schema.Boolean })),
  commands: Schema.Array(RequiredCaseSchema),
  nativeCommands: Schema.Array(RequiredCaseSchema),
  optionalCommands: Schema.Array(WireCaseSchema),
  invalidCommands: Schema.Array(InvalidCaseSchema),
  events: Schema.Array(Schema.Struct({ ...RequiredCaseSchema.fields, parsed: Schema.Unknown })),
  normalizedEvents: Schema.Array(ParsedCaseSchema),
  invalidEvents: Schema.Array(InvalidCaseSchema),
});
const rawCorpus: unknown = JSON.parse(
  readFileSync(new URL("../../../../test-fixtures/helper-protocol.json", import.meta.url), "utf8"),
);
const corpus = Schema.decodeUnknownSync(CorpusSchema)(rawCorpus);
const decodeWire = Schema.decodeUnknownSync(Schema.fromJsonString(WireSchema));

const microphone = { uid: "usb", name: "Synthetic USB" };
const captureStart: Extract<HelperCommand, { type: "capture.start" }> = {
  type: "capture.start",
  id: "s1",
  language: "en",
  outputVolumeScale: null,
  microphone: null,
  detectHost: true,
  hotkeyUptimeMs: 1234.5,
};
const commandCases = {
  "hotkey.configure": {
    type: "hotkey.configure",
    key: "fn",
    toggleKey: null,
    transforms: [],
    meeting: null,
  },
  "hotkey.configure.toggle": {
    type: "hotkey.configure",
    key: "rightOption",
    toggleKey: "rightCommand",
    transforms: [],
    meeting: null,
  },
  "hotkey.configure.transforms": {
    type: "hotkey.configure",
    key: "rightOption",
    toggleKey: null,
    transforms: [
      { id: "polish" as TransformId, keycode: 18, modifiers: ["option"] },
      { id: "c1" as TransformId, keycode: 40, modifiers: ["control", "option", "command"] },
    ],
    meeting: null,
  },
  "hotkey.configure.meeting": {
    type: "hotkey.configure",
    key: "fn",
    toggleKey: null,
    transforms: [],
    meeting: { keycode: 46, modifiers: ["option"] },
  },
  "microphone.configure": { type: "microphone.configure", microphone },
  "microphone.configure.default": { type: "microphone.configure", microphone: null },
  "capture.start": captureStart,
  "capture.start.pinned": {
    ...captureStart,
    language: "pl",
    outputVolumeScale: 0.3,
    microphone,
    detectHost: false,
    hotkeyUptimeMs: undefined,
  },
  "capture.start.muted": { ...captureStart, outputVolumeScale: 0, hotkeyUptimeMs: undefined },
  "capture.stop": { type: "capture.stop", id: "s1", hotkeyUptimeMs: 2345.5 },
  "capture.cancel": { type: "capture.cancel", id: "s1" },
  "microphone.test.start": { type: "microphone.test.start", id: "t1", microphone: null },
  "microphone.test.start.pinned": { type: "microphone.test.start", id: "t1", microphone },
  "microphone.test.stop": { type: "microphone.test.stop", id: "t1" },
  insert: { type: "insert", id: "s1", text: "Zażółć /tmp/synthetic\nAda 42", html: null },
  "insert.html": { type: "insert", id: "s1", text: "Hi Ada", html: "Hi <strong>Ada</strong>" },
  "selection.read": { type: "selection.read", id: "r1" },
  "transform.end": { type: "transform.end", id: "r1" },
  "permissions.check": { type: "permissions.check" },
  "permissions.request": { type: "permissions.request", kind: "accessibility" },
  "permissions.request.microphone": { type: "permissions.request", kind: "microphone" },
  "asr.prepare": { type: "asr.prepare", download: true },
  "asr.prepare.cached": { type: "asr.prepare", download: false },
  "asr.remove": { type: "asr.remove" },
  "test.target": {
    type: "test.target",
    target: Option.getOrThrow(
      decodeTarget({ bundleId: "com.apple.safari", host: "mail.example.com" }),
    ),
  },
  "test.target.app": {
    type: "test.target",
    target: Option.getOrThrow(decodeTarget({ bundleId: "com.apple.textedit", host: null })),
  },
  "test.target.clear": { type: "test.target", target: null },
  "apps.list": { type: "apps.list" },
  "icons.render": { type: "icons.render", id: "icons-1", paths: ["/Applications/Synthetic.app"] },
  "icons.render.empty": { type: "icons.render", id: "icons-1", paths: [] },
  "permissions.request.systemAudio": { type: "permissions.request", kind: "systemAudio" },
  "meeting.start": {
    type: "meeting.start",
    id: "m1",
    dir: "/tmp/synthetic/meetings/m1",
    baseMs: 0,
    fromMs: { mic: 1250.5, system: 0 },
    language: "pl",
    microphone: null,
  },
  "meeting.start.pinned": {
    type: "meeting.start",
    id: "m1",
    dir: "/tmp/synthetic/meetings/m1",
    baseMs: 600_000,
    fromMs: { mic: 600_000, system: 600_000 },
    language: "auto",
    microphone,
  },
  "meeting.stop": { type: "meeting.stop", id: "m1" },
  "meeting.cancel": { type: "meeting.cancel", id: "m1" },
  "meeting.transcribe": {
    type: "meeting.transcribe",
    id: "m1",
    dir: "/tmp/synthetic/meetings/m1",
    baseMs: 0,
    fromMs: { mic: 1250.5, system: 0 },
    language: "en",
  },
} satisfies Record<HelperCommand["type"], HelperCommand> & Record<string, HelperCommand>;

const eventTypes = {
  "microphones.changed": true,
  "microphones.unavailable": true,
  ready: true,
  hotkey: true,
  transform: true,
  "meeting.shortcut": true,
  "selection.result": true,
  "capture.started": true,
  "capture.level": true,
  "capture.failed": true,
  "capture.cancelled": true,
  "capture.stopped": true,
  "microphone.test.started": true,
  "microphone.test.level": true,
  "microphone.test.ended": true,
  "microphone.test.failed": true,
  transcript: true,
  "transcript.failed": true,
  "insert.result": true,
  permissions: true,
  "asr.status": true,
  log: true,
  "apps.listed": true,
  "icons.rendered": true,
  "meeting.started": true,
  "meeting.failed": true,
  "meeting.segment": true,
  "meeting.drained": true,
} satisfies Record<HelperEvent["type"], true>;

function startContractHelper(configure: () => HelperCommand[] = () => []) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new ChildProcess(), { stdin, stdout, stderr });
  const lines: string[] = [];
  const events: HelperEvent[] = [];
  stdin.on("data", (chunk: Buffer) => lines.push(chunk.toString("utf8")));
  stdin.once("finish", () => {
    Object.defineProperty(child, "exitCode", { value: 0 });
    stdout.end();
    stderr.end();
    child.emit("close", 0, null);
  });
  vi.mocked(spawn).mockReturnValue(child);
  const helper = startHelper({
    binary: "synthetic-helper",
    modelsDir: "/synthetic/models",
    stateDir: "/synthetic/state",
    env: {},
    configure,
    onEvent: (event) => events.push(event),
    onExit: () => {},
    log: () => {},
  });
  return { helper, stdout, lines, events };
}

describe("shared helper protocol corpus", () => {
  test("main waits for a selection read longer than the helper can take to answer", () => {
    expect(READ_TIMEOUT_MS).toBeGreaterThan(corpus.selectionReadMaxMs);
  });

  test("covers every command, event and language without duplicate cases", () => {
    expect(corpus.protocolVersion).toBe(HELPER_PROTOCOL_VERSION);
    expect(corpus.languages.toSorted()).toEqual(
      dictationLanguages.map(({ value }) => value).toSorted(),
    );
    expect(corpus.commands.map(({ name }) => name).toSorted()).toEqual(
      Object.keys(commandCases).toSorted(),
    );
    expect(new Set(corpus.events.map(({ wire }) => wire.type))).toEqual(
      new Set(Object.keys(eventTypes)),
    );
    for (const cases of [
      corpus.commands,
      corpus.nativeCommands,
      corpus.events,
      corpus.normalizedEvents,
      corpus.invalidCommands,
      corpus.invalidEvents,
      corpus.optionalCommands,
    ]) {
      expect(new Set(cases.map(({ name }) => name)).size).toBe(cases.length);
    }
  });

  test("sends concrete typed commands through the real helper transport", async () => {
    const h = startContractHelper();
    const entries = Object.entries(commandCases);
    try {
      for (const [, command] of entries) h.helper.send(command);
      expect(h.lines).toHaveLength(entries.length);
      const emitted = new Map<string, unknown>();
      entries.forEach(([name], index) => {
        const sent = h.lines[index] ?? "";
        expect(sent.endsWith("\n")).toBe(true);
        expect(sent.trimEnd()).not.toContain("\n");
        emitted.set(name, decodeWire(sent));
      });
      for (const { name, wire } of corpus.commands) expect(emitted.get(name), name).toEqual(wire);
    } finally {
      await h.helper.stop();
    }
  });

  test("sends every supported language with the shared capture shape", async () => {
    const expected = corpus.commands.find(({ name }) => name === "capture.start");
    expect(expected).toBeDefined();
    const h = startContractHelper();
    try {
      dictationLanguages.forEach(({ value }) =>
        h.helper.send({ ...captureStart, language: value }),
      );
      expect(h.lines).toHaveLength(corpus.languages.length);
      dictationLanguages.forEach(({ value }, index) => {
        expect(decodeWire(h.lines[index] ?? "")).toEqual({ ...expected?.wire, language: value });
      });
    } finally {
      await h.helper.stop();
    }
  });

  test.each(corpus.versions)(
    "only accepts ready version $version when compatible=$compatible",
    async ({ version, compatible }) => {
      const configure = vi.fn((): HelperCommand[] => []);
      const h = startContractHelper(configure);
      try {
        h.stdout.write(`${JSON.stringify({ type: "ready", version })}\n`);
        expect(configure).toHaveBeenCalledTimes(compatible ? 1 : 0);
        expect(h.events).toEqual(compatible ? [{ type: "ready", version }] : []);
      } finally {
        await h.helper.stop();
      }
    },
  );

  test.each(corpus.events)("parses the Swift serialization for $name", ({ wire, parsed }) => {
    expect(parseHelperEvent(line(wire))).toEqual(parsed);
  });

  test.each(corpus.events)(
    "rejects missing and mistyped required fields for $name",
    ({ name, wire, required }) => {
      expect(required).toContain("type");
      for (const field of required) {
        expect(Object.hasOwn(wire, field), `${name}.${field}`).toBe(true);
        const missing = { ...wire };
        delete missing[field];
        expect(parseHelperEvent(line(missing)), `${name} without ${field}`).toBeNull();
        expect(
          parseHelperEvent(line({ ...wire, [field]: { invalid: true } })),
          `${name} with mistyped ${field}`,
        ).toBeNull();
      }
    },
  );

  test.each(corpus.normalizedEvents)("normalizes optional data for $name", ({ wire, parsed }) => {
    expect(parseHelperEvent(line(wire))).toEqual(parsed);
  });

  test.each(corpus.invalidEvents)("rejects invalid event $name", ({ line: input }) => {
    expect(parseHelperEvent(input)).toBeNull();
  });
});
