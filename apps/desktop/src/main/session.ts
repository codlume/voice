import { randomUUID } from "node:crypto";
import {
  decodeCaptureEvent,
  decodeProviderEvent,
  decodeTargetSelected,
  type Attempt,
  type CaptureCommand,
  type InsertionOutcome,
  type ProviderRequest,
  type SessionCommand,
  type SessionSnapshot,
  type ProviderFailure,
  type RecoveryEntry,
  type ShortcutAction,
  type TargetStatus,
} from "@voice/contracts/session";

const failureMessages: Record<ProviderFailure, string> = {
  connection: "Connection lost. Audio remains in memory; transcription needs internet.",
  rejected: "Deepgram rejected the key. Replace it in Settings.",
  quota: "Deepgram quota is exhausted. Check your account billing.",
  "rate-limit": "Deepgram is rate limiting requests. Try a new session later.",
  incomplete: "Transcription was incomplete. Audio and available text remain in memory.",
  protocol:
    "The provider response did not match the required model or stream. Available work remains in memory.",
  worker: "The transcription worker stopped. Available work remains in memory.",
};
const targetMessages: Record<Exclude<TargetStatus, "eligible">, string> = {
  none: "No text field was focused when dictation started.",
  unsupported: "The focused control does not support direct insertion.",
  protected: "The focused field is protected.",
  terminal: "Terminal insertion is not supported yet.",
  unavailable: "The focused app could not be inspected. Check Accessibility access.",
};
const insertionMessages: Record<Exclude<InsertionOutcome, "inserted" | "uncertain">, string> = {
  changed: "Focus moved away from the original field.",
  closed: "The original field closed.",
  protected: "The original field is protected.",
  unsupported: "The original field no longer accepts direct insertion.",
  missing: "No destination was established.",
  failed: "The field rejected the insertion.",
};
const uncertainCause =
  "Check your target. Voice could not confirm the insertion and will not retry automatically.";
