// View for meetings.tla: the meeting recording flow in the words of the user and maintainer.
const transcript = (v, text) => (v.final ? text : `${text}, live transcript only`);

const ready = (v) => {
  if (v.audio === "present") return "Ready, final pass failed, audio kept";
  if (v.audio === "gone") return transcript(v, "Ready, audio deleted");
  // A delete that runs, and one whose files are gone but waits for a cancelled start to answer,
  // both end with the audio gone without you pressing anything.
  if (v.removing === "running" || (v.late && v.files === "none")) {
    return transcript(v, "Ready, deleting audio");
  }
  return transcript(v, "Ready, could not delete the audio");
};

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
  gone: "Removed",
};

export const state = (v) => (v.status === "ready" ? ready(v) : labels[v.status]);

export const group = (v) => {
  if (["starting", "resuming", "reopening", "recording", "paused"].includes(v.status)) {
    return "Capture";
  }
  if (["finishing", "draining", "confirming", "finalizing"].includes(v.status)) return "Finishing";
  return v.status === "ready" ? "Done" : "No meeting";
};

export const colors = { Capture: "orange", Finishing: "blue", Done: "teal", "No meeting": "tan" };

export const title = "Meeting recording";

const restart = "Voice quits or crashes, then opens again";
const startEnds = "the start fails, you press Stop, or Voice closes before any audio";
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
      return startEnds;
    case "PauseOrLoss":
      return "you press Pause, or the audio stops";
    case "YouResumeAppend":
    case "YouResumeFresh":
    case "YouResumeAfterDelete":
      return "you press Resume";
    case "AudioDeleted":
      if (from.after === "resume") {
        return to.status === "reopening"
          ? "the old audio is deleted, so the resume begins"
          : "the old audio is deleted, but a cancelled start is unanswered, so Voice refuses the resume";
      }
      return to.audio === "gone"
        ? "the audio files are deleted"
        : "the audio files are deleted [while a cancelled start is unanswered]";
    case "DeleteFails":
      return from.after === "resume"
        ? "the old audio cannot be deleted, so Voice refuses the resume"
        : "deleting fails";
    case "ResumeFails":
    case "YouPauseWhileResuming":
      return from.status === "reopening"
        ? "the resume fails, or you press Pause or Stop"
        : "the resume fails, or you press Pause";
    case "LateFile":
    case "LateAnswer":
      return "the helper answers the cancelled start, so Voice deletes again";
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
    case "YouTryAgain":
      return "you press Try again";
    case "YouDeleteAudio":
      return "you press Delete audio";
    case "VoiceRestarts":
      if (to.status === "gone") return startEnds;
      if (["confirming", "finalizing"].includes(from.status)) return null;
      if (from.status === "recording") return stopOrLimit;
      if (["paused", "resuming"].includes(from.status)) return `you press Stop, or ${restart}`;
      if (from.status === "starting") {
        return "Voice quits or crashes after the audio began, then opens again";
      }
      return restart;
    default:
      return null;
  }
}
