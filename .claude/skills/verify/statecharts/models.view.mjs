export const title = "Installing a model";

export function state(v) {
  switch (v.work) {
    case "removing":
      return "Uninstalling";
    case "stalled":
      return v.which === "speech"
        ? "Download stalled, nothing to press"
        : "Download stalled, Cancel offered";
    case "fetching":
      return "Downloading";
    case "verifying":
      return "Checking the files";
    case "loading":
      return "Loading";
  }
  if (v.ui === "ready") return "Installed";
  if (v.ui === "failed") return "Failed";
  return "Not installed";
}

export function group(v) {
  if (v.work !== "none") return "busy";
  if (v.ui === "ready") return "ready";
  if (v.ui === "failed") return "failed";
  return "idle";
}

export const colors = { idle: "tan", busy: "blue", ready: "teal", failed: "orange" };

export function step(action, from) {
  switch (action) {
    case "YouInstall":
      if (from.ui === "missing") return "you press Install or Download";
      return from.disk === "complete" ? "you press Retry [files on disk]" : "you press Retry";
    case "ConnectionStalls":
      return `the connection stalls [${from.which} model]`;
    case "BytesResume":
      return "bytes arrive again";
    case "GiveUp":
      return from.which === "speech" ? "4 tries time out, about 4 min" : "30 s pass with no bytes";
    case "ConnectionFails":
      return "the server or connection fails";
    case "LastByte":
      return "the last byte arrives";
    case "FilesMatch":
      return "every file matches its hash";
    case "FileMismatch":
      return "a file does not match its hash";
    case "ModelLoads":
      return "the model loads";
    case "LoadFails":
      return "the model fails to load";
    case "YouCancel":
      return from.work === "stalled" ? "you press Cancel" : "you press Cancel [cleanup model]";
    case "YouUninstall":
      return "you confirm Uninstall";
    case "FilesDeleted":
      return "the files are deleted";
  }
  return action;
}