type Origin = "practice" | "dictation";
type Active = Attempt & {
  origin: Origin;
  mode: "hold" | "toggle";
  audio: Uint8Array[];
  samples: number;
  text: string;
  providerStarted: boolean;
  stopped: boolean;
  failure?: string;
  stopRequested: boolean;
  deadline?: number;
  stopTime?: number;
  target?: TargetStatus;
  inserting: boolean;
};
type Armed = { id: string; text: string; inserting: boolean };
export function createSession(options: {
  available: () => boolean;
  device: () => string | null;
  credential: () => Promise<string>;
  capture: (command: CaptureCommand) => void;
  provider: (command: ProviderRequest) => void;
  changed: () => void;
  copy: (text: string) => Promise<boolean>;
  access: (reason: "authenticated" | "rejected" | "quota" | "rate-limit") => void;
  target: {
    capture: (session: string) => Promise<TargetStatus>;
    arm: (session: string) => Promise<void>;
    insert: (session: string, text: string) => Promise<InsertionOutcome>;
    release: (session: string) => void;
  };
  // A session or armed paste is in progress, so the native cancel key belongs to Voice.
  engaged: (active: boolean) => void;
}) {
  let state: SessionSnapshot = {
    phase: "idle",
    origin: null,
    armedPaste: null,
    canStart: false,
    warning: false,
    message: "Ready.",
    practiceText: "",
    recovery: [],
    recoveryMessage: "",
    quitWarning: false,
    pendingPractice: null,
    latestSuccessful: null,
  };
  let active: Active | undefined;
  let armed: Armed | undefined;
  let held: string | undefined;
  let closed = false;
  let stoppingCapture: Attempt | undefined;
  const retained = new Map<string, { audio: Uint8Array[]; entry: RecoveryEntry }>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  function later(callback: () => void, delay: number) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delay);
    timers.add(timer);
  }
  function clearTimers() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  }
  function update(change: Partial<SessionSnapshot>) {
    state = { ...state, ...change };
    options.changed();
  }
  function engage() {
    try {
      options.engaged(!!active || !!armed);
    } catch {
      /* The helper owns nothing that changes session state. */
    }
  }
  function releaseTarget(session: string) {
    try {
      options.target.release(session);
    } catch {
      /* A failed helper has no target to release. */
    }
  }
  function retain(
    id: string,
    text: string,
    transcription: RecoveryEntry["transcription"],
    audio: Uint8Array[],
    cause: string,
    delivery: RecoveryEntry["delivery"],
  ) {
    retained.set(id, {
      audio,
      entry: { id, text, transcription, hasAudio: audio.length > 0, cause, delivery },
    });
  }
  function sendCapture(type: "capture.stop" | "capture.cancel", current: Active) {
    try {
      options.capture({ type, session: current.session, attempt: current.attempt });
    } catch {
      /* The failed helper cannot continue capture. */
    }
  }
  function end(phase: "failed" | "cancelled" | "complete", message: string) {
    const current = active;
    if (!current) return;
    active = undefined;
    clearTimers();
    if (!current.stopped) {
      stoppingCapture = { session: current.session, attempt: current.attempt };
      sendCapture("capture.cancel", current);
    }
    options.provider({ type: "cancel", session: current.session, attempt: current.attempt });
    if (current.origin === "dictation") releaseTarget(current.session);
    // Delivery paths retain their own complete entry before ending; keep it intact.
    if (
      phase !== "complete" &&
      !retained.has(current.session) &&
      (current.audio.length || current.text)
    )
      retain(current.session, current.text, "incomplete", current.audio, message, "undelivered");
    engage();
    update({ phase, message, warning: false });
  }
  function fail(message: string) {
    end("failed", message);
  }
  function recordingMessage(current: Active) {
    if (current.origin === "practice") return "Recording. Speak, then press Stop.";
    const control =
      current.mode === "hold"
        ? "Recording. Release the shortcut to finish."
        : "Recording. Use the toggle shortcut or Stop to finish.";
    if (!current.target || current.target === "eligible") return control;
    return `${control} ${targetMessages[current.target]} The transcript will go to recovery.`;
  }
  function requestStop(message?: string) {
    const current = active;
    if (!current || current.stopRequested) return;
    current.stopRequested = true;
    current.stopTime = performance.now();
    current.deadline = current.stopTime + (current.samples <= 480_000 ? 10_000 : 30_000);
    update({ phase: "processing", warning: false, message: message ?? "Finishing transcription…" });
    sendCapture("capture.stop", current);
    const expire = () => {
      if (active !== current || current.deadline === undefined || current.inserting) return;
      const remaining = current.deadline - performance.now();
      if (remaining > 0) later(expire, remaining);
      else fail("Processing timed out. Audio and available text remain in memory.");
    };
    later(expire, current.deadline - performance.now());
  }
  function providerStop(current: Active) {
    if (current.failure) {
      fail(current.failure);
      return;
    }
    if (current.providerStarted)
      options.provider({
        type: "stop",
        session: current.session,
        attempt: current.attempt,
        frames: current.audio.length,
        samples: current.samples,
      });
  }
  function interruptDelivery(message: string) {
    const pending = state.pendingPractice && retained.get(state.pendingPractice);
    if (!pending) return;
    pending.entry = {
      ...pending.entry,
      delivery: "uncertain",
      cause: `${message} Check your target.`,
    };
    update({ pendingPractice: null, practiceText: state.latestSuccessful?.text ?? "" });
  }
  function resolveText(id: string) {
    const recovery = retained.get(id);
    if (!recovery) return;
    if (recovery.entry.transcription === "complete")
      state = { ...state, latestSuccessful: { id, text: recovery.entry.text } };
    if (!recovery.audio.length) retained.delete(id);
    if (state.pendingPractice === id) state = { ...state, pendingPractice: null };
  }
  function start(origin: Origin, mode: Active["mode"]) {
    if (closed || active || armed || stoppingCapture || state.quitWarning) return;
    if (!options.available() || retained.size >= 5) {
      update({
        phase: "failed",
        origin,
        message:
          retained.size >= 5
            ? "Recovery is full. Resolve or discard a session before starting another."
            : "Complete or repair dictation setup before starting.",
      });
      return;
    }
    if (origin === "practice")
      interruptDelivery("Practice delivery was not confirmed before the next session.");
    const id = randomUUID();
    const current: Active = {
      session: id,
      attempt: randomUUID(),
      origin,
      mode,
      audio: [],
      samples: 0,
      text: "",
      providerStarted: false,
      stopped: false,
      stopRequested: false,
      inserting: false,
    };
    active = current;
    // The capture command leaves first; UI updates and the helper's shortcut state follow it.
    let started = true;
    try {
      options.capture({
        type: "capture.start",
        session: current.session,
        attempt: current.attempt,
        device: options.device(),
      });
    } catch {
      started = false;
    }
    engage();
    if (!started) {
      state = { ...state, origin };
      fail("Microphone capture could not start. Check your device and permissions.");
      return;
    }
    update({ phase: "starting", origin, warning: false, message: "Starting microphone…" });
    if (origin === "dictation") {
      // Remember the target focused at the shortcut. Capture startup never waits for this.
      const remember = (target: TargetStatus) => {
        if (active !== current) return;
        current.target = target;
        if (state.phase === "recording") update({ message: recordingMessage(current) });
      };
      options.target.capture(current.session).then(remember, () => remember("unavailable"));
    }
    later(() => {
      if (active === current && state.phase === "starting")
        fail("The microphone did not provide audio. Check your device and permissions.");
    }, 3_000);
    void options
      .credential()
      .then((key) => {
        if (active !== current) return;
        current.providerStarted = true;
        options.provider({
          type: "start",
          session: current.session,
          attempt: current.attempt,
          key,
        });
        for (const [sequence, pcm] of current.audio.entries())
          options.provider({
            type: "audio",
            session: current.session,
            attempt: current.attempt,
            sequence,
            pcm,
          });
        if (current.stopped) providerStop(current);
      })
      .catch(() => {
        if (active !== current) return;
        current.failure = "The saved key could not be read. Repair Keychain access in Settings.";
        requestStop(current.failure);
        if (current.stopped) fail(current.failure);
      });
  }
  function cancel() {
    const current = active;
    if (!current || current.inserting) return;
    current.audio = [];
    end("cancelled", "Cancelled. Any produced text remains in memory.");
  }
  function interrupt(message: string) {
    interruptDelivery(message);
    const current = active;
    if (!current || current.inserting) return;
    current.failure = message;
    requestStop(message);
    options.provider({ type: "cancel", session: current.session, attempt: current.attempt });
    if (current.stopped) fail(message);
  }
  function finishInsertion(current: Active, text: string, outcome: InsertionOutcome) {
    if (active !== current) return;
    if (outcome === "inserted") {
      state = { ...state, latestSuccessful: { id: current.session, text } };
      end("complete", "Inserted.");
      return;
    }
    if (outcome === "uncertain") {
      retain(current.session, text, "complete", [], uncertainCause, "uncertain");
      end("failed", "Check your target. The transcript is in recovery.");
      return;
    }
    retain(
      current.session,
      text,
      "complete",
      [],
      `${insertionMessages[outcome]} Text kept for recovery.`,
      "failed",
    );
    end("failed", `Not inserted. ${insertionMessages[outcome]} The transcript is in recovery.`);
  }
  function deliver(current: Active, text: string) {
    const target = current.target ?? "unavailable";
    if (target !== "eligible") {
      retain(
        current.session,
        text,
        "complete",
        [],
        `${targetMessages[target]} Text kept for recovery.`,
        "failed",
      );
      end("failed", `Not inserted. ${targetMessages[target]} The transcript is in recovery.`);
      return;
    }
    current.inserting = true;
    update({ phase: "inserting", message: "Inserting…" });
    options.target.insert(current.session, text).then(
      (outcome) => finishInsertion(current, text, outcome),
      () => finishInsertion(current, text, "uncertain"),
    );
  }
  // Escape and clickable Cancel share this path for both sessions and armed pastes.
  function cancelCurrent() {
    if (armed) disarm("Paste cancelled. The text remains in recovery.");
    else cancel();
  }
  function disarm(message: string) {
    const current = armed;
    if (!current) return;
    armed = undefined;
    releaseTarget(current.id);
    engage();
    update({ armedPaste: null, recoveryMessage: message });
  }
  function finishPaste(current: Armed, outcome: InsertionOutcome) {
    if (armed !== current) return;
    armed = undefined;
    engage();
    const recovery = retained.get(current.id);
    if (outcome === "inserted") {
      if (recovery) {
        recovery.entry = { ...recovery.entry, delivery: "inserted" };
        resolveText(current.id);
      }
      update({
        armedPaste: null,
        recoveryMessage: recovery?.audio.length
          ? "Inserted available text. The incomplete recording still needs recovery or Discard."
          : "Inserted.",
      });
      return;
    }
    if (outcome === "uncertain") {
      if (recovery)
        recovery.entry = { ...recovery.entry, delivery: "uncertain", cause: uncertainCause };
      update({
        armedPaste: null,
        recoveryMessage:
          "Check your target. Voice could not confirm the paste and will not retry. The text remains in recovery.",
      });
      return;
    }
    if (recovery) recovery.entry = { ...recovery.entry, delivery: "failed" };
    update({
      armedPaste: null,
      recoveryMessage: `Not pasted. ${insertionMessages[outcome]} The text remains in recovery.`,
    });
  }
  async function paste(id: string) {
    const text =
      retained.get(id)?.entry.text ??
      (state.latestSuccessful?.id === id ? state.latestSuccessful.text : undefined);
    if (!text || active || armed || stoppingCapture || state.quitWarning) return;
    const current: Armed = { id, text, inserting: false };
    armed = current;
    engage();
    update({
      armedPaste: id,
      recoveryMessage:
        "Click into the field where the text should go. Voice pastes once, into that field. Press the cancel shortcut or Cancel paste to keep it in recovery.",
    });
    later(() => {
      if (armed === current && !current.inserting)
        disarm("Paste timed out. The text remains in recovery.");
    }, 20_000);
    try {
      await options.target.arm(id);
    } catch {
      if (armed === current)
        disarm("Paste is unavailable right now. The text remains in recovery.");
    }
  }
  return {
    snapshot: () => ({
      ...state,
      recovery: [...retained.values()].map(({ entry }) => Object.assign({}, entry)),
      canStart:
        !closed &&
        !state.quitWarning &&
        !active &&
        !armed &&
        !stoppingCapture &&
        options.available() &&
        retained.size < 5,
    }),
    async execute(command: SessionCommand) {
      if (closed) return;
      if (command.type === "app.quit.cancel") {
        update({ quitWarning: false });
        return;
      }
      if (command.type === "practice.delivered") {
        if (state.pendingPractice !== command.id) return;
        resolveText(command.id);
        update({ message: "Practice transcript ready." });
        return;
      }
      if (command.type === "recovery.paste") {
        await paste(command.id);
        return;
      }
      if (command.type === "recovery.discard") {
        if (armed?.id === command.id) disarm("Paste cancelled.");
        if (state.latestSuccessful?.id === command.id) {
          update({
            latestSuccessful: null,
            practiceText: state.pendingPractice ? state.practiceText : "",
            recoveryMessage: "Discarded the latest successful transcript.",
          });
          return;
        }
        const discarded = retained.get(command.id);
        if (!discarded) return;
        discarded.audio = [];
        retained.delete(command.id);
        if (state.pendingPractice === command.id)
          state = {
            ...state,
            pendingPractice: null,
            practiceText: state.latestSuccessful?.text ?? "",
          };
        update({ recoveryMessage: "Discarded. Its audio and text have been released." });
        return;
      }
      if (command.type === "recovery.copy") {
        const recovery = retained.get(command.id);
        const latest = state.latestSuccessful?.id === command.id ? state.latestSuccessful : null;
        const text = recovery?.entry.text ?? latest?.text;
        if (!text) return;
        let copied = false;
        try {
          copied = await options.copy(text);
        } catch {
          /* Preserve work on clipboard failure. */
        }
        if (
          closed ||
          (recovery ? retained.get(command.id) !== recovery : state.latestSuccessful !== latest)
        )
          return;
        if (recovery)
          recovery.entry = { ...recovery.entry, delivery: copied ? "copied" : "failed" };
        if (copied) resolveText(command.id);
        update({
          recoveryMessage: copied
            ? recovery?.audio.length
              ? "Copied available text. The incomplete recording still needs recovery or Discard."
              : "Copied."
            : "Copy failed. Your text and any recording remain available.",
        });
        return;
      }
      if (command.type === "session.start") start("practice", "toggle");
      else if (command.type === "session.stop") requestStop();
      else cancelCurrent();
    },
    // Native shortcut transitions. Only a fresh press starts; held or repeated keys never restart.
    shortcut(action: ShortcutAction) {
      if (closed) return;
      const current = active;
      if (action === "hold.down") {
        // A repeated or stale press changes nothing while work is in progress.
        if (current || armed || stoppingCapture) return;
        start("dictation", "hold");
        held = active?.session;
        return;
      }
      if (action === "hold.up") {
        if (current && current.session === held && current.mode === "hold") requestStop();
        held = undefined;
        return;
      }
      if (action === "toggle") {
        if (armed) return;
        if (!current) {
          if (!stoppingCapture) start("dictation", "toggle");
          return;
        }
        if (current.origin !== "dictation" || current.stopRequested) return;
        if (current.mode === "hold") {
          current.mode = "toggle";
          if (state.phase === "recording") update({ message: recordingMessage(current) });
          return;
        }
        requestStop();
        return;
      }
      cancelCurrent();
    },
    targetSelected(input: unknown) {
      let event;
      try {
        event = decodeTargetSelected(input);
      } catch {
        return;
      }
      const current = armed;
      if (!current || current.id !== event.session || current.inserting) return;
      if (event.status !== "eligible") return;
      current.inserting = true;
      update({ recoveryMessage: "Inserting…" });
      options.target.insert(current.id, current.text).then(
        (outcome) => finishPaste(current, outcome),
        () => finishPaste(current, "uncertain"),
      );
    },
    captureEvent(input: unknown) {
      let event;
      try {
        event = decodeCaptureEvent(input);
      } catch {
        fail("Invalid microphone data. Available work remains in memory.");
        return;
      }
      if (stoppingCapture?.session === event.session && stoppingCapture.attempt === event.attempt) {
        if (event.type === "capture.stopped" || event.type === "capture.failed") {
          stoppingCapture = undefined;
          options.changed();
        }
        return;
      }
      const current = active;
      if (!current || event.session !== current.session || event.attempt !== current.attempt)
        return;
      if (event.type === "capture.failed") {
        current.stopped = true;
        fail(
          "Microphone capture stopped. Check your device and permissions. Available work remains in memory.",
        );
        return;
      }
      if (event.type === "capture.stopped") {
        if (!current.stopRequested) requestStop();
        current.stopped = true;
        // The final duration includes frames already captured when Stop was requested.
        // Reclassifying that duration never moves the original Stop time.
        if (current.stopTime !== undefined)
          current.deadline = current.stopTime + (current.samples <= 480_000 ? 10_000 : 30_000);
        if (event.frames !== current.audio.length || event.samples !== current.samples) {
          fail("Microphone audio was incomplete. Available work remains in memory.");
          return;
        }
        providerStop(current);
        return;
      }
      const pcm = Buffer.from(event.pcm, "base64");
      if (
        current.stopped ||
        event.sequence !== current.audio.length ||
        !pcm.length ||
        pcm.length % 2 ||
        pcm.length > 4096 ||
        current.samples + pcm.length / 2 > 4_800_000
      ) {
        fail("Microphone audio was incomplete. Available work remains in memory.");
        return;
      }
      if (state.phase === "starting") {
        update({ phase: "recording", message: recordingMessage(current) });
        later(() => {
          if (active === current && !current.stopRequested)
            update({
              warning: true,
              message: "30 seconds remaining. Recording stops at five minutes.",
            });
        }, 270_000);
        later(() => {
          if (active === current) requestStop();
        }, 300_000);
      }
      current.audio.push(pcm);
      current.samples += pcm.length / 2;
      if (current.providerStarted && !current.failure)
        options.provider({
          type: "audio",
          session: current.session,
          attempt: current.attempt,
          sequence: event.sequence,
          pcm,
        });
      if (current.samples === 4_800_000) requestStop();
    },
    providerEvent(input: unknown) {
      let event;
      try {
        event = decodeProviderEvent(input);
      } catch {
        fail("Invalid transcription response. Available work remains in memory.");
        return;
      }
      const current = active;
      if (
        !current ||
        event.session !== current.session ||
        event.attempt !== current.attempt ||
        current.failure ||
        current.inserting
      )
        return;
      if (current.deadline !== undefined && performance.now() >= current.deadline) {
        fail("Processing timed out. Audio and available text remain in memory.");
        return;
      }
      if (event.type === "stable" || event.type === "partial") {
        current.text = event.text;
        return;
      }
      if (event.type === "failed") {
        current.failure = failureMessages[event.reason];
        if (
          event.reason === "rejected" ||
          event.reason === "quota" ||
          event.reason === "rate-limit"
        )
          options.access(event.reason);
        if (event.reason === "connection" && !current.stopRequested) {
          update({ message: current.failure });
          return;
        }
        requestStop(current.failure);
        if (current.stopped) fail(current.failure);
        return;
      }
      if (!current.stopped || event.samples !== current.samples) {
        fail(
          "Transcription ended before complete microphone audio. Available work remains in memory.",
        );
        return;
      }
      current.text = event.text;
      options.access("authenticated");
      current.audio = [];
      if (!event.text) {
        end("complete", "No speech detected");
        return;
      }
      if (current.origin === "dictation") {
        deliver(current, event.text);
        return;
      }
      retain(
        current.session,
        event.text,
        "complete",
        [],
        "Waiting for the practice field to confirm delivery.",
        "undelivered",
      );
      update({ practiceText: event.text, pendingPractice: current.session });
      end("complete", "Delivering practice transcript…");
    },
    interrupted: interrupt,
    // Window lifecycle only affects practice work; shortcut dictation keeps its external target.
    practiceInterrupted(message: string) {
      interruptDelivery(message);
      if (active?.origin === "practice") interrupt(message);
    },
    helperFailed() {
      stoppingCapture = undefined;
      disarm("Native services stopped. The text remains in recovery.");
      if (active) active.stopped = true;
      if (active?.inserting) return;
      fail("Native services stopped. Available work remains in memory. Reopen Voice to repair.");
    },
    requestQuit() {
      if (!active && !armed && !retained.size) return false;
      disarm("Quitting cancelled the paste. The text remains in recovery.");
      interrupt("Quitting interrupted the session. Available work remains in memory.");
      update({ quitWarning: true });
      return true;
    },
    close() {
      disarm("Session ended.");
      if (active) end("cancelled", "Session ended.");
      clearTimers();
      closed = true;
      for (const recovery of retained.values()) recovery.audio = [];
      retained.clear();
      state = {
        ...state,
        recovery: [],
        practiceText: "",
        latestSuccessful: null,
        pendingPractice: null,
        recoveryMessage: "",
        message: "Session ended.",
        quitWarning: false,
        armedPaste: null,
      };
    },
  };
}
