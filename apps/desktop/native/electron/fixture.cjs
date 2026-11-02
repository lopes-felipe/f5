// A separate, suite-owned Chromium app. Receipts describe synthetic UI outcomes
// only; this process cannot grant access, post native input or execute tools.
const { app, BrowserWindow, ipcMain } = require("electron");
const { join } = require("node:path");
const { mkdirSync } = require("node:fs");

const dataDirectory = join(__dirname, "../fixture-userdata");
mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
app.setPath("userData", dataDirectory);
app.setPath("sessionData", dataDirectory);
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("no-proxy-server");
app.setAccessibilitySupportEnabled(true);
let window;
let ready = false;
let presses = 0;
let typed = false;
const receipt = (line) => process.stdout.write(line + "\n");
ipcMain.on("fixture-observation", (event, observation) => {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    return;
  if (observation === "ready" && !ready) {
    ready = true;
    window.show();
    receipt("FIXTURE_READY");
  } else if (ready && observation === "press" && presses < 100) {
    presses++;
    receipt("FIXTURE_PRESSED");
  } else if (ready && observation === "typed" && !typed) {
    typed = true;
    receipt("FIXTURE_TYPED");
  }
});
app
  .whenReady()
  .then(async () => {
    window = new BrowserWindow({
      width: 600,
      height: 400,
      show: false,
      title: "Chromium Computer Control Fixture",
      webPreferences: {
        preload: join(__dirname, "preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !details.url.startsWith("file:") });
    });
    window.on("closed", () => {
      window = undefined;
    });
    await window.loadFile(join(__dirname, "fixture.html"));
  })
  .catch(() => {
    receipt("FIXTURE_FAILED");
    app.exit(1);
  });
app.on("window-all-closed", () => app.quit());
process.stdin.resume();
process.stdin.on("end", () => app.quit());
process.on("SIGTERM", () => app.quit());
