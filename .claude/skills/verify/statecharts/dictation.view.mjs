export const title = "A dictation session";

const MIC_OPEN = "Mic open, Flow Bar idle until Listening";
const PROCESSING = "Flow Bar shows processing";
const RESULT = "Flow Bar shows the result";

export function state(v) {
  switch (v.phase) {
    case "idle":
      return ["Idle"];
    case "starting":
      return [MIC_OPEN, v.released ? "Mic starting, you already let go" : "Mic starting"];
    case "recording":
      return [MIC_OPEN, "Listening"];
    case "transcribing":
      return [PROCESSING, "Transcribing"];
    case "cleaning":
      return [PROCESSING, "Cleaning up"];
    case "inserting":
      return [PROCESSING, "Inserting"];
  }
  if (v.outcome === "inserted") return [RESULT, "Inserted or Pasted"];
  if (v.outcome === "notInserted") return [RESULT, "Not inserted"];
  if (v.outcome === "unconfirmed") return [RESULT, "Not confirmed"];
  return [RESULT, "Too short, Nothing heard, or an error"];
}

export function group(v) {
  if (v.phase === "starting" || v.phase === "recording") return "mic open";
  if (v.phase === "transcribing" || v.phase === "cleaning" || v.phase === "inserting") {
    return "processing";
  }
  if (v.phase === "done") {
    if (v.outcome === "inserted") return "says inserted";
    if (v.outcome === "unconfirmed") return "says not confirmed";
    return "says nothing inserted";
  }
  return undefined;
}

export const colors = {
  "mic open": "orange",
  processing: "blue",
  "says inserted": "teal",
  "says nothing inserted": "tan",
  "says not confirmed": "yellow",
};

export function step(action, from) {
  switch (action) {
    case "YouPress":
      return from.phase === "idle" ? "you press the key" : null;
    case "YouLetGoEarly":
      return "you let go";
    case "YouLetGo":
      return "you let go";
    case "YouLetGoTooSoon":
      return "you let go within 250 ms";
    case "YouLetGoAfterTheMicStopped":
      return "you let go";
    case "YouPressEscape":
      return "you press Escape";
    case "MicRecords":
      return "the mic delivers audio";
    case "MicRecordsAfterYouLetGo":
      return "the mic delivers audio [you held 250 ms or more]";
    case "MicRecordsAfterATap":
      return "the mic delivers audio [you held under 250 ms]";
    case "MicDoesNotStart":
      return "the mic fails or takes 3 s";
    case "MicStopsOnItsOwn":
      return "the mic changes or 10 min pass";
    case "HearsWordsCleanupOn":
      return "Voice hears words [cleanup on]";
    case "HearsWordsCleanupOff":
      return "Voice hears words [cleanup off]";
    case "HearsNothing":
      return "Voice hears nothing";
    case "TranscriptionFails":
      return "transcription fails or takes too long";
    case "CleanupReturnsText":
    case "CleanupFails":
      return "cleanup returns text, or fails and the raw text goes in";
    case "CleanupReturnsNothing":
      return "cleanup returns nothing";
    case "AppTakesText":
      return "the app takes the text";
    case "AppRefusesText":
      return "the app refuses the text";
    case "AppDoesNotAnswer":
      return "the app does not answer the write in time";
    case "InsertTimesOut":
      return "6.5 s pass with no answer";
    case "LateInsertRefused":
      return "the helper's insert fails late";
    case "HelperCrashes":
      return "the helper crashes";
    case "FlowBarClears":
      return "the Flow Bar clears";
  }
  return action;
}
