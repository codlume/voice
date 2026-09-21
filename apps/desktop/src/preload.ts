import { contextBridge, ipcRenderer } from "electron";
import {
  commandChannel,
  decodeCommand,
  decodeReply,
  type DesktopApi,
} from "@voice/contracts/desktop";

const api: DesktopApi & { onChanged: (listener: () => void) => () => void } = {
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
};
contextBridge.exposeInMainWorld("voice", api);
