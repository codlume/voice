const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");

app.setPath("userData", process.env.VOICE_E2E_TARGET_USER_DATA);

app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 480, height: 320, title: "Voice e2e target" });
  void window.loadFile(join(__dirname, "index.html"));
});

app.on("window-all-closed", () => app.quit());
