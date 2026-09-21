import { randomUUID } from "node:crypto";
import {
  decodeCaptureEvent,
  decodeProviderEvent,
  type Attempt,
  type CaptureCommand,
  type ProviderRequest,
  type SessionCommand,
  type SessionSnapshot,
  type ProviderFailure,
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
type Active = Attempt & {
  audio: Uint8Array[];
  samples: number;
  text: string;
  providerStarted: boolean;
  stopped: boolean;
  failure?: string;
  stopRequested: boolean;
  deadline?: number;
  stopTime?: number;
};
export function createSession(options: {
  available: () => boolean;
  device: () => string | null;
  credential: () => Promise<string>;
  capture: (command: CaptureCommand) => void;
  provider: (command: ProviderRequest) => void;
  changed: () => void;
  access: (reason: "authenticated" | "rejected" | "quota" | "rate-limit") => void;
}) {
  let state: SessionSnapshot = {
    phase: "idle",
    canStart: false,
    warning: false,
    message: "Ready for practice.",
    practiceText: "",
    retainedText: "",
    retainedCount: 0,
  };
  let active: Active | undefined;
  let stoppingCapture: Attempt | undefined;
  // Recovery actions belong to #31. Until then, retain sources without offering a nonfunctional Retry.
  const retained: { audio: Uint8Array[]; text: string }[] = [];
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
    if (phase !== "complete" && (current.audio.length || current.text))
      retained.push({ audio: current.audio, text: current.text });
    update({
      phase,
      message,
      warning: false,
      retainedCount: retained.length,
      retainedText: retained
        .map((entry) => entry.text)
        .filter(Boolean)
        .join("\n\n"),
    });
  }
  function fail(message: string) {
    end("failed", message);
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
      if (active !== current || current.deadline === undefined) return;
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
  function start() {
    if (active || stoppingCapture) return;
    if (!options.available() || retained.length >= 5) {
      update({
        phase: "failed",
        message:
          retained.length >= 5
            ? "Recovery memory is full. Keep your retained text before quitting; recovery controls are not available yet."
            : "Complete or repair dictation setup before starting practice.",
      });
      return;
    }
    const id = randomUUID();
    const current: Active = {
      session: id,
      attempt: randomUUID(),
      audio: [],
      samples: 0,
      text: "",
      providerStarted: false,
      stopped: false,
      stopRequested: false,
    };
    active = current;
    update({
      phase: "starting",
      warning: false,
      message: "Starting microphone…",
      retainedText: "",
    });
    try {
      options.capture({
        type: "capture.start",
        session: current.session,
        attempt: current.attempt,
        device: options.device(),
      });
    } catch {
      fail("Microphone capture could not start. Check your device and permissions.");
      return;
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
  return {
    snapshot: () => ({
      ...state,
      canStart: !active && !stoppingCapture && options.available() && retained.length < 5,
    }),
    execute(command: SessionCommand) {
      if (command.type === "session.start") start();
      else if (command.type === "session.stop") requestStop();
      else if (active) {
        active.audio = [];
        end("cancelled", "Cancelled. Any produced text remains in memory.");
      }
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
        update({ phase: "recording", message: "Recording. Speak, then press Stop." });
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
        current.failure
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
      if (event.text) update({ practiceText: event.text });
      end("complete", event.text ? "Practice transcript ready." : "No speech detected");
    },
    interrupted(message: string) {
      const current = active;
      if (!current) return;
      current.failure = message;
      requestStop(message);
      options.provider({ type: "cancel", session: current.session, attempt: current.attempt });
      if (current.stopped) fail(message);
    },
    helperFailed() {
      stoppingCapture = undefined;
      if (active) active.stopped = true;
      fail("Native services stopped. Available work remains in memory. Reopen Voice to repair.");
    },
    hasRetained: () => retained.length > 0,
    close() {
      if (active) end("cancelled", "Session ended.");
      clearTimers();
    },
  };
}
