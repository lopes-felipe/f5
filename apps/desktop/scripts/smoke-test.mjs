import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireDesktop = createRequire(join(desktopDir, "package.json"));
const requireWeb = createRequire(resolve(desktopDir, "../web/package.json"));
const { _electron } = requireWeb("playwright");
const directory = mkdtempSync(join(tmpdir(), "f5-desktop-smoke-"));
const state = join(directory, "app", "userdata");
mkdirSync(state, { recursive: true });
writeFileSync(
  join(state, "settings.json"),
  JSON.stringify({
    providers: Object.fromEntries(
      ["codex", "claude", "cursor", "opencode", "grok"].map((id) => [id, { enabled: false }]),
    ),
    prHub: { pollIntervalSeconds: 0, discoverNotifications: false },
  }),
);
// Main sets userData itself. Redirect that assignment before it takes the instance lock.
const wrapper = join(directory, "launch.cjs");
writeFileSync(
  wrapper,
  `const {app}=require("electron");
const setPath=app.setPath.bind(app);
app.setPath=(key,value)=>setPath(key,key==='userData'?${JSON.stringify(join(directory, "electron"))}:value);
require(${JSON.stringify(join(desktopDir, "dist-electron/main.js"))});
`,
);
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^(F5_|T3CODE_|VITE_|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_|ELECTRON_)/.test(key) &&
      !/TOKEN|API_KEY/.test(key),
  ),
);
env.F5_HOME = join(directory, "app");
let application;
let electronProcess;
let output = "";
try {
  application = await _electron.launch({
    executablePath: requireDesktop("electron"),
    args: [wrapper],
    cwd: directory,
    env,
    timeout: 60_000,
  });
  electronProcess = application.process();
  for (const stream of [electronProcess.stdout, electronProcess.stderr]) {
    stream?.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-65_536);
    });
  }
  const page = await application.firstWindow({ timeout: 60_000 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Positive evidence: bundled renderer and its authenticated server connection both work.
  await page
    .getByRole("button", { name: "Add your first project", exact: true })
    .waitFor({ timeout: 60_000 });
  await page.screenshot({ path: join(directory, "welcome.png") });
  const workspace = join(directory, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "README.md"), "Desktop smoke fixture\n");
  await page.getByRole("button", { name: "Add your first project", exact: true }).click();
  await page.getByPlaceholder("Enter path (e.g. ~/projects/my-app)").fill(workspace);
  await page.getByRole("button", { name: "Add (Enter)", exact: true }).click();
  await page
    .getByRole("button", { name: "Project actions for workspace", exact: true })
    .waitFor({ timeout: 60_000 });
  await page.locator('[contenteditable="true"]').fill("**a****b**\n# Title **bold**");
  await page.reload();
  await page.locator('[contenteditable="true"]').waitFor({ timeout: 60_000 });
  if (
    (await page.locator('[contenteditable="true"]').innerText()) !== "**a****b**\n# Title **bold**"
  ) {
    throw new Error("Composer draft was not restored after reload");
  }
  await page.screenshot({ path: join(directory, "workspace.png") });
  if (errors.length) throw new Error(errors.join("\n"));
  await page.evaluate(() => window.desktopBridge.setAttentionBadge(3));
  if (
    process.platform === "darwin" &&
    (await application.evaluate(({ app }) => app.getBadgeCount())) !== 3
  )
    throw new Error("Desktop attention badge was not updated");
  await page.evaluate(() => window.desktopBridge.setAttentionBadge(0));
  const popupEvent = application.waitForEvent("window");
  await application.evaluate(({ BrowserWindow }) => {
    const popup = new BrowserWindow({ width: 320, height: 240, webPreferences: { sandbox: true } });
    void popup.loadURL("data:text/html,<title>Quit smoke popup</title><p>Quit shortcut smoke</p>");
  });
  const popup = await popupEvent;
  await popup.waitForLoadState();
  // Inject through Electron so this exercises before-input-event on a non-app renderer.
  // CDP keyboard events do not consistently reach that native hook on macOS.
  const pressQuit = () =>
    application.evaluate(async ({ BrowserWindow }) => {
      const popup = BrowserWindow.getAllWindows().find(
        (window) => window.getTitle() === "Quit smoke popup",
      );
      if (!popup) throw new Error("Missing quit smoke popup");
      const modifiers = process.platform === "darwin" ? ["meta"] : ["control"];
      popup.webContents.sendInputEvent({ type: "keyDown", keyCode: "Q", modifiers });
      await new Promise((resolve) => setTimeout(resolve, 40));
      popup.webContents.sendInputEvent({ type: "keyUp", keyCode: "Q", modifiers });
    });
  await pressQuit();
  await new Promise((resolve) => setTimeout(resolve, 650));
  if (electronProcess.exitCode !== null) throw new Error("A single quit tap closed the app");
  const closed = application.waitForEvent("close", { timeout: 10000 });
  await pressQuit();
  await pressQuit();
  await closed;
  console.log(`Desktop smoke test passed. Isolated artifacts: ${directory}`);
} catch (error) {
  console.error("Desktop smoke test failed:", error, output);
  process.exitCode = 1;
} finally {
  writeFileSync(join(directory, "desktop.log"), output);
  if (electronProcess?.exitCode === null) await application.close();
}
