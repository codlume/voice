export const title = "Installing a model";

export function state(v) {
  switch (v.work) {
    case "removing":
      return "Uninstalling";
    case "stalled":
      return "Download stalled";
    case "fetching":
      return "Downloading";
    case "verifying":
      return v.ui === "loading" ? "Checking the files, reads Loading" : "Checking the files";
    case "loading":
      return v.ui === "downloading" ? "Loading, reads Downloading" : "Loading";
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
      return from.disk === "complete"
        ? `you press Retry [files on disk, ${from.which} model]`
        : "you press Retry";
    case "ConnectionStalls":
      return "the connection stalls";
    case "BytesResume":
      return "bytes arrive again";
    case "GiveUp":
      return from.which === "speech"
        ? "4 tries time out, about 4 min [speech model]"
        : "30 s pass with no bytes [cleanup model]";
    case "ConnectionFails":
      return "the server or connection fails";
    case "LastByte":
      return "the last byte arrives";
    case "FilesMatch":
      return from.ui === "loading"
        ? "every file matches its hash"
        : `every file matches its hash [${from.which} model]`;
    case "FileMismatch":
      return "a file does not match its hash";
    case "ModelLoads":
      return "the model loads";
    case "LoadFails":
      return "the model fails to load";
    case "YouCancel":
      return "you press Cancel";
    case "YouUninstall":
      return "you confirm Uninstall";
    case "FilesDeleted":
      return "the files are deleted";
  }
  return action;
}
