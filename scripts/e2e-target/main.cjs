// Throwaway Electron window with one focused textarea. The e2e harness inserts into it to
// prove Chromium targets work, and reads the value back over this process's CDP port.
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");

app.setPath("userData", process.env.VOICE_E2E_TARGET_USER_DATA);

app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 480, height: 320, title: "Voice e2e target" });
  void window.loadFile(join(__dirname, "index.html"));
});

app.on("window-all-closed", () => app.quit());
