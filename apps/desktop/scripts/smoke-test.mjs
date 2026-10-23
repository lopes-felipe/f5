import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireDesktop = createRequire(join(desktopDir, "package.json"));
const requireWeb = createRequire(resolve(desktopDir, "../web/package.json"));
const { writeDiagnostics } = createRequire(import.meta.url)(
  "../../../scripts/lib/ci-diagnostics.cjs",
);
const artifactDirectory = process.env.F5_CI_ARTIFACT_DIR;
// Certification records are bundled into main; a packaged app never reads docs/.
{
  const main = readFileSync(join(desktopDir, "dist-electron/main.js"), "utf8");
  const certificationDir = resolve(desktopDir, "../../packages/shared/src/certification");
  for (const file of ["claude-chrome", "codex-chrome", "codex-computer"]) {
    const records = JSON.parse(
      readFileSync(join(certificationDir, `${file}.generated.json`), "utf8"),
    );
    for (const record of records)
      if (!main.includes(record.id))
        throw new Error(`Certification record ${record.id} is not bundled into desktop main`);
  }
  if (main.includes("docs/computer-certification"))
    throw new Error("Desktop main must not resolve certification records from docs/");
}
const { _electron } = requireWeb("playwright");
const directory = mkdtempSync(join(tmpdir(), "f5-desktop-smoke-"));
const overlayModule = join(directory, "computer-overlay.cjs");

