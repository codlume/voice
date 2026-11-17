// View for meetings.tla: the meeting recording flow in the words of the user and maintainer.
const ready = (v) => {
  if (v.failed) return "Ready, final pass failed, audio kept";
  if (!v.final) return "Ready, live transcript only, audio deleted";
  return v.audio === "kept" ? "Ready, audio left on disk" : "Ready, audio deleted";
};

const labels = {
  none: "No meeting",
  starting: "Starting",
  resuming: "Resuming",
  recording: "Recording",
  paused: "Paused",
  finishing: "Catching up the live transcript",
  draining: "Catching up the live transcript",
  confirming: "Started by mistake?",
  finalizing: "Final pass",
  deletingAudio: "Final transcript saved, deleting audio",
  gone: "Removed",
};

export const state = (v) => (v.status === "ready" ? ready(v) : labels[v.status]);

export const group = (v) => {
  if (["starting", "resuming", "recording", "paused"].includes(v.status)) return "Capture";
  if (["finishing", "draining", "confirming", "finalizing", "deletingAudio"].includes(v.status)) {
    return "Finishing";
  }
  return v.status === "ready" ? "Done" : "No meeting";
};

export const colors = { Capture: "orange", Finishing: "blue", Done: "teal", "No meeting": "tan" };

export const title = "Meeting recording";

const restart = "Voice quits or crashes, then opens again";
const stopOrLimit = `you press Stop, the time limit ends it, or ${restart}`;

export function step(action, from, to) {
  switch (action) {
    case "YouStart":
      return "you press Start meeting (tray, shortcut or hub)";
    case "HelperStarts":
      return "the helper opens the microphone and system audio";
    case "RecordingBegins":
      return "recording begins";
    case "StartFails":
    case "YouStopWhileStarting":
      return "the start fails, you press Stop, or Voice closes before any audio";
    case "YouPause":
    case "AudioStops":
      return "you press Pause, or the audio stops";
    case "YouResume":
      return "you press Resume";
    case "ResumeFails":
    case "YouPauseWhileResuming":
      return "the resume fails, or you press Pause";
    case "YouStop":
      return from.status === "recording" ? stopOrLimit : `you press Stop, or ${restart}`;
    case "TimeLimit":
      return stopOrLimit;
    case "CaughtUpShort":
      return "the transcript catches up with under ten words";
    case "CaughtUp":
      return "the transcript catches up";
    case "YouKeep":
      return "you press Keep";
    case "YouDiscard":
      return "you press Discard";
    case "FinalSaved":
      return "the final transcript is saved";
    case "FinalFails":
      return "the final pass fails";
    case "AudioDeleted":
      return "the audio files are deleted";
    case "DeleteFails":
      return "deleting fails, or Voice quits or crashes first";
    case "YouTryAgain":
      return "you press Try again";
    case "YouDeleteAudio":
      return "you press Delete audio";
    case "VoiceRestarts":
      if (to.status === "gone")
        return "the start fails, you press Stop, or Voice closes before any audio";
      if (from.status === "deletingAudio") return "deleting fails, or Voice quits or crashes first";
      if (["paused", "resuming"].includes(from.status)) return `you press Stop, or ${restart}`;
      if (from.status === "recording") return stopOrLimit;
      if (from.status === "starting")
        return "Voice quits or crashes after the audio began, then opens again";
      return null;
    default:
      return null;
  }
}
