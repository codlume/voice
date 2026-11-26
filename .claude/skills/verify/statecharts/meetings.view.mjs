// View for meetings.tla: the meeting recording flow in the words of the user and maintainer.
const ready = (v) => {
  if (v.failed) {
    return v.partial
      ? "Ready, final pass failed, part of the audio deleted"
      : "Ready, final pass failed, audio kept";
  }
  if (!v.final) {
    if (v.audio === "kept") return "Ready, audio without a final transcript left on disk";
    return v.audio === "empty"
      ? "Ready, live transcript only, empty audio files left on disk"
      : "Ready, live transcript only, audio deleted";
  }
  if (v.audio === "kept") return "Ready, audio left on disk";
  return v.audio === "empty" ? "Ready, empty audio files left on disk" : "Ready, audio deleted";
};

const deleting = (v) =>
  v.final ? "Final transcript saved, deleting audio" : "Live transcript only, deleting audio";

const labels = {
  none: "No meeting",
  starting: "Starting",
  resuming: "Resuming",
  reopening: "Resuming a finished meeting",
  recording: "Recording",
  paused: "Paused",
  finishing: "Catching up the live transcript",
  draining: "Catching up the live transcript",
  confirming: "Started by mistake?",
  finalizing: "Final pass",
  deletingKeptAudio: "Deleting the kept audio",
  clearingLeftover: "Ready, Resume deleting the audio left on disk",
  gone: "Removed",
};

export const state = (v) => {
  if (v.status === "ready") return ready(v);
  return v.status === "deletingAudio" ? deleting(v) : labels[v.status];
};

export const group = (v) => {
  if (["starting", "resuming", "reopening", "recording", "paused"].includes(v.status)) {
    return "Capture";
  }
  const finishing = ["finishing", "draining", "confirming", "finalizing"];
  if ([...finishing, "deletingAudio", "deletingKeptAudio"].includes(v.status)) {
    return "Finishing";
  }
  return ["ready", "clearingLeftover"].includes(v.status) ? "Done" : "No meeting";
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
    case "YouResumeLeftover":
      return "you press Resume";
    case "LeftoverDeleted":
      return "the audio left on disk is deleted, so the resume begins";
    case "LeftoverStays":
      return "the audio left on disk cannot be deleted, so Voice refuses the resume";
    case "ResumeFails":
    case "YouPauseWhileResuming":
      return from.status === "reopening"
        ? "the resume fails, or you press Pause or Stop"
        : "the resume fails, or you press Pause";
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
      return "deleting fails";
    case "YouTryAgain":
      return "you press Try again";
    case "YouDeleteAudio":
      return "you press Delete audio";
    case "KeptAudioDeleted":
      return "the audio files are deleted";
    case "KeptAudioDeleteFails":
      return "deleting fails, so Voice says it could not delete the audio";
    case "VoiceRestarts":
      if (to.status === "gone")
        return "the start fails, you press Stop, or Voice closes before any audio";
      if (
        ["ready", "deletingAudio", "deletingKeptAudio", "clearingLeftover", "reopening"].includes(
          from.status,
        )
      )
        return restart;
      if (["paused", "resuming"].includes(from.status)) return `you press Stop, or ${restart}`;
      if (from.status === "recording") return stopOrLimit;
      if (from.status === "starting")
        return "Voice quits or crashes after the audio began, then opens again";
      return null;
    default:
      return null;
  }
}
