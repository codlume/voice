import { contextBridge, ipcRenderer } from "electron";
import {
  commandChannel,
  decodeCommand,
  decodeReply,
  type DesktopApi,
} from "@voice/contracts/desktop";

const api: DesktopApi & { onChanged: (listener: () => void) => () => void } = {
  command: async (command) =>
    decodeReply(await ipcRenderer.invoke(commandChannel, decodeCommand(command))),
  onChanged(listener) {
    const callback = () => listener();
    ipcRenderer.on("voice:changed", callback);
    return () => ipcRenderer.removeListener("voice:changed", callback);
  },
};
contextBridge.exposeInMainWorld("voice", api);