const state = join(directory, "app", "userdata");
mkdirSync(state, { recursive: true });
writeFileSync(
  join(state, "settings.json"),
  JSON.stringify({
    providers: {
      ...Object.fromEntries(
        ["claude", "cursor", "opencode", "grok"].map((id) => [id, { enabled: false }]),
      ),
      codex: {
        enabled: true,
        binaryPath: resolve(desktopDir, "../../scripts/fixtures/codex-lifecycle-host.mjs"),
        homePath: join(directory, "codex-home"),
      },
    },
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
let failure = "";
let screenshot;
const exportDiagnostics = () => {
  writeDiagnostics(artifactDirectory || directory, "desktop-smoke", {
    logs:
      output +
      (() => {
        try {
          return (
            "\nDesktop main process:\n" +
            readFileSync(join(state, "logs", "desktop-main.log"), "utf8").slice(-65_536)
          );
        } catch {
          return "";
        }
      })(),
    failure,
    screenshot,
    paths: [directory, resolve(desktopDir, "../.."), process.env.HOME, process.env.USERPROFILE],
  });
};
// Preserve diagnostics for an unhandled rejection in Playwright's launch internals.
// Monitoring does not swallow the exception or change its failing exit status.
process.on("uncaughtExceptionMonitor", (error) => {
  failure = String(error?.stack ?? error);
  console.error(`Desktop smoke artifacts: ${artifactDirectory || directory}`);
  exportDiagnostics();
});
try {
  if (process.platform === "darwin") {
    execFileSync(
      "bun",
      [
        "build",
        join(desktopDir, "src/computer/ComputerOverlay.ts"),
        "--target=node",
        "--format=cjs",
        "--external=electron",
        "--outfile",
        overlayModule,
      ],
      { cwd: desktopDir, stdio: "pipe" },
    );
  }
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
  let page = await application.firstWindow({ timeout: 60_000 });
  const errors = [];
  page.on("requestfailed", (request) =>
    console.error(
      "Smoke request failure:",
      new URL(request.url()).pathname,
      request.failure()?.errorText,
    ),
  );
  page.on("console", (message) => {
    if (message.type() === "error")
      console.error(
        "Smoke renderer error:",
        message.text().replace(/token=[^&\s']+/gu, "token=REDACTED"),
      );
  });
  page.on("pageerror", (error) => errors.push(error.message));
  // Positive evidence: bundled renderer and its authenticated server connection both work.
  await page
    .getByRole("button", { name: "Add your first project", exact: true })
    .waitFor({ timeout: 60_000 });
  // The renderer can become ready before Electron shows its native surface.
  // Capturing that hidden surface under Xvfb can fail with a zero-width bitmap.
  await page.waitForFunction(
    () => document.visibilityState === "visible" && innerWidth > 0 && innerHeight > 0,
    undefined,
    { timeout: 60_000 },
  );
  screenshot = await page.screenshot();
  if (process.platform === "darwin") {
    await application.evaluate(async ({ app, BrowserWindow, screen }, modulePath) => {
      const require = process.getBuiltinModule("module").createRequire(modulePath);
      const { ComputerOverlay } = require(modulePath);
      const overlay = new ComputerOverlay();
      const originalWindows = BrowserWindow.getAllWindows();
      const checkDock = (phase) => {
        if (!app.dock.isVisible()) throw new Error(`Computer overlay hid the Dock: ${phase}`);
        if (originalWindows.some((window) => window.isDestroyed() || !window.isVisible()))
          throw new Error(`Computer overlay hid an app window: ${phase}`);
      };
      checkDock("before overlay");
      try {
        for (let cycle = 0; cycle < 3; cycle++) {
          overlay.show({ provider: "claude", executionGeneration: cycle + 1 });
          checkDock("creating overlay");
          const windows = BrowserWindow.getAllWindows().filter(
            (window) => !originalWindows.includes(window),
          );
          if (windows.length !== screen.getAllDisplays().length)
            throw new Error(
              `Computer overlay window count ${windows.length} did not match display count ${screen.getAllDisplays().length} on cycle ${cycle}`,
            );
          await Promise.all(windows.map((window) => window.webContents.executeJavaScript("true")));
          for (const window of windows) {
            if (!window.isVisibleOnAllWorkspaces() || window.isFocusable())
              throw new Error("Computer overlay lost its workspace or non-interactive behavior");
          }
          checkDock("showing overlay");
          const closed = windows.map(
            (window) => new Promise((resolve) => window.once("closed", resolve)),
          );
          overlay.clear();
          await Promise.all(closed);
          checkDock("clearing overlay");
        }
      } finally {
        overlay.close();
      }
      checkDock("closing overlay");
    }, overlayModule);
  }
  await page.evaluate(async () => {
    const computer = window.desktopBridge.computerAutomation;
    if (
      !computer ||
      typeof computer.status !== "function" ||
      "execute" in computer ||
      "request" in computer
    )
      throw new Error("Computer bridge must expose controls without an execution path");
    const computerStatus = await computer.status();
    if (
      !computerStatus.available &&
      ![
        "not-certified",
        "helper-missing",
        "missing-permissions",
        "monitor-unhealthy",
        "unsupported-platform",
        "other-instance",
      ].includes(computerStatus.reason)
    )
      throw new Error(`Unexpected computer backend status: ${computerStatus.reason}`);
    const bridge = window.desktopBridge.preview;
    const original = await bridge.getPreviewConfig();
    const persistent = await bridge.profiles.create("Smoke work", true);
    const privateProfile = await bridge.profiles.create("Smoke incognito", false);
    await bridge.profiles.select(privateProfile.id);
    const config = await bridge.createTab("smoke-private-tab", { zoomFactor: 1.25, muted: true });
    if (config.partition.startsWith("persist:") || config.partition === original.partition)
      throw new Error("Incognito isolation failed");
    if (!config.preload.startsWith("file:")) throw new Error("Guest preload is missing");
    let blocked = false;
    try {
      await bridge.profiles.delete(privateProfile.id);
    } catch {
      blocked = true;
    }
    if (!blocked) throw new Error("Active profile deletion was allowed");
    await bridge.closeTab("smoke-private-tab");
    await bridge.profiles.delete(privateProfile.id);
    const fallback = await bridge.createTab("smoke-default-after-delete", {
      zoomFactor: 1,
      muted: false,
    });
    if (fallback.partition !== original.partition)
      throw new Error("Deleting the selected profile did not restore the default");
    await bridge.closeTab("smoke-default-after-delete");
    await bridge.profiles.delete(persistent.id);
    await bridge.profiles.select("default");
  });
  const backendOrigin = await page.evaluate(() => {
    const url = new URL(window.desktopBridge.getWsUrl());
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    return url.origin;
  });
  const authorizedBootstrap = await page.evaluate(async (origin) => {
    const response = await fetch(`${origin}/api/bootstrap`);
    return {
      status: response.status,
      protocolVersion: response.ok ? (await response.json()).protocolVersion : null,
    };
  }, backendOrigin);
  if (authorizedBootstrap.status !== 200)
    throw new Error("Main renderer backend authentication failed");
  if (!Number.isSafeInteger(authorizedBootstrap.protocolVersion))
    throw new Error("Backend did not advertise a valid protocol version");
  const iframeStatus = await page.evaluate(async (origin) => {
    const frame = document.createElement("iframe");
    frame.srcdoc = "<!doctype html><title>untrusted subframe</title>";
    const loaded = new Promise((resolve) => {
      frame.onload = resolve;
    });
    document.body.append(frame);
    await loaded;
    try {
      return (await frame.contentWindow.fetch(`${origin}/api/bootstrap?smoke=iframe`)).status;
    } finally {
      frame.remove();
    }
  }, backendOrigin);
  if (iframeStatus !== 401)
    throw new Error(`Subframe received backend authorization (${iframeStatus})`);
  await application.evaluate(({ BrowserWindow }, origin) => {
    const session = BrowserWindow.getAllWindows()[0].webContents.session;
    globalThis.__smokeImageResponse = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(-1), 10000);
      session.webRequest.onSendHeaders({ urls: [`${origin}/*`] }, (details) => {
        if (details.url === `${origin}/attachments/smoke-missing.png?smoke=iframe-image`) {
          clearTimeout(timer);
          resolve(
            Object.keys(details.requestHeaders).some((key) => key.toLowerCase() === "authorization")
              ? 200
              : 401,
          );
        }
      });
    });
  }, backendOrigin);
  await page.evaluate((origin) => {
    const frame = document.createElement("iframe");
    frame.srcdoc = `<img src="${origin}/attachments/smoke-missing.png?smoke=iframe-image">`;
    frame.id = "smoke-image-frame";
    document.body.append(frame);
  }, backendOrigin);
  const imageStatus = await application.evaluate(async ({ BrowserWindow }) => {
    const status = await globalThis.__smokeImageResponse;
    BrowserWindow.getAllWindows()[0].webContents.session.webRequest.onSendHeaders(null);
    return status;
  });
  if (imageStatus !== 401)
    throw new Error(`Subframe image authorization check returned ${imageStatus}`);
  await page.evaluate(() => document.getElementById("smoke-image-frame")?.remove());
  const popupStatus = await application.evaluate(async ({ BrowserWindow }, origin) => {
    const owner = BrowserWindow.getAllWindows()[0];
    const session = owner.webContents.session;
    const popup = new BrowserWindow({
      show: false,
      webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const target = `${origin}/api/bootstrap?smoke=popup`;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Popup request timed out")), 10000);
      session.webRequest.onCompleted({ urls: [`${origin}/*`] }, (details) => {
        if (details.url === target) {
          clearTimeout(timer);
          resolve(details.statusCode);
        }
      });
    });
    try {
      await popup.loadURL(target);
      return await response;
    } finally {
      session.webRequest.onCompleted(null);
      popup.destroy();
    }
  }, backendOrigin);
  if (popupStatus !== 401) throw new Error("Popup received backend authorization");
  const previewConfig = await page.evaluate(() => window.desktopBridge.preview.getPreviewConfig());
  if (!previewConfig.preload || !existsSync(new URL(previewConfig.preload)))
    throw new Error("Built guest preload is missing on disk");
  await application.evaluate(
    ({ session }, { origin, partition }) => {
      const guestSession = session.fromPartition(partition);
      globalThis.__smokeGuestResponse = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Guest request timed out")), 10000);
        guestSession.webRequest.onCompleted({ urls: [`${origin}/*`] }, (details) => {
          if (details.url === `${origin}/api/bootstrap?smoke=guest`) {
            clearTimeout(timer);
            resolve(details.statusCode);
          }
        });
      });
    },
    { origin: backendOrigin, partition: previewConfig.partition },
  );
  const attachedUrl = await page.evaluate(
    ({ origin, partition }) =>
      new Promise((resolve, reject) => {
        const target = `${origin}/api/bootstrap?smoke=guest`;
        const guest = document.createElement("webview");
        guest.id = "smoke-untrusted-guest";
        guest.setAttribute("partition", partition);
        guest.setAttribute("src", target);
        guest.style.height = "100px";
        const timer = setTimeout(() => reject(new Error("Guest did not attach")), 10000);
        guest.addEventListener(
          "dom-ready",
          () => {
            clearTimeout(timer);
            // Guests attach blank. A backend navigation can be vetoed before
            // networking, so test request authentication with a fetch instead.
            // The session's onCompleted receipt must still report exactly 401;
            // a cancellation, timeout or authenticated response never passes.
            const url = guest.getURL();
            void guest
              .executeJavaScript(
                `fetch(${JSON.stringify(target)}, { mode: "no-cors" }).catch(() => undefined)`,
              )
              .catch(() => undefined);
            resolve(url);
          },
          { once: true },
        );
        document.body.append(guest);
      }),
    { origin: backendOrigin, partition: previewConfig.partition },
  );
  if (attachedUrl !== "about:blank")
    throw new Error(`Guest loaded ${attachedUrl} before its tab policy was installed`);
  const guestStatus = await application.evaluate(async ({ session }, partition) => {
    try {
      return await globalThis.__smokeGuestResponse;
    } finally {
      session.fromPartition(partition).webRequest.onCompleted(null);
    }
  }, previewConfig.partition);
  await page.evaluate(() => document.getElementById("smoke-untrusted-guest")?.remove());
  if (guestStatus !== 401) throw new Error(`Guest received backend authorization (${guestStatus})`);

  const workspace = join(directory, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "README.md"), "Desktop smoke fixture\n");
  await page.getByRole("button", { name: "Add your first project", exact: true }).click();
  await page.getByPlaceholder("Enter path (e.g. ~/projects/my-app)").fill(workspace);
  await page.getByRole("button", { name: "Add (Enter)", exact: true }).click();
  // The chat header breadcrumb reuses this label; wait for the sidebar entry.
  await page
    .locator('[data-sidebar="menu-action"]')
    .and(page.getByRole("button", { name: "Project actions for workspace", exact: true }))
    .waitFor({ timeout: 60_000 });

  // Page and native window titles follow the route; no surface falls back to an error.
  const nativeTitle = () =>
    application.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => !window.isDestroyed())
          ?.getTitle() ?? null,
    );
  const waitForTitles = async (expected) => {
    const deadline = Date.now() + 10_000;
    let documentTitle = null;
    let windowTitle = null;
    while (Date.now() < deadline) {
      documentTitle = await page.title();
      windowTitle = await nativeTitle();
      if (documentTitle === expected && windowTitle === expected) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (documentTitle !== expected || windowTitle !== expected)
      throw new Error(
        `Expected title "${expected}", got document "${documentTitle}" and window "${windowTitle}"`,
      );
    const fallbacks = await page.locator('[data-slot="surface-error"]').count();
    if (fallbacks !== 0) throw new Error(`An error fallback is showing on "${expected}"`);
  };
  const openRoute = (hash) =>
    page.evaluate((target) => {
      window.location.hash = target;
    }, hash);
  const selectWindowTitleDetail = async (label) => {
    await page.getByLabel("Window title", { exact: true }).click();
    await page.getByRole("option", { name: label, exact: true }).click();
  };
  const threadHash = new URL(page.url()).hash;
  await waitForTitles("workspace · F5");
  await openRoute("#/usage");
  await waitForTitles("Usage · F5");
  await openRoute("#/pull-requests");
  await waitForTitles("Pull Requests · F5");
  await openRoute("#/settings");
  await waitForTitles("Settings · F5");
  await selectWindowTitleDetail("Thread title");
  await openRoute(threadHash);
  await waitForTitles("New thread · F5");
  await openRoute("#/settings");
  await waitForTitles("Settings · F5");
  await selectWindowTitleDetail("Project name");
  await openRoute(threadHash);
  await waitForTitles("workspace · F5");
  await page.locator('[contenteditable="true"]').waitFor({ timeout: 60_000 });

  await page.locator('[contenteditable="true"]').fill("**a****b**\n# Title **bold**");
  await page.reload();
  await page.locator('[contenteditable="true"]').waitFor({ timeout: 60_000 });
  if (
    (await page.locator('[contenteditable="true"]').innerText()) !== "**a****b**\n# Title **bold**"
  ) {
    throw new Error("Composer draft was not restored after reload");
  }
  // Stop keeps the window and its immutable preload URL, just like an exited backend.
  const stopDefaultBackend = () =>
    application.evaluate(({ Menu }) => {
      const profile = Menu.getApplicationMenu()
        .items.flatMap((item) => item.submenu?.items ?? [])
        .find((item) => item.label === "Default");
      const stop = profile?.submenu?.items.find((item) => item.label === "Stop");
      if (!stop) throw new Error("Missing default profile Stop action");
      stop.click();
    });
  const waitForBackend = (expected) =>
    page.waitForFunction(
      async ({ origin, expected }) => {
        try {
          const response = await fetch(`${origin}/api/bootstrap`);
          // An auth failure still proves a server is listening. Stop recovery
          // must wait for source closure before trying to start its replacement.
          return expected ? response.ok : false;
        } catch {
          return !expected;
        }
      },
      { origin: backendOrigin, expected },
      { timeout: 60_000 },
    );
  const nativeRequest = async (method, body) => {
    try {
      return await page.evaluate(
        ({ method, body, protocolVersion }) =>
          new Promise((resolve, reject) => {
            const url = new URL(window.desktopBridge.getWsUrl());
            url.searchParams.set("protocol", String(protocolVersion));
            const socket = new WebSocket(url);
            const controller = new AbortController();
            const timer = setTimeout(
              () => finish(new Error(`Desktop smoke request timed out: ${method}`)),
              15_000,
            );
            const finish = (error, value) => {
              clearTimeout(timer);
              controller.abort();
              socket.close();
              if (error) reject(error);
              else resolve(value);
            };
            socket.addEventListener(
              "open",
              () =>
                socket.send(
                  JSON.stringify({ id: "desktop-smoke", body: { ...body, _tag: method } }),
                ),
              { signal: controller.signal },
            );
            socket.addEventListener(
              "message",
              (event) => {
                const response = JSON.parse(String(event.data));
                if (response.id !== "desktop-smoke") return;
                finish(response.error ? new Error(response.error.message) : null, response.result);
              },
              { signal: controller.signal },
            );
            socket.addEventListener(
              "error",
              () => finish(new Error("Desktop smoke connection failed")),
              { signal: controller.signal },
            );
            socket.addEventListener(
              "close",
              (event) =>
                finish(
                  new Error(`Desktop smoke connection closed (${event.code}: ${event.reason})`),
                ),
              { signal: controller.signal },
            );
          }),
        { method, body, protocolVersion: authorizedBootstrap.protocolVersion },
      );
    } catch (cause) {
      throw new Error(`Desktop smoke request failed: ${method}`, { cause });
    }
  };
  const terminalInput = {
    threadId: "desktop-shutdown-smoke",
    terminalId: "default",
    cwd: workspace,
    cols: 80,
    rows: 24,
  };
  const waitForTerminalOutput = async (marker) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const snapshot = await nativeRequest("terminal.snapshot", {
        threadId: terminalInput.threadId,
        terminalId: terminalInput.terminalId,
      });
      // The echoed shell command contains the marker once. Require actual
      // subprocess output as well, rather than passing on that echo alone.
      if ((snapshot?.history.split(marker).length ?? 1) - 1 >= 3) return snapshot;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Terminal smoke subprocess did not emit output");
  };
  const startTerminalStream = async (marker) => {
    await nativeRequest("terminal.open", terminalInput);
    const script = `process.stdout.write('BEGIN'+String.fromCharCode(10));setInterval(()=>process.stdout.write('${marker}'+String.fromCharCode(10)),100)`;
    await nativeRequest("terminal.write", {
      threadId: terminalInput.threadId,
      terminalId: terminalInput.terminalId,
      data: `node -e "${script}"\r`,
    });
    return waitForTerminalOutput(marker);
  };
  const recoveryTerminalMarker = "F5_BACKEND_RECOVERY_OUTPUT";
  await startTerminalStream(recoveryTerminalMarker);
  const retainedWsUrl = await page.evaluate(() => window.desktopBridge.getWsUrl());
  const retainedRendererUrl = page.url();
  const recoveryCount = () =>
    readFileSync(join(state, "logs", "desktop-main.log"), "utf8").split(
      "profile open ready profile=",
    ).length - 1;
  const waitForRecovery = async (previousCount) => {
    const deadline = Date.now() + 60_000;
    while (recoveryCount() <= previousCount) {
      if (Date.now() > deadline) throw new Error("Profile recovery did not finish");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await waitForBackend(true);
  };
  await stopDefaultBackend();
  await waitForBackend(false);
  const beforeSecondInstance = recoveryCount();
  await application.evaluate(({ app }) => app.emit("second-instance", {}, [], ""));
  await waitForRecovery(beforeSecondInstance);
  const restoredTerminal = await nativeRequest("terminal.open", terminalInput);
  if (!restoredTerminal.history.includes(recoveryTerminalMarker))
    throw new Error("Backend recovery lost terminal history");
  if ((await page.evaluate(() => window.desktopBridge.getWsUrl())) !== retainedWsUrl)
    throw new Error("Reopening changed the retained window's connection");
  if (
    (await page.locator('[contenteditable="true"]').innerText()) !== "**a****b**\n# Title **bold**"
  )
    throw new Error("Backend recovery changed the retained composer draft");
  if (process.platform === "darwin") {
    await stopDefaultBackend();
    await waitForBackend(false);
    await application.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.close();
    });
    const beforeActivate = recoveryCount();
    const reopened = application.waitForEvent("window");
    await application.evaluate(({ app }) => app.emit("activate"));
    page = await reopened;
    page.on("pageerror", (error) => errors.push(error.message));
    await waitForRecovery(beforeActivate);
    await page.goto(retainedRendererUrl);
    await page.locator('[contenteditable="true"]').waitFor({ timeout: 60_000 });
    await waitForBackend(true);
    if (
      (await page.locator('[contenteditable="true"]').innerText()) !==
      "**a****b**\n# Title **bold**"
    )
      throw new Error("Dock recovery did not restore the saved composer draft");
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
  // Without a PostHog key the server never creates an anonymous telemetry id.
  if (existsSync(join(state, "anonymous-id")))
    throw new Error("Telemetry created an anonymous id without a configured key");
  const observeUnloadDialog = () => {};
  page.on("dialog", observeUnloadDialog);
  await page.evaluate(() => {
    window.__smokeQuitVeto = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", window.__smokeQuitVeto);
  });
  await application.evaluate(({ app }) => app.quit());
  await page.waitForTimeout(300);
  if (electronProcess.exitCode !== null) throw new Error("Draft veto did not cancel quit");
  await application.evaluate(({ app }) => app.emit("activate"));
  await waitForBackend(true);
  if (
    !(await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible()),
    ))
  )
    throw new Error("Cancelled quit left the app hidden");
  await page.evaluate(() => window.removeEventListener("beforeunload", window.__smokeQuitVeto));
  page.off("dialog", observeUnloadDialog);
  await page.reload();
  await page.locator('[contenteditable="true"]').waitFor({ timeout: 60000 });
  const sendProviderPrompt = async (prompt) => {
    await page.locator('[contenteditable="true"]').fill(prompt);
    // Interrupting a turn pauses its queue, so the next explicit submission is
    // labelled "Send now" rather than "Send message".
    await page.getByRole("button", { name: /^Send (?:message|now)$/ }).click();
    await page
      .getByRole("button", {
        name: prompt.startsWith("F5_SMOKE_APPROVAL") ? "Approve once" : "Stop generation",
        exact: true,
      })
      .waitFor();
    // The composer renders optimistically. Wait for server acceptance before
    // taking a persistence snapshot or interrupting the newly started turn.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const snapshot = await nativeRequest("orchestration.getSnapshot", {});
      const thread = snapshot.threads.find(
        (entry) =>
          entry.session?.activeTurnId &&
          entry.messages.some((message) => message.role === "user" && message.text === prompt),
      );
      if (thread) return thread;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Provider prompt did not reach active orchestration state: ${prompt}`);
  };
  const stopProviderTurn = async () => {
    await page.getByRole("button", { name: "Stop generation", exact: true }).click();
    await page
      .getByRole("button", { name: "Stop generation", exact: true })
      .waitFor({ state: "hidden" });
  };
  await sendProviderPrompt("F5_SMOKE_STREAM stop");
  await page.getByText("Desktop stream 1", { exact: false }).first().waitFor();
  await stopProviderTurn();
  await sendProviderPrompt("F5_SMOKE_APPROVAL");
  await page.getByRole("button", { name: "Approve once", exact: true }).click();
  await page
    .getByRole("button", { name: "Approve once", exact: true })
    .waitFor({ state: "hidden" });
  await stopProviderTurn();
  const providerThread = await sendProviderPrompt("F5_SMOKE_STREAM quit");
  const providerRendererUrl = page.url();
  const waitForProviderOutput = async () => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const details = await nativeRequest("orchestration.getThreadDetails", {
        threadId: providerThread.id,
      });
      const output = details.messages.filter((message) => message.role === "assistant");
      if (output.length >= 3 && output.every((message) => message.text.includes("Desktop stream")))
        return output;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Provider stream did not produce persisted output");
  };
  await openRoute("#/usage");
  await waitForTitles("Usage · F5");
  await page.goto(providerRendererUrl);
  await page.getByRole("button", { name: "Stop generation", exact: true }).waitFor();
  const providerMessages = await waitForProviderOutput();
  const pendingDraft = "Keep this draft through provider and terminal shutdown";
  await page.locator('[contenteditable="true"]').fill(pendingDraft);
  const quitTerminalMarker = "F5_DESKTOP_QUIT_OUTPUT";
  await startTerminalStream(quitTerminalMarker);
  const popupEvent = application.waitForEvent("window");
  await application.evaluate(({ BrowserWindow }) => {
    const popup = new BrowserWindow({ width: 320, height: 240, webPreferences: { sandbox: true } });
    void popup.loadURL("data:text/html,<title>Quit smoke popup</title><p>Quit shortcut smoke</p>");
  });
  const popup = await popupEvent;
  await popup.waitForLoadState();
  // Inject through Electron so this exercises before-input-event on a non-app renderer.
  // CDP keyboard events do not consistently reach that native hook on macOS.
  const pressQuit = (taps = 1) =>
    application.evaluate(async ({ BrowserWindow }, count) => {
      const popup = BrowserWindow.getAllWindows().find(
        (window) => window.getTitle() === "Quit smoke popup",
      );
      if (!popup) throw new Error("Missing quit smoke popup");
      popup.focus();
      popup.webContents.focus();
      const modifiers = process.platform === "darwin" ? ["meta"] : ["control"];
      for (let tap = 0; tap < count; tap++) {
        popup.webContents.sendInputEvent({ type: "keyDown", keyCode: "Q", modifiers });
        await new Promise((resolve) => setTimeout(resolve, 40));
        if (!popup.isDestroyed())
          popup.webContents.sendInputEvent({ type: "keyUp", keyCode: "Q", modifiers });
      }
    }, taps);
  await pressQuit();
  await new Promise((resolve) => setTimeout(resolve, 650));
  if (electronProcess.exitCode !== null) throw new Error("A single quit tap closed the app");
  const closed = application.waitForEvent("close", { timeout: 10000 });
  // Keep the two native taps in one main-process evaluation: two CDP
  // round trips under streaming load can exceed the 500 ms gesture window.
  await pressQuit(2);
  await closed;
  // Reopen the same isolated profile after a real app quit with a live PTY.
  application = await _electron.launch({
    executablePath: requireDesktop("electron"),
    args: [wrapper],
    cwd: directory,
    env,
    timeout: 60_000,
  });
  electronProcess = application.process();
  for (const stream of [electronProcess.stdout, electronProcess.stderr])
    stream?.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-65_536);
    });
  page = await application.firstWindow({ timeout: 60_000 });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(providerRendererUrl);
  await page.locator('[contenteditable="true"]').waitFor({ timeout: 60_000 });
  const quitHistory = await nativeRequest("terminal.open", terminalInput);
  if (quitHistory.history.split(quitTerminalMarker).length - 1 < 3)
    throw new Error("Desktop quit/reopen lost active terminal output");
  const restoredProviderMessages = await waitForProviderOutput();
  for (const before of providerMessages) {
    const after = restoredProviderMessages.find((message) => message.id === before.id);
    if (!after?.text.startsWith(before.text))
      throw new Error("Desktop quit/reopen lost provider output");
  }
  if ((await page.locator('[contenteditable="true"]').innerText()) !== pendingDraft)
    throw new Error("Desktop quit/reopen lost the streaming thread's draft");
  await page
    .getByRole("button", { name: "Stop generation", exact: true })
    .waitFor({ state: "hidden", timeout: 15_000 });
  await nativeRequest("terminal.close", {
    threadId: terminalInput.threadId,
    terminalId: terminalInput.terminalId,
  });
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    artifactDirectory
      ? "Desktop smoke test passed."
      : `Desktop smoke test passed. Isolated artifacts: ${directory}`,
  );
} catch (error) {
  failure = String(error?.stack ?? error);
  try {
    screenshot = await application?.windows()[0]?.screenshot({ timeout: 5000 });
  } catch {}
  console.error("Desktop smoke test failed:", error, output);
  console.error(`Desktop smoke artifacts: ${artifactDirectory || directory}`);
  process.exitCode = 1;
} finally {
  try {
    exportDiagnostics();
  } finally {
    try {
      if (electronProcess?.exitCode === null) await application.close();
    } finally {
      // Preserve local state for debugging. Locked Crashpad/helper files on CI
      // must not turn successful assertions into a failing smoke verdict.
      if (artifactDirectory) {
        try {
          rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        } catch (error) {
          console.warn(`Could not remove desktop smoke temp state at ${directory}:`, error);
        }
      }
    }
  }
}
