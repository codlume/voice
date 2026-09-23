import { randomUUID } from "node:crypto";
import {
  decodeCaptureEvent,
  decodeProviderEvent,
  decodeTargetSelected,
  type Attempt,
  type CaptureCommand,
  type CaptureFailure,
  type InsertionOutcome,
  type Notice,
  type Origin,
  type ProviderRequest,
  type SessionCommand,
  type SessionSnapshot,
  type ProviderFailure,
  type RecoveryEntry,
  type ShortcutAction,
  type StartBlocker,
  type TargetStatus,
} from "@voice/contracts/session";

type Failure = { message: string; notice: Notice };
const providerFailures: Record<ProviderFailure, Failure> = {
  connection: {
    message: "Connection lost. Audio remains in memory; transcription needs internet.",
    notice: "connection",
  },
  rejected: { message: "Deepgram rejected the key. Replace it in Settings.", notice: "setup" },
  quota: { message: "Deepgram quota is exhausted. Check your account billing.", notice: "setup" },
  "rate-limit": {
    message: "Deepgram is rate limiting requests. The recording remains in recovery; Retry later.",
    notice: "rate-limit",
  },
  incomplete: {
    message: "Transcription was incomplete. Audio and available text remain in memory.",
    notice: "incomplete",
  },
  protocol: {
    message:
      "The provider response did not match the required model or stream. Available work remains in memory.",
    notice: "incomplete",
  },
  worker: {
    message: "The transcription worker stopped. Available work remains in memory.",
    notice: "incomplete",
  },
};
// Capture ends on these without the user's Stop. Collected audio and text go to recovery, and the
// repair is explicit: nothing restarts capture or resends once the device or access returns.
const captureFailures: Record<CaptureFailure | "unknown", Failure> = {
  device: {
    message:
      "The microphone disconnected or changed, so recording stopped. Available work remains in recovery. Reconnect it or choose another input in Settings, then start again.",
    notice: "setup",
  },
  permission: {
    message:
      "Microphone access was revoked, so recording stopped. Available work remains in recovery. Allow access in System Settings, then start again.",
    notice: "setup",
  },
  unknown: {
    message:
      "Microphone capture stopped. Check your device and permissions. Available work remains in memory.",
    notice: "incomplete",
  },
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
// Why the provider stream is down while an explicitly started capture continues. After Stop the
// session replays the whole recording once, if connectivity returns and time remains. A crashed
// provider worker is replaced only for that same replay, so it never adds an attempt or time.
type Outage = "offline" | "connection" | "rate-limit" | "worker";
const outageWarnings: Record<Outage, Failure> = {
  offline: {
    message:
      "Offline. Recording continues and audio stays in memory; Voice transcribes after you stop if the connection returns.",
    notice: "connection",
  },
  connection: {
    message:
      "Connection lost. Recording continues and audio stays in memory; Voice replays the full recording once after you stop.",
    notice: "connection",
  },
  "rate-limit": {
    message:
      "Deepgram is rate limiting requests. Recording continues; Voice retries once after you stop.",
    notice: "rate-limit",
  },
  worker: {
    message:
      "The transcription worker stopped. Recording continues and audio stays in memory; Voice replays the full recording once after you stop.",
    notice: "worker",
  },
};
const outageFailures: Record<Outage, Failure> = {
  offline: {
    message:
      "No connection was available. Audio remains in memory; Retry from recovery when you are online.",
    notice: "connection",
  },
  connection: providerFailures.connection,
  "rate-limit": providerFailures["rate-limit"],
  worker: providerFailures.worker,
};
const waitingForConnection: Failure = {
  message: "Waiting for a connection to transcribe. Audio remains in memory.",
  notice: "connection",
};
const waitingForBackoff: Failure = {
  message: "Deepgram asked Voice to wait. Retrying once before the deadline…",
  notice: "rate-limit",
};
const backoffTooLong: Failure = {
  message:
    "Deepgram asked Voice to wait past the processing deadline. The recording remains in recovery; Retry later.",
  notice: "rate-limit",
};
const keyUnreadable: Failure = {
  message:
    "The saved key could not be read. Check Keychain access and native services in Settings.",
  notice: "setup",
};
// The original 10/30-second processing deadline by capture duration; 30 seconds is 480,000 samples.
const deadlineFor = (samples: number) => (samples <= 480_000 ? 10_000 : 30_000);
const limitReached: Failure = {
  message: "Recording reached the five-minute limit. Finishing transcription…",
  notice: "limit",
};
const uncertainCause =
  "Check your target. Voice could not confirm the insertion and will not retry automatically.";
// The provider attempt of the current logical ASR operation. The live attempt shares the capture's
// identity; each replay gets a fresh one, so late events from a superseded attempt never match.
type Link =
  | { state: "open"; attempt: string; replay: boolean; started: boolean; text: string }
  | { state: "down"; outage: Outage | null; retryAt: number };
type Active = Attempt & {
  origin: Origin;
  mode: "hold" | "toggle";
  audio: Uint8Array[];
  samples: number;
  // The best text so far. A replay supersedes it only with complete output.
  text: string;
  // An explicit Retry of a retained recording: no capture, and failure or cancel keeps the source.
  retry: boolean;
  link: Link;
  // Provider attempts spent: the original plus at most one automatic retry. Never reset.
  attempts: number;
  stopped: boolean;
  // A terminal failure that ends the session once capture stops.
  failure?: Failure;
  stopRequested: boolean;
  deadline?: number;
  stopTime?: number;
  target?: TargetStatus;
  inserting: boolean;
  // Capture stopped at the five-minute limit; the outcome says so.
  limited?: boolean;
};
// A replay that never completed leaves the old best text; only when there was none does its
// available text become the (incomplete) recovery text. Old and new text are never joined.
const bestText = (current: Active) =>
  current.text || (current.link.state === "open" ? current.link.text : "");
type Armed = { id: string; text: string; inserting: boolean };
type Retained = { audio: Uint8Array[]; origin: Origin; entry: RecoveryEntry };
export function createSession(options: {
  // Local capture, setup, and storage allow a new capture.
  available: () => boolean;
  // A retained recording can be sent now: native services can read a saved key.
  transcribable: () => boolean;
  // False only when the device is known to be offline. Offline never blocks an explicit Start.
  online: () => boolean;
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
    blocker: null,
    notice: null,
    message: "Ready.",
    practiceText: "",
    recovery: [],
    recoveryMessage: "",
    quitWarning: false,
    pendingPractice: null,
    retrying: null,
    retryBlocker: null,
    latestSuccessful: null,
    lastTranscript: null,
    lastUpdate: "session",
  };
  let active: Active | undefined;
  let armed: Armed | undefined;
  let held: string | undefined;
  let closed = false;
  let stoppingCapture: Attempt | undefined;
  const retained = new Map<string, Retained>();
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
    const lastUpdate =
      "message" in change ? "session" : "recoveryMessage" in change ? "recovery" : state.lastUpdate;
    state = { ...state, ...change, lastUpdate };
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
    { session: id, origin }: Active,
    text: string,
    transcription: RecoveryEntry["transcription"],
    audio: Uint8Array[],
    cause: string,
    delivery: RecoveryEntry["delivery"],
  ) {
    retained.set(id, {
      audio,
      origin,
      entry: { id, text, transcription, hasAudio: audio.length > 0, cause, delivery },
    });
    if (text) state = { ...state, lastTranscript: id };
  }
  // The newest transcript that still has text: the recorded last one, else any remaining.
  function lastTranscript() {
    const kept = (id: string | null) =>
      !!id && (state.latestSuccessful?.id === id || !!retained.get(id)?.entry.text);
    if (kept(state.lastTranscript)) return state.lastTranscript;
    const remaining = [...retained.values()].findLast(({ entry }) => entry.text)?.entry.id;
    return remaining ?? state.latestSuccessful?.id ?? null;
  }
  function blocker(): StartBlocker | null {
    if (closed || state.quitWarning) return "quitting";
    if (active || stoppingCapture) return "busy";
    if (armed) return "paste";
    if (retained.size >= 5) return "recovery-full";
    if (!options.available()) return "setup";
    return null;
  }
  // Retry needs no microphone or free slot; it waits for the current work and a readable key.
  function retryBlocker(): StartBlocker | null {
    if (closed || state.quitWarning) return "quitting";
    if (active || stoppingCapture) return "busy";
    if (armed) return "paste";
    if (!options.transcribable()) return "setup";
    return null;
  }
  function sendCapture(type: "capture.stop" | "capture.cancel", current: Active) {
    try {
      options.capture({ type, session: current.session, attempt: current.attempt });
    } catch {
      /* The failed helper cannot continue capture. */
    }
  }
  function end(
    phase: "failed" | "cancelled" | "complete",
    message: string,
    notice: Notice | null = null,
  ) {
    const current = active;
    if (!current) return;
    active = undefined;
    clearTimers();
    if (!current.stopped) {
      stoppingCapture = { session: current.session, attempt: current.attempt };
      sendCapture("capture.cancel", current);
    }
    cancelStream(current);
    if (current.origin === "dictation" && !current.retry) releaseTarget(current.session);
    const text = bestText(current);
    const kept = retained.get(current.session);
    if (current.retry) {
      // A failed or cancelled Retry keeps its whole source; only its explanation changes.
      if (kept && phase !== "complete") {
        kept.entry = { ...kept.entry, text, cause: message };
        if (text) state = { ...state, lastTranscript: current.session };
      }
    } else if (phase !== "complete" && !kept && (current.audio.length || text))
      // Delivery paths retain their own complete entry before ending; keep it intact.
      retain(current, text, "incomplete", current.audio, message, "undelivered");
    engage();
    update({ phase, message, notice });
  }
  function fail(message: string, notice: Notice = "incomplete") {
    end("failed", message, notice);
  }
  // Cancelling also retires the provider worker, so nothing stays connected once an attempt ends.
  function cancelStream(current: Active) {
    const { link } = current;
    options.provider({
      type: "cancel",
      session: current.session,
      attempt: link.state === "open" ? link.attempt : current.attempt,
    });
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
  // A connection warning stays visible for the rest of the capture.
  function recordingStatus(current: Active): Failure | { message: string; notice: null } {
    const { link } = current;
    return (
      current.failure ??
      (link.state === "down" && link.outage ? outageWarnings[link.outage] : undefined) ?? {
        message: recordingMessage(current),
        notice: null,
      }
    );
  }
  // Every wait, connection, replay, backoff and finalization shares one deadline. Nothing extends it.
  function expireAt(current: Active) {
    const expire = () => {
      if (active !== current || current.deadline === undefined || current.inserting) return;
      const remaining = current.deadline - performance.now();
      if (remaining > 0) later(expire, remaining);
      else timedOut(current);
    };
    later(expire, (current.deadline ?? 0) - performance.now());
  }
  function timedOut(current: Active) {
    const { link } = current;
    if (link.state === "open" && link.replay) {
      const seconds = current.samples / 16_000;
      fail(
        `Processing timed out before the full replay finished. Replay runs at no more than 1.25× real time, so this ${Math.round(seconds)}-second recording needs at least ${Math.ceil(seconds / 1.25)} seconds before finalization. The recording and available text remain in recovery.`,
      );
      return;
    }
    if (link.state === "down" && !options.online()) {
      fail(
        "No connection before the processing deadline. Audio remains in memory; Retry from recovery when you are online.",
        "connection",
      );
      return;
    }
    fail("Processing timed out. Audio and available text remain in memory.");
  }
  function requestStop(failure?: Failure) {
    const current = active;
    if (!current || current.stopRequested) return;
    current.stopRequested = true;
    current.stopTime = performance.now();
    current.deadline = current.stopTime + deadlineFor(current.samples);
    update({
      phase: "processing",
      notice: failure?.notice ?? null,
      message: failure?.message ?? "Finishing transcription…",
    });
    sendCapture("capture.stop", current);
    expireAt(current);
  }
  // Capture has stopped, or a Retry has begun: finish the open stream, or replay the whole source.
  function providerStop(current: Active) {
    if (current.failure) {
      fail(current.failure.message, current.failure.notice);
      return;
    }
    const { link } = current;
    if (link.state === "down") replay(current);
    else if (link.started)
      options.provider({
        type: "stop",
        session: current.session,
        attempt: link.attempt,
        frames: current.audio.length,
        samples: current.samples,
      });
  }
  // Opens a provider attempt and sends every retained frame in order. A replay is always the
  // whole source on a fresh stream with fresh assembly; the adapter paces it at no more than 1.25x.
  function connect(current: Active, full: boolean) {
    const link: Link = {
      state: "open",
      attempt: full ? randomUUID() : current.attempt,
      replay: full,
      started: false,
      text: "",
    };
    current.link = link;
    current.attempts++;
    void options.credential().then(
      (key) => {
        if (active !== current || current.link !== link) return;
        link.started = true;
        options.provider({ type: "start", session: current.session, attempt: link.attempt, key });
        for (const [sequence, pcm] of current.audio.entries())
          options.provider({
            type: "audio",
            session: current.session,
            attempt: link.attempt,
            sequence,
            pcm,
          });
        if (current.stopped) providerStop(current);
      },
      () => {
        if (active !== current || current.link !== link) return;
        current.failure = keyUnreadable;
        if (current.retry) {
          fail(keyUnreadable.message, keyUnreadable.notice);
          return;
        }
        requestStop(current.failure);
        if (current.stopped) fail(keyUnreadable.message, keyUnreadable.notice);
      },
    );
  }
  // The one automatic retry, or an explicit Retry's first attempt. It waits for connectivity and
  // for provider backoff that fits the deadline; a failed connection attempt still counts.
  function replay(current: Active) {
    const { link } = current;
    if (active !== current || link.state !== "down" || current.deadline === undefined) return;
    if (current.attempts >= 2) {
      const failure = outageFailures[link.outage ?? "connection"];
      fail(failure.message, failure.notice);
      return;
    }
    const now = performance.now();
    if (link.retryAt >= current.deadline) {
      fail(backoffTooLong.message, backoffTooLong.notice);
      return;
    }
    const wait =
      link.retryAt > now ? waitingForBackoff : options.online() ? undefined : waitingForConnection;
    if (wait) {
      if (state.message !== wait.message) update({ phase: "processing", ...wait });
      later(() => replay(current), link.retryAt > now ? link.retryAt - now : 500);
      return;
    }
    update({
      phase: "processing",
      notice: null,
      message: current.retry
        ? "Retrying transcription from the retained recording. The microphone stays off."
        : "Transcribing the full recording again…",
    });
    connect(current, true);
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
    // Busy input shows the current status and is never queued.
    const blocked = blocker();
    if (blocked === "recovery-full" || blocked === "setup") {
      update({
        phase: "failed",
        origin,
        notice: blocked,
        message:
          blocked === "recovery-full"
            ? "Recovery is full. Resolve or discard a session before starting another."
            : "Complete or repair dictation setup before starting.",
      });
      return;
    }
    if (blocked) return;
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
      retry: false,
      link: { state: "down", outage: null, retryAt: 0 },
      attempts: 0,
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
      fail("Microphone capture could not start. Check your device and permissions.", "setup");
      return;
    }
    update({ phase: "starting", origin, notice: null, message: "Starting microphone…" });
    if (origin === "dictation") {
      // Remember the target focused at the shortcut. Capture startup never waits for this.
      const remember = (target: TargetStatus) => {
        if (active !== current) return;
        current.target = target;
        if (state.phase === "recording") update(recordingStatus(current));
      };
      options.target.capture(current.session).then(remember, () => remember("unavailable"));
    }
    later(() => {
      if (active === current && state.phase === "starting")
        fail("The microphone did not provide audio. Check your device and permissions.", "setup");
    }, 3_000);
    // Offline counts as the original attempt; the one full replay follows Stop.
    if (options.online()) connect(current, false);
    else {
      current.attempts = 1;
      current.link = { state: "down", outage: "offline", retryAt: 0 };
    }
  }
  // Explicit Retry transcribes the complete retained recording on a fresh stream. The microphone
  // stays off, the 10/30-second deadline starts now, and any result stays in recovery for an
  // explicit Copy or Paste, so already delivered text is never replaced or duplicated.
  function retry(id: string) {
    const source = retained.get(id);
    if (!source?.audio.length) return;
    const blocked = retryBlocker();
    if (blocked === "setup")
      update({
        recoveryMessage:
          "Retry needs a saved Deepgram key and running native services. Repair setup, then Retry.",
      });
    if (blocked) return;
    const samples = source.audio.reduce((total, pcm) => total + pcm.byteLength / 2, 0);
    const now = performance.now();
    const current: Active = {
      session: id,
      attempt: randomUUID(),
      origin: source.origin,
      mode: "toggle",
      audio: source.audio,
      samples,
      text: source.entry.text,
      retry: true,
      link: { state: "down", outage: null, retryAt: 0 },
      attempts: 0,
      stopped: true,
      stopRequested: true,
      stopTime: now,
      deadline: now + deadlineFor(samples),
      inserting: false,
    };
    active = current;
    engage();
    update({
      phase: "processing",
      origin: source.origin,
      notice: null,
      recoveryMessage: "",
      message: "Retrying transcription from the retained recording. The microphone stays off.",
    });
    expireAt(current);
    replay(current);
  }
  function finishRetry(current: Active, text: string) {
    const kept = retained.get(current.session);
    if (!kept) return;
    kept.audio = [];
    current.audio = [];
    if (!text) {
      retained.delete(current.session);
      end(
        "complete",
        "Retry complete. No speech was detected, so the recording was released.",
        "no-speech",
      );
      return;
    }
    const delivered = ["copied", "inserted", "uncertain"].includes(kept.entry.delivery);
    kept.entry = {
      ...kept.entry,
      text,
      transcription: "complete",
      hasAudio: false,
      delivery: "undelivered",
      cause: delivered
        ? "Retry produced the complete transcript. Earlier available text was already delivered; check the destination before pasting so nothing is duplicated."
        : "Retry produced the complete transcript. Copy or Paste it.",
    };
    state = { ...state, lastTranscript: current.session };
    end("complete", "Retry complete. The transcript is in recovery; Copy or Paste it.");
  }
  function cancel() {
    const current = active;
    if (!current || current.inserting) return;
    if (current.retry) {
      end("cancelled", "Retry cancelled. The recording and its text remain in recovery.");
      return;
    }
    // A key change or access failure is already stopping this capture to keep its recording for
    // recovery. That stop finishes the session once the final frames drain; a Cancel racing it
    // must not release or truncate what the stop preserves.
    if (current.failure) return;
    current.audio = [];
    end("cancelled", "Cancelled. Any produced text remains in memory.");
  }
  function interrupt(message: string) {
    interruptDelivery(message);
    const current = active;
    // A transcript already being inserted needs no provider or microphone; its outcome stands.
    if (!current || current.inserting) return;
    current.failure = { message, notice: "incomplete" };
    if (!current.stopRequested) requestStop(current.failure);
    else if (!current.stopped) update({ phase: "processing", ...current.failure });
    cancelStream(current);
    current.text = bestText(current);
    current.link = { state: "down", outage: null, retryAt: 0 };
    if (current.stopped) fail(message);
  }
  function finishInsertion(current: Active, text: string, outcome: InsertionOutcome) {
    if (active !== current) return;
    if (outcome === "inserted") {
      state = {
        ...state,
        latestSuccessful: { id: current.session, text },
        lastTranscript: current.session,
      };
      if (current.limited)
        end("complete", "Inserted. Recording stopped at the five-minute limit.", "limit");
      else end("complete", "Inserted.");
      return;
    }
    if (outcome === "uncertain") {
      retain(current, text, "complete", [], uncertainCause, "uncertain");
      end("failed", "Check your target. The transcript is in recovery.", "uncertain");
      return;
    }
    retain(
      current,
      text,
      "complete",
      [],
      `${insertionMessages[outcome]} Text kept for recovery.`,
      "failed",
    );
    end(
      "failed",
      `Not inserted. ${insertionMessages[outcome]} The transcript is in recovery.`,
      "not-inserted",
    );
  }
  function deliver(current: Active, text: string) {
    const target = current.target ?? "unavailable";
    if (target !== "eligible") {
      retain(
        current,
        text,
        "complete",
        [],
        `${targetMessages[target]} Text kept for recovery.`,
        "failed",
      );
      end(
        "failed",
        `Not inserted. ${targetMessages[target]} The transcript is in recovery.`,
        "not-inserted",
      );
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
    // Like a session insertion, a paste already dispatched cannot be taken back; its outcome stands.
    if (armed) {
      if (!armed.inserting) disarm("Paste cancelled. The text remains in recovery.");
    } else cancel();
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
      retrying: active?.retry ? active.session : null,
      blocker: blocker(),
      retryBlocker: retryBlocker(),
      lastTranscript: lastTranscript(),
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
      if (command.type === "recovery.retry") {
        retry(command.id);
        return;
      }
      if (command.type === "recovery.discard") {
        if (armed?.id === command.id) disarm("Paste cancelled.");
        if (active?.retry && active.session === command.id)
          end("cancelled", "Retry cancelled because its recording was discarded.");
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
      if (command.type === "session.start") start(command.origin, "toggle");
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
          if (state.phase === "recording") update(recordingStatus(current));
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
        // A safety stop already in progress keeps its own explanation and repair.
        const failure = current.failure ?? captureFailures[event.reason ?? "unknown"];
        fail(failure.message, failure.notice);
        return;
      }
      if (event.type === "capture.stopped") {
        if (!current.stopRequested) requestStop();
        current.stopped = true;
        // The final duration includes frames already captured when Stop was requested.
        // Reclassifying that duration never moves the original Stop time.
        if (current.stopTime !== undefined)
          current.deadline = current.stopTime + deadlineFor(current.samples);
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
        update({ phase: "recording", ...recordingStatus(current) });
        later(() => {
          if (active === current && !current.stopRequested)
            update({
              notice: "limit",
              message: "30 seconds remaining. Recording stops at five minutes.",
            });
        }, 270_000);
        later(() => {
          if (active === current) {
            current.limited = true;
            requestStop(limitReached);
          }
        }, 300_000);
      }
      current.audio.push(pcm);
      current.samples += pcm.length / 2;
      const { link } = current;
      if (link.state === "open" && link.started && !current.failure)
        options.provider({
          type: "audio",
          session: current.session,
          attempt: link.attempt,
          sequence: event.sequence,
          pcm,
        });
      if (current.samples === 4_800_000) {
        current.limited = true;
        requestStop(limitReached);
      }
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
      const link = current?.link;
      if (
        !current ||
        link?.state !== "open" ||
        event.session !== current.session ||
        event.attempt !== link.attempt ||
        current.failure ||
        current.inserting
      )
        return;
      if (current.deadline !== undefined && performance.now() >= current.deadline) {
        timedOut(current);
        return;
      }
      if (event.type === "stable" || event.type === "partial") {
        link.text = event.text;
        if (!link.replay) current.text = event.text;
        return;
      }
      if (event.type === "failed") {
        if (
          event.reason === "rejected" ||
          event.reason === "quota" ||
          event.reason === "rate-limit"
        )
          options.access(event.reason);
        if (
          event.reason === "connection" ||
          event.reason === "rate-limit" ||
          event.reason === "worker"
        ) {
          // Transient: an explicitly started capture continues with a visible warning, and the
          // whole source is replayed once after Stop within the original deadline. A crashed
          // worker is replaced for that replay only; it shares the same allowance and deadline.
          current.text = bestText(current);
          current.link = {
            state: "down",
            outage: event.reason,
            retryAt: event.retryAfter === undefined ? 0 : performance.now() + event.retryAfter,
          };
          if (!current.stopRequested) update(recordingStatus(current));
          else if (current.stopped) replay(current);
          return;
        }
        current.failure = providerFailures[event.reason];
        requestStop(current.failure);
        if (current.stopped) fail(current.failure.message, current.failure.notice);
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
      if (current.retry) {
        finishRetry(current, event.text);
        return;
      }
      current.audio = [];
      if (!event.text) {
        end("complete", "No speech detected", "no-speech");
        return;
      }
      if (current.origin === "dictation") {
        deliver(current, event.text);
        return;
      }
      retain(
        current,
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
      if (active?.origin === "practice" && !active.retry) interrupt(message);
    },
    // The helper process died, and any capture died with it. Main keeps every recovery source;
    // a replacement helper only restores availability and never resumes this session.
    helperFailed() {
      stoppingCapture = undefined;
      held = undefined;
      // A paste already dispatched may have landed; it is uncertain, never retried.
      if (armed?.inserting) finishPaste(armed, "uncertain");
      else disarm("Native services stopped. The text remains in recovery.");
      const current = active;
      if (!current || current.inserting) return;
      // Work that no longer needs the helper finishes: a Retry, or practice whose capture stopped.
      if (current.stopped && (current.retry || current.origin === "practice")) return;
      current.stopped = true;
      fail(
        "Native services stopped, so recording ended. Available work remains in recovery. Voice restarts native services; start again when setup is ready.",
      );
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
        lastTranscript: null,
        notice: null,
      };
    },
  };
}
