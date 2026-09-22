import { contextBridge, ipcRenderer } from "electron";
import {
  commandChannel,
  decodeCommand,
  decodeReply,
  decodeView,
  revealChannel,
  type PreloadApi,
} from "@voice/contracts/desktop";

const api: PreloadApi = {
  command: async (command) => {
    let validated;
    try {
      validated = decodeCommand(command);
    } catch {
      throw new Error("Invalid command");
    }
    return decodeReply(await ipcRenderer.invoke(commandChannel, validated));
  },
  onChanged(listener) {
    const callback = () => listener();
    ipcRenderer.on("voice:changed", callback);
    return () => ipcRenderer.removeListener("voice:changed", callback);
  },
  onReveal(listener) {
    const callback = (_event: unknown, view: unknown) => {
      try {
        listener(decodeView(view));
      } catch {
        /* Only known sections can be revealed. */
      }
    };
    ipcRenderer.on(revealChannel, callback);
    return () => ipcRenderer.removeListener(revealChannel, callback);
  },
};
contextBridge.exposeInMainWorld("voice", api);
