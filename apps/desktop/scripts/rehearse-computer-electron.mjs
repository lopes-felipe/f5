import { createRequire } from "node:module";
import { execFile, spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { release, tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  F5_PROTOCOL_VERSION,
  ORCHESTRATION_WS_METHODS,
  ComputerToolOutcomeCode,
  WS_METHODS,
  TurnSubmissionResult,
} from "@t3tools/contracts";
import { Schema } from "effect";
import { PROFILE_OBSERVATION_REQUEST_LIMIT } from "@t3tools/shared/computerRehearsalProfiles";
import {
  REAL_APP_REHEARSAL_IDS,
  REAL_APP_REHEARSAL_TEXT,
} from "../src/computer/rehearsalRealAppsObservation.ts";
import {
  createRehearsalFixture,
  prepareRehearsalExecutable,
} from "../src/computer/rehearsalFixture.ts";
import { closeRehearsalChild } from "../src/computer/rehearsalCleanup.ts";
import { RehearsalExternalClient } from "../src/computer/rehearsalExternalClient.ts";
import { windowlessChecks } from "../../../scripts/computer-certification/windowlessEvidence.ts";
import { runGrantMemory } from "../../../scripts/computer-certification/grantMemory.ts";
import { runSessionActions } from "../../../scripts/computer-certification/sessionActions.ts";
import { runProfileIsolation } from "./rehearse-computer-profile-isolation.mjs";
import {
  profileIsolationChecks,
  profileReadinessChecks,
  profileInspectionDiagnosticChecks,
} from "../../../scripts/computer-certification/profileIsolationEvidence.ts";
import { rehearsalMcpBackendBootstrap } from "../src/computer/rehearsalMcpTransport.ts";
import {
  readChromiumFixture,
  createRehearsalChromiumFixture,
} from "../src/computer/rehearsalChromiumFixture.ts";
import { RehearsalStopObservation } from "../src/computer/rehearsalStopObservation.ts";
import { RehearsalChordObservation } from "../src/computer/rehearsalChordObservation.ts";
import { measureStopLatency } from "../src/computer/stopLatencyMeasurement.ts";
import { createWindowsProcessFreeze } from "../src/computer/rehearsalWindowsFreeze.ts";
import { WindowsFixtureObserver } from "../src/computer/rehearsalWindowsAcceptance.ts";
import {
  rehearsalProviderErrorCodes,
  rehearsalProviderActivityCounts,
  rehearsalSessionErrorCode,
  rehearsalHarnessFailureCode,
  rehearsalHarnessFailureLocation,
  ElectronRehearsalObservation,
} from "../src/computer/rehearsalElectronObservation.ts";
import {
  prepareRehearsalClaude,
  rehearsalClaudeBackendBootstrap,
} from "@t3tools/shared/computerRehearsalClaude";

// Run with Bun, like the native rehearsals. The launched Electron app loads its
// actual compiled main/preload/renderer/server. No execution or consent shortcut.
const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const output = arg("--output");
const fixtureBinDirectory = arg("--fixture-bin-dir");
const provider = arg("--provider") ?? "codex";
const driver = provider === "claude" ? "claudeAgent" : "codex";
const sourceHome = arg(provider === "claude" ? "--claude-home" : "--codex-home");
const binary = arg(provider === "claude" ? "--claude-binary" : "--codex-binary");
const approvalDiagnostic = args.includes("--approval-diagnostic");
const statusOnly = args.includes("--status-only") || approvalDiagnostic;
const controlsOnly = args.includes("--controls-only");
const actionsOnly = args.includes("--actions-only");
const stopMain = args.includes("--stop-main");
const stopRenderer = args.includes("--stop-renderer");
const stopBackend = args.includes("--stop-backend");
const backgroundFixture = args.includes("--background-fixture");
const stopOnly = stopMain || stopRenderer || stopBackend;
const diagnoseChord = args.includes("--diagnose-chord") && process.platform !== "win32";
const realApps = args.includes("--real-apps");
const clusterWorkflows = args.includes("--cluster-workflows");
const chromiumFixture = args.includes("--chromium-fixture");
const windowless = args.includes("--windows-closed");
const grantMemory = args.includes("--grant-memory");
const sessionActions = args.includes("--session-actions");
const profileIsolationReadOnly = args.includes("--profile-isolation-readonly");
const profileInspectionDiagnostic = args.includes("--profile-inspection-diagnostic");
const profileIsolation =
  args.includes("--profile-isolation") || profileIsolationReadOnly || profileInspectionDiagnostic;
const observeMcpTransport =
  provider === "codex" && (sessionActions || approvalDiagnostic || profileIsolation);
const runtimeMode = sessionActions || approvalDiagnostic ? "approval-required" : "full-access";
const includesRealApps = realApps || clusterWorkflows;
if (
  !["darwin", "win32"].includes(process.platform) ||
  (backgroundFixture && process.platform !== "win32") ||
  (process.platform === "win32" && (includesRealApps || windowless || !fixtureBinDirectory)) ||
  process.env.F5_COMPUTER_ELECTRON_REHEARSAL !== "1" ||
  !["claude", "codex"].includes(provider) ||
  !output ||
  !sourceHome ||
  !binary ||
  (profileIsolation && provider !== "codex") ||
  (diagnoseChord && !stopOnly) ||
  (approvalDiagnostic && args.includes("--status-only")) ||
  (chromiumFixture &&
    (!fixtureBinDirectory ||
      stopOnly ||
      statusOnly ||
      realApps ||
      clusterWorkflows ||
      controlsOnly ||
      actionsOnly)) ||
  ((windowless || grantMemory || sessionActions || profileIsolation) && chromiumFixture) ||
  [
    statusOnly,
    controlsOnly,
    actionsOnly,
    stopMain,
    stopRenderer,
    stopBackend,
    backgroundFixture,
    realApps,
    clusterWorkflows,
    windowless,
    grantMemory,
    sessionActions,
    profileIsolation,
  ].filter(Boolean).length > 1
) {
  process.stderr.write(
    "Human coordination and real quota required: F5_COMPUTER_ELECTRON_REHEARSAL=1 bun apps/desktop/scripts/rehearse-computer-electron.mjs [--provider codex|claude] --<provider>-home <selected profile home> --<provider>-binary <path> --output <new report.json>\n",
  );
  process.exit(1);
}
const desktopDir =
  process.env.F5_REHEARSAL_DESKTOP_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Playwright's Electron launcher requires Node's child-process/debugger behavior.
// Bundle TS workspace dependencies for Node, leaving the production app untouched.
if (process.versions.bun) {
  const bootstrap = await mkdtemp(join(tmpdir(), "f5-electron-rehearsal-runner-"));
  try {
    const entry = join(bootstrap, "runner.mjs");
    await promisify(execFile)(
      "bun",
      [
        "build",
        fileURLToPath(import.meta.url),
        "--target=node",
        "--format=esm",
        "--sourcemap=inline",
        `--outfile=${entry}`,
      ],
      { timeout: 30000 },
    );
    const child = spawn("node", ["--enable-source-maps", entry, ...args], {
      env: { ...process.env, F5_REHEARSAL_DESKTOP_ROOT: desktopDir },
      stdio: "inherit",
    });
    const stop = () => child.kill("SIGTERM");
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const code = await new Promise((done, reject) => {
      child.once("exit", done);
      child.once("error", reject);
    });
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.exitCode = code ?? 1;
  } finally {
    await rm(bootstrap, { recursive: true, force: true });
  }
  process.exit(process.exitCode ?? 0);
}
await writeFile(resolve(output), "", { flag: "wx" });
const repo = resolve(desktopDir, "../..");
const requireWeb = createRequire(join(repo, "apps/web/package.json"));
const requireDesktop = createRequire(join(desktopDir, "package.json"));
const { _electron } = requireWeb("playwright");
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "f5-computer-electron-"));
const state = join(root, "app", "userdata");
const home = join(state, "provider-homes", provider === "claude" ? "claude" : "codex");
const workspace = join(root, "workspace");
const threadId = randomUUID();
const projectId = randomUUID();
const appId = realApps
  ? REAL_APP_REHEARSAL_IDS[0]
  : chromiumFixture
    ? process.platform === "win32"
      ? join(root, "ChromiumFixture", "f5-chromium-fixture.exe").toLowerCase()
      : (await readChromiumFixture(fixtureBinDirectory)).appId
    : process.platform === "win32"
      ? join(root, "native-fixture", "ComputerControlFixture.exe").toLowerCase()
      : `org.example.computer-rehearsal.${randomUUID()}`;
const consentApps = clusterWorkflows
  ? [appId, ...REAL_APP_REHEARSAL_IDS]
  : realApps
    ? [...REAL_APP_REHEARSAL_IDS]
    : [appId];
let application;
let page;
let fixture;
let windowsFixtureObserver;
let externalClient;
let externalPaused = false;
let appWindowsClosed = false;
let windowlessConsent;
let windowlessObservation;
let windowlessStopObservation;
let providerTailObserved = false;
let providerActivityCounts;
let grantMemoryObservation;
const grantMemoryConsentReceipts = [];
let sessionActionsObservation;
let profileIsolationObservation;
let profileIsolationDiagnostics;
let profileIsolationPause;
let installRenderer;
const additionalFixtures = [];
const additionalClients = [];
let sessionActionsFailures;
let approvalModeVerifiedTurns = 0;
let approvalComposerInitiallySupervised;
let submittedRuntimeModes;
let externalSubmissions = 0;
let interrupted = false;
let stage = "preparation";
let failureStage;
let failureCode;
let failureLocation;
let permissionStatus;
let helperSha256;
let buildHashes;
let repositoryCommit;
let workingTreeDirty;
let nativeObservation;
const profileObservationLimit = profileIsolation ? 2 * PROFILE_OBSERVATION_REQUEST_LIMIT : 128;
const stdoutObservation = new ElectronRehearsalObservation(profileObservationLimit);
const stderrObservation = new ElectronRehearsalObservation(profileObservationLimit);
let threadObservation;
let consentObservation;
let providerErrorCodes;
let toolOutcomeErrors;
let thumbnailObservation;
let fixtureObservation;
let realAppObservation;
let realAppPrerequisites;
let calculatorBaselineObservation;
let claudeAuthentication;
let realAppVerifier;
let realAppProcessVerifier;
const realAppOwnedPids = {};
async function verifyRealAppProcesses(...args) {
  const result = await exec(realAppProcessVerifier, args, { timeout: 5000, maxBuffer: 4096 });
  return JSON.parse(result.stdout);
}
async function rememberRealAppProcess(appId) {
  const pids = (await verifyRealAppProcesses("--status"))[appId];
  if (!Array.isArray(pids) || pids.length !== 1 || !Number.isInteger(pids[0]) || pids[0] <= 0)
    throw new Error("Owned app process could not be confirmed.");
  realAppOwnedPids[appId] = pids[0];
}
let documentRoot;
let documentPath;
let documentOpened = false;
let documentClosed = false;
const expectedRealAppText = REAL_APP_REHEARSAL_TEXT;
async function verifyRealApp(...args) {
  const result = await exec(realAppVerifier, args, { timeout: 10000, maxBuffer: 4096 });
  return JSON.parse(result.stdout);
}
const stopTrace = new RehearsalStopObservation();
const chordTrace = diagnoseChord ? new RehearsalChordObservation(true) : undefined;
let stopMeasurement;
let frozenPid;
let windowsFreeze;
let restoreTimer;
const restoreProcess = async () => {
  if (restoreTimer) clearTimeout(restoreTimer);
  restoreTimer = undefined;
  if (frozenPid) {
    const pid = frozenPid;
    frozenPid = undefined;
    try {
      if (windowsFreeze) await windowsFreeze.resume();
      else process.kill(pid, "SIGCONT");
    } catch {
      /* Process may have exited. */
    }
  }
};
const checks = {};
const phaseEvidence = {};
const halt = () => {
  interrupted = true;
  void restoreProcess();
  if (page)
    void page
      .evaluate((id) => window.desktopBridge.computerAutomation.setPaused(id, true), threadId)
      .catch(() => {});
};
process.once("SIGINT", halt);
process.once("SIGTERM", halt);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitFor(condition, timeout = 60000, interval = 100) {
  const end = Date.now() + timeout;
  for (;;) {
    if (interrupted || Date.now() > end) throw new Error("Rehearsal interrupted or timed out.");
    if (await condition()) {
      if (interrupted) throw new Error("Rehearsal interrupted.");
      return;
    }
    await delay(interval);
  }
}
async function instructions(text) {
  process.stdout.write(`${text}\n`);
  await page.evaluate((value) => {
    let panel = document.getElementById("f5-computer-rehearsal-instructions");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "f5-computer-rehearsal-instructions";
      panel.style.cssText =
        "position:fixed;bottom:12px;right:12px;max-width:340px;padding:12px;background:#172554;color:white;border:2px solid #60a5fa;border-radius:8px;z-index:1000;font:14px system-ui;pointer-events:none";
      document.body.append(panel);
    }
    panel.textContent = value;
  }, text);
}
const rpc = (method, body = {}) =>
  externalClient
    ? externalClient.rpc(method, body)
    : page.evaluate(([name, input]) => window.__computerRehearsal.rpc(name, input), [method, body]);
const dispatch = (command) => {
  if (interrupted) throw new Error("Rehearsal interrupted.");
  return rpc(ORCHESTRATION_WS_METHODS.dispatchCommand, {
    command: { commandId: randomUUID(), createdAt: new Date().toISOString(), ...command },
  });
};
const observer = () => application.evaluate(() => globalThis.__computerRehearsalNative.snapshot());
let previousTurnId;
let composerSubmissions = 0;
async function waitTurn() {
  await waitFor(async () => {
    const paused = externalClient
      ? externalPaused
      : await page.evaluate(() => window.__computerRehearsal.paused);
    if (paused) throw new Error("Physical input interrupted the active turn.");
    const snapshot = await rpc(ORCHESTRATION_WS_METHODS.getSnapshot);
    const turn = snapshot.threads.find((thread) => thread.id === threadId)?.latestTurn;
    if (!turn || turn.turnId === previousTurnId) return false;
    if (turn?.state === "error" || turn?.state === "interrupted")
      throw new Error("Provider turn did not complete.");
    return turn?.state === "completed";
  }, 150000);
  await waitFor(async () => !(await observer()).held, 5000);
}
const modelSelection = {
  instanceId: driver,
  model: arg("--model") ?? (provider === "claude" ? "claude-fable-5-1" : "gpt-6.1-sol"),
  options: provider === "claude" ? [] : [{ id: "reasoningEffort", value: "low" }],
};
async function startTurn(text) {
  if (interrupted) throw new Error("Rehearsal interrupted.");
  const snapshot = await rpc(ORCHESTRATION_WS_METHODS.getSnapshot);
  if (sessionActions || approvalDiagnostic) {
    if (
      snapshot.threads.find((thread) => thread.id === threadId)?.runtimeMode !== "approval-required"
    )
      throw new Error("Session actions require approval mode.");
    approvalModeVerifiedTurns++;
  }
  previousTurnId = snapshot.threads.find((thread) => thread.id === threadId)?.latestTurn?.turnId;
  if (appWindowsClosed) {
    // Established-thread turns use the same queue admission as the composer.
    // Submit once; an uncertain reply must never cause an automatic resend.
    const submissionId = randomUUID();
    externalSubmissions++;
    const admission = await rpc(WS_METHODS.nextTurnQueueSubmit, {
      submissionId,
      intent: "auto",
      command: {
        type: "thread.turn.start",
        commandId: submissionId,
        createdAt: new Date().toISOString(),
        threadId,
        message: { messageId: randomUUID(), role: "user", text, attachments: [] },
        modelSelection,
        runtimeMode,
        interactionMode: "default",
      },
    });
    if (
      !Schema.is(TurnSubmissionResult)(admission) ||
      admission.submissionId !== submissionId ||
      !["started", "queued"].includes(admission.disposition)
    )
      throw new Error("Windowless queue admission incomplete.");
    return;
  }
  await page.getByTestId("composer-editor").fill(text);
  // A kill chord interrupts the turn and pauses the turn queue. "Send now"
  // submits the verification turn; it does not resume computer authorization.
  await page
    .getByRole("button", {
      name: stopOnly ? /^(Send message|Send now)$/ : "Send message",
      exact: true,
    })
    .click();
  composerSubmissions++;
}
async function reviewedTurn({ kind = "apps", allow, instructionsText, prompt }) {
  await page.evaluate(() => {
    Object.assign(window.__computerRehearsal, {
      consent: undefined,
      trustedConsent: false,
      trustedConsentVisible: false,
      consentSettled: false,
      consentAllowed: false,
    });
  });
  await instructions(instructionsText);
  await startTurn(prompt);
  await waitFor(
    async () => !!(await page.evaluate(() => window.__computerRehearsal.consent)),
    90000,
  );
  const requested = await page.evaluate(() => window.__computerRehearsal.consent);
  if (
    requested.kind !== kind ||
    requested.threadId !== threadId ||
    requested.apps.length !== (kind === "apps" ? 1 : 0) ||
    (kind === "apps" && requested.apps[0].appId !== appId)
  )
    throw new Error("Unexpected certification consent request.");
  // WebSocket delivery can precede React's popup replacement. Only observe
  // computer-consent popups; a global strict locator can reject unrelated or
  // overlapping exit-transition dialogs before the operator can review access.
  const visible = await page.evaluate(() =>
    [
      ...document.querySelectorAll('[role="dialog"]:has([data-testid="computer-access-card"])'),
    ].some((dialog) => dialog.checkVisibility()),
  );
  await waitFor(
    async () => (await page.evaluate(() => window.__computerRehearsal.consentSettled)) === true,
    90000,
  );
  const receipt = await page.evaluate(() => ({
    trustedReview: window.__computerRehearsal.trustedConsent === true,
    visibleAtReview: window.__computerRehearsal.trustedConsentVisible === true,
    settled: window.__computerRehearsal.consentSettled === true,
    allowed: window.__computerRehearsal.consentAllowed === true,
  }));
  if (receipt.allowed !== allow) throw new Error("Unexpected certification consent answer.");
  await waitTurn();
  return {
    ...receipt,
    kind,
    appCount: requested.apps.length,
    visible: visible || receipt.visibleAtReview,
  };
}
async function stopOwnedSession() {
  await dispatch({ type: "thread.session.stop", threadId });
  await waitFor(async () => {
    const snapshot = await rpc(ORCHESTRATION_WS_METHODS.getSnapshot);
    return (
      snapshot.threads.find((thread) => thread.id === threadId)?.session?.status === "stopped" &&
      !(await observer()).held
    );
  }, 15000);
}
try {
  repositoryCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  workingTreeDirty = Boolean(
    (await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout.trim(),
  );
  helperSha256 = createHash("sha256")
    .update(
      await readFile(
        join(
          desktopDir,
          `dist-native/${process.platform === "win32" ? "win" : "mac"}-${process.arch}/${process.platform === "win32" ? "f5-computer-helper.exe" : "f5-computer-helper"}`,
        ),
      ),
    )
    .digest("hex");
  buildHashes = Object.fromEntries(
    await Promise.all(
      [
        ["desktopMain", join(desktopDir, "dist-electron/main.js")],
        ["serverBundle", join(repo, "apps/server/dist/index.mjs")],
        ["rendererIndex", join(repo, "apps/web/dist/index.html")],
        ["rehearsalSource", join(desktopDir, "scripts/rehearse-computer-electron.mjs")],
        ["observerSource", join(desktopDir, "src/computer/rehearsalElectronObservation.ts")],
        ["transportObserverSource", join(desktopDir, "src/computer/rehearsalMcpTransport.ts")],
        ["responseSource", join(desktopDir, "src/computer/rehearsalResponses.ts")],
        ["externalClientSource", join(desktopDir, "src/computer/rehearsalExternalClient.ts")],
        ["grantMemorySource", join(repo, "scripts/computer-certification/grantMemory.ts")],
        ["sessionActionsSource", join(repo, "scripts/computer-certification/sessionActions.ts")],
        [
          "profileIsolationSource",
          join(desktopDir, "scripts/rehearse-computer-profile-isolation.mjs"),
        ],
        [
          "profileIsolationObserverSource",
          join(desktopDir, "src/computer/rehearsalProfileIsolation.ts"),
        ],
        ["profileLimitsSource", join(repo, "packages/shared/src/computerRehearsalProfiles.ts")],
        [
          "profileIsolationEvidenceSource",
          join(repo, "scripts/computer-certification/profileIsolationEvidence.ts"),
        ],
        [
          "windowlessEvidenceSource",
          join(repo, "scripts/computer-certification/windowlessEvidence.ts"),
        ],
        ["stopObserverSource", join(desktopDir, "src/computer/rehearsalStopObservation.ts")],
        ["stopMeasurementSource", join(desktopDir, "src/computer/stopLatencyMeasurement.ts")],
        [
          "stopFixtureSource",
          join(
            desktopDir,
            process.platform === "win32"
              ? "native/windows/fixture/src/stop.rs"
              : "native/macos/Fixtures/StopLatencyFixture.swift",
          ),
        ],
        ...(diagnoseChord
          ? [
              [
                "chordObservationSource",
                join(desktopDir, "src/computer/rehearsalChordObservation.ts"),
              ],
            ]
          : []),
        ...(provider === "claude"
          ? [["claudeLaunchSource", join(repo, "packages/shared/src/computerRehearsalClaude.ts")]]
          : []),
        ...(includesRealApps
          ? [
              [
                "realAppVerifierSource",
                join(desktopDir, "native/macos/Fixtures/RealAppVerifier.swift"),
              ],
              [
                "realAppObserverSource",
                join(desktopDir, "src/computer/rehearsalRealAppsObservation.ts"),
              ],
            ]
          : []),
      ].map(async ([name, path]) => [
        name,
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      ]),
    ),
  );
  await mkdir(home, { recursive: true, mode: 0o700 });
  let providerBinary = resolve(binary);
  if (provider === "claude") {
    stage = "claude-authentication-preflight";
    const prepared = await prepareRehearsalClaude({
      binary: resolve(binary),
      sourceHome: resolve(sourceHome),
      isolatedHome: home,
      root,
    });
    // Real F5 profiles require the bundled certified SDK, so do not configure
    // the standalone probe's custom launcher as the provider executable.
    providerBinary = "";
    claudeAuthentication = prepared.authentication;
    if (claudeAuthentication.status !== "authenticated")
      throw new Error("Fresh isolated Claude process cannot authenticate.");
  } else {
    await copyFile(join(resolve(sourceHome), "auth.json"), join(home, "auth.json"));
    await chmod(join(home, "auth.json"), 0o600);
    await writeFile(
      join(home, "config.toml"),
      'cli_auth_credentials_store = "file"\n[features]\nplugins = false\n',
      { mode: 0o600 },
    );
  }
  if (includesRealApps) {
    realAppVerifier = join(root, "real-app-verifier");
    realAppProcessVerifier = join(root, "real-app-process-verifier");
    await prepareRehearsalExecutable(
      join(desktopDir, "native/macos/Fixtures/ProtectionAppVerifier.swift"),
      realAppProcessVerifier,
      fixtureBinDirectory,
    );
    await prepareRehearsalExecutable(
      join(desktopDir, "native/macos/Fixtures/RealAppVerifier.swift"),
      realAppVerifier,
      fixtureBinDirectory,
    );
    const status = await verifyRealApp("--status");
    realAppPrerequisites = {
      textEditInitiallyClosed: status.textEditRunning === false,
      calculatorInitiallyClosed: status.calculatorRunning === false,
    };
    if (!Object.values(realAppPrerequisites).every(Boolean))
      throw new Error("Real-app rehearsal requires both apps closed before starting.");
  }
  await mkdir(workspace);
  await exec("git", ["-c", "init.templateDir=", "init", "--initial-branch=main", workspace]);
  await writeFile(
    join(state, "settings.json"),
    JSON.stringify({
      providers: Object.fromEntries(
        ["codex", "claudeAgent", "cursor", "opencode", "grok", "antigravity"].map((id) => [
          id,
          { enabled: id === driver },
        ]),
      ),
      providerInstances: {
        [driver]: {
          driver,
          enabled: true,
          config: { binaryPath: providerBinary, homePath: home },
        },
      },
      enableAgentComputerUse: true,
      computerUseBackend: "f5",
      computerUseExecutionMode: backgroundFixture ? "background" : "foreground",
      enableProviderUpdateChecks: false,
      prHub: { pollIntervalSeconds: 0, discoverNotifications: false },
    }),
    { mode: 0o600 },
  );
  if (!statusOnly && !realApps && !profileIsolationReadOnly)
    fixture = chromiumFixture
      ? await createRehearsalChromiumFixture({
          root,
          appId,
          preparedDirectory: fixtureBinDirectory,
        })
      : await createRehearsalFixture({
          root,
          appId,
          ...(fixtureBinDirectory ? { preparedDirectory: fixtureBinDirectory } : {}),
          expectedText: "F5_ELECTRON_REHEARSAL Ω🙂",
          observeChord: stopOnly,
          diagnoseChord,
          sourceFile: join(
            desktopDir,
            stopOnly
              ? "native/macos/Fixtures/StopLatencyFixture.swift"
              : "native/macos/Fixtures/ComputerControlFixture.swift",
          ),
        });
  if (stopOnly) {
    fixture.child.stdin.on("error", () => {
      stopTrace.evidence.overflow = true;
    });
    let buffer = "";
    fixture.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line === "FIXTURE_READY") continue;
        try {
          const event = JSON.parse(line);
          chordTrace?.receive(event);
          if (!chordTrace || event.kind !== "chordCandidate") stopTrace.fixture(event);
          if (chordTrace && (!chordTrace.monitorHealthy || chordTrace.invalid))
            stopTrace.evidence.overflow = true;
        } catch {
          stopTrace.evidence.overflow = true;
        }
      }
      if (buffer.length > 4096) {
        stopTrace.evidence.overflow = true;
        buffer = "";
      }
    });
  }
  // Reuse the tested correlator at the actual inherited IPC boundary. Instrumentation
  // only observes; it does not supply results, grants, permits or consent answers.
  const compiledObserver = join(root, "response-observer.cjs");
  await exec(
    "bun",
    [
      "build",
      join(desktopDir, "src/computer/rehearsalElectronObservation.ts"),
      "--target=node",
      "--format=cjs",
      `--outfile=${compiledObserver}`,
    ],
    { timeout: 30000 },
  );
  const compiledStopObserver = join(root, "stop-observer.cjs");
  const compiledIsolationObserver = join(root, "isolation-observer.cjs");
  if (profileIsolation)
    await exec(
      "bun",
      [
        "build",
        join(desktopDir, "src/computer/rehearsalProfileIsolation.ts"),
        "--target=node",
        "--format=cjs",
        `--outfile=${compiledIsolationObserver}`,
      ],
      { timeout: 30000 },
    );
  await exec(
    "bun",
    [
      "build",
      join(desktopDir, "src/computer/rehearsalStopObservation.ts"),
      "--target=node",
      "--format=cjs",
      `--outfile=${compiledStopObserver}`,
    ],
    { timeout: 30000 },
  );
  const compiledRealAppObserver = join(root, "real-app-observer.cjs");
  if (includesRealApps)
    await exec(
      "bun",
      [
        "build",
        join(desktopDir, "src/computer/rehearsalRealAppsObservation.ts"),
        "--target=node",
        "--format=cjs",
        `--outfile=${compiledRealAppObserver}`,
      ],
      { timeout: 30000 },
    );
  const wrapper = join(root, "launch.cjs");
  const claudeBackendLaunch = join(root, "claude-backend-launch.cjs");
  if (provider === "claude")
    await writeFile(
      claudeBackendLaunch,
      rehearsalClaudeBackendBootstrap(
        join(repo, "apps/server/dist/index.mjs"),
        join(root, "app"),
        join(resolve(sourceHome), ".claude"),
      ),
      { mode: 0o600, flag: "wx" },
    );
  const codexBackendLaunch = join(root, "codex-backend-launch.cjs");
  if (observeMcpTransport) {
    const transportObserver = join(root, "mcp-transport-observer.cjs");
    await exec(
      "bun",
      [
        "build",
        join(desktopDir, "src/computer/rehearsalMcpTransport.ts"),
        "--target=node",
        "--format=cjs",
        `--outfile=${transportObserver}`,
      ],
      { timeout: 30000 },
    );
    await writeFile(
      codexBackendLaunch,
      rehearsalMcpBackendBootstrap(join(repo, "apps/server/dist/index.mjs"), transportObserver),
      { mode: 0o600, flag: "wx" },
    );
  }
  await writeFile(
    wrapper,
    `
const {app,BrowserWindow}=require('electron');
const setPath=app.setPath.bind(app);
app.setPath=(key,value)=>setPath(key,key==='userData'?${JSON.stringify(join(root, "electron"))}:value);
const {ElectronRehearsalObservation}=require(${JSON.stringify(compiledObserver)});
const evidence=globalThis.__computerRehearsalNative=new ElectronRehearsalObservation(${profileIsolation ? profileObservationLimit : ""});
${
  profileIsolation
    ? `const {RehearsalProfileIsolation,profileSnapshotEnvelope}=require(${JSON.stringify(compiledIsolationObserver)});
globalThis.__computerRehearsalIsolation=new RehearsalProfileIsolation();
globalThis.__computerRehearsalIsolationSnapshot=()=>profileSnapshotEnvelope(()=>globalThis.__computerRehearsalIsolation.snapshot());
globalThis.__computerRehearsalIsolationBackendPids={};`
    : ""
}
globalThis.__computerRehearsalChildPids=new Set();
globalThis.__computerRehearsalBackendPids={};
const {RehearsalStopObservation}=require(${JSON.stringify(compiledStopObserver)});
const stopEvidence=globalThis.__computerRehearsalStop=new RehearsalStopObservation();
${
  includesRealApps
    ? `const {RehearsalRealAppsObservation}=require(${JSON.stringify(compiledRealAppObserver)});
let realEvidence=globalThis.__computerRehearsalRealApps=new RehearsalRealAppsObservation(${JSON.stringify(threadId)});
globalThis.__computerRehearsalResetRealApps=()=>{realEvidence=globalThis.__computerRehearsalRealApps=new RehearsalRealAppsObservation(${JSON.stringify(threadId)});};`
    : ""
}
${
  windowless
    ? `const windowless=globalThis.__computerRehearsalWindowless={active:false,reopened:false,inputWithWindow:false,mutationAdmissions:0};
const mutationOps=new Set(['click','move','drag','scroll','type','key','elementAction','openApp','activateApp']);
const appWindows=globalThis.__computerRehearsalAppWindows=()=>BrowserWindow.getAllWindows().filter(win=>win.isFocusable()||win.webContents.getURL().startsWith('t3:'));
app.on('browser-window-created',(_event,win)=>{
if(windowless.active&&win.isFocusable())windowless.reopened=true;
win.webContents.on('did-finish-load',()=>{if(windowless.active&&!win.isDestroyed()&&win.webContents.getURL().startsWith('t3:'))windowless.reopened=true;});});`
    : ""
}
const observe=m=>{evidence.receive(m);${includesRealApps ? "realEvidence.receive(m);" : ""}
${
  windowless
    ? `if(windowless.active&&m.type==='request'&&mutationOps.has(m.request?.op)){
windowless.mutationAdmissions++;windowless.inputWithWindow||=appWindows().length>0;}`
    : ""
}};
const cp=require('node:child_process'),spawn=cp.spawn;
cp.spawn=function(...args){
${
  provider === "claude" || observeMcpTransport
    ? `if(args[2]?.env?.F5_DESKTOP_COMPUTER_HOST==='ipc'&&Array.isArray(args[1])&&typeof args[1][0]==='string'){
if(args[1][0]!==${JSON.stringify(join(repo, "apps/server/dist/index.mjs"))})throw new Error('Unexpected rehearsal backend entry');
args[1]=[${JSON.stringify(provider === "claude" ? claudeBackendLaunch : codexBackendLaunch)},...args[1].slice(1)];}
`
    : ""
}
const child=spawn.apply(this,args);
if(child.pid){globalThis.__computerRehearsalChildPids.add(child.pid);
child.once('exit',()=>globalThis.__computerRehearsalChildPids.delete(child.pid));}
if(args[2]?.env?.F5_DESKTOP_COMPUTER_HOST==='ipc'){
child.on('message',m=>{if(m.type==='hello')globalThis.__computerRehearsalBackendPids[m.profileId]=child.pid;});
let isolatedProfile;
child.on('message',m=>{${
      profileIsolation
        ? `if(m.type==='hello'){isolatedProfile=m.profileId;globalThis.__computerRehearsalIsolationBackendPids[isolatedProfile]=child.pid;}
if(isolatedProfile)globalThis.__computerRehearsalIsolation.receive(isolatedProfile,m,'backend');`
        : ""
    }observe(m);});
const send=child.send.bind(child);child.send=function(m,...args){observe(m);
${profileIsolation ? `if(isolatedProfile)globalThis.__computerRehearsalIsolation.receive(isolatedProfile,m,'main');` : ""}
return send(m,...args);};}
if(args[0]===${JSON.stringify(join(desktopDir, `dist-native/${process.platform === "win32" ? "win" : "mac"}-${process.arch}/${process.platform === "win32" ? "f5-computer-helper.exe" : "f5-computer-helper"}`))}){
let buffer='';child.stdout.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\\n'))>=0){
const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{stopEvidence.helper(JSON.parse(line));}catch{}}
if(buffer.length>12*1024*1024)buffer='';});}return child;};
require(${JSON.stringify(join(desktopDir, "dist-electron/main.js"))});
`,
  );
  stage = "electron-launch";
  application = await _electron.launch({
    executablePath: requireDesktop("electron"),
    args: [wrapper],
    cwd: root,
    env: {
      ...(process.platform === "win32"
        ? Object.fromEntries(
            [
              "SystemRoot",
              "WINDIR",
              "COMSPEC",
              "TEMP",
              "TMP",
              "USERPROFILE",
              "LOCALAPPDATA",
              "APPDATA",
              "PATHEXT",
              "ProgramFiles",
              "ProgramFiles(x86)",
              "ProgramData",
            ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
          )
        : {}),
      HOME: process.env.HOME,
      USER: process.env.USER,
      PATH: process.env.PATH,
      F5_HOME: join(root, "app"),
      F5_COMPUTER_CONTROL_DEV: "1",
      ...(backgroundFixture ? { F5_COMPUTER_BACKGROUND_DEV: "1" } : {}),
    },
    timeout: 60000,
  });
  // Unpackaged backend stdio is inherited, so observe Electron's output pipes.
  // Keep the two streams separate; only enums survive into the final report.
  application
    .process()
    .stdout?.on("data", (chunk) => stdoutObservation.backendLog(chunk.toString()));
  application
    .process()
    .stderr?.on("data", (chunk) => stderrObservation.backendLog(chunk.toString()));
  page = await application.firstWindow({ timeout: 60000 });
  await page
    .getByRole("button", { name: "Add your first project", exact: true })
    .waitFor({ timeout: 60000 });
  stage = "computer-prerequisites";
  await waitFor(async () => {
    permissionStatus = await page.evaluate(() => window.desktopBridge.computerAutomation.status());
    if (
      !permissionStatus.available &&
      !["helper-missing", "monitor-unhealthy"].includes(permissionStatus.reason)
    )
      throw new Error("Computer prerequisites unavailable.");
    return permissionStatus.available;
  }, 10000);
  checks.realElectronPermissionsAvailable = true;
  stage = "renderer-transport";
  installRenderer = (targetPage, expectedApps, targetThread) =>
    targetPage.evaluate(
      async ([protocol, expectedAppIds, rehearsalThreadId]) => {
        const state = (window.__computerRehearsal = {
          paused: false,
          consent: undefined,
          trustedConsent: false,
          trustedConsentVisible: false,
          trustedPause: false,
          trustedResume: false,
          activitySeen: false,
          thumbnailSeen: false,
          toolOutcomeErrors: [],
          toolFailures: [],
          toolFailuresOverflow: false,
          submittedRuntimeModes: [],
          leaseSeen: false,
          consentSettled: false,
          consentAllowed: false,
          fixtureGranted: false,
        });
        const originalSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data) {
          // Observe the composer's actual command, not just the configured thread.
          // Do not alter messages or retain message text, IDs or tool parameters.
          if (typeof data === "string") {
            try {
              const command = JSON.parse(data)?.body?.command;
              if (
                command?.type === "thread.turn.start" &&
                command.threadId === rehearsalThreadId &&
                state.submittedRuntimeModes.length < 16
              )
                state.submittedRuntimeModes.push(
                  ["approval-required", "full-access", "auto", "auto-accept-edits"].includes(
                    command.runtimeMode,
                  )
                    ? command.runtimeMode
                    : "unknown",
                );
            } catch {
              /* Non-JSON messages are simply forwarded. */
            }
          }
          return originalSend.call(this, data);
        };
        const url = new URL(window.desktopBridge.getWsUrl());
        url.searchParams.set("protocol", String(protocol));
        const socket = new WebSocket(url);
        const pending = new Map();
        state.rpc = (method, body = {}) =>
          new Promise((resolve, reject) => {
            const id = crypto.randomUUID();
            const timer = setTimeout(() => {
              pending.delete(id);
              reject(new Error("RPC timed out"));
            }, 15000);
            pending.set(id, { resolve, reject, timer });
            socket.send(JSON.stringify({ id, body: { _tag: method, ...body } }));
          });
        socket.onmessage = (event) => {
          const message = JSON.parse(event.data);
          if (message.id) {
            const item = pending.get(message.id);
            if (item) {
              clearTimeout(item.timer);
              pending.delete(message.id);
              if (message.error) item.reject(new Error("RPC rejected"));
              else item.resolve(message.result);
            }
            return;
          }
          if (message.channel === "computer.access.requested") state.consent = message.data;
          if (
            message.channel === "computer.access.settled" &&
            message.data.requestId === state.consent?.requestId
          ) {
            state.consentSettled = true;
            state.consentAllowed = message.data.allowed === true;
          }
          if (
            message.channel === "computer.access.grantsChanged" &&
            message.data.threadId === rehearsalThreadId
          )
            state.fixtureGranted = expectedAppIds.every((appId) =>
              message.data.grants.some((grant) => grant.appId === appId),
            );
          if (message.channel === "preview.automation.pauseChanged")
            state.paused = message.data.paused;
          if (message.channel === "agent.computerUseChanged" && message.data.threadId)
            state.leaseSeen = true;
          if (message.channel === "computer.activity") {
            state.activitySeen = true;
            if (typeof message.data.outcome === "string" && state.toolOutcomeErrors.length < 128)
              state.toolOutcomeErrors.push(message.data.outcome.slice(0, 64));
            if (message.data.status === "failed") {
              if (state.toolFailures.length >= 128) state.toolFailuresOverflow = true;
              else state.toolFailures.push({ op: message.data.op, outcome: message.data.outcome });
            }
            state.thumbnailSeen ||=
              typeof message.data.thumbnailDataUrl === "string" &&
              message.data.thumbnailDataUrl.startsWith("data:image/jpeg;base64,") &&
              message.data.thumbnailDataUrl.length <= 40960;
          }
        };
        document.addEventListener(
          "click",
          (event) => {
            if (!event.isTrusted || !(event.target instanceof Element)) return;
            const button = event.target.closest("button");
            const name = button?.textContent?.trim();
            if (
              name === "Review access" &&
              button?.closest('[data-testid="computer-access-card"]')
            ) {
              state.trustedConsent = true;
              state.trustedConsentVisible = button.checkVisibility();
            }
            if (name === "Pause") state.trustedPause = true;
            if (name === "Resume") state.trustedResume = true;
          },
          true,
        );
        await new Promise((resolve, reject) => {
          socket.onopen = resolve;
          socket.onerror = () => reject(new Error("Connection failed"));
        });
      },
      [F5_PROTOCOL_VERSION, expectedApps, targetThread],
    );
  await installRenderer(page, consentApps, threadId);
  await dispatch({
    type: "project.create",
    projectId,
    title: "Computer rehearsal only",
    workspaceRoot: workspace,
    defaultModelSelection: modelSelection,
  });
  await dispatch({
    type: "thread.create",
    threadId,
    projectId,
    title: "F5 computer UI rehearsal",
    model: modelSelection.model,
    modelSelection,
    runtimeMode,
    interactionMode:
      (statusOnly && !approvalDiagnostic) || profileInspectionDiagnostic ? "plan" : "default",
    branch: null,
    worktreePath: null,
  });
  await page.evaluate((id) => {
    window.location.hash = `/${id}`;
  }, threadId);
  if (sessionActions || approvalDiagnostic) {
    // Creating a server thread does not set the local composer's draft override.
    // Choose the authorized, narrower mode through the ordinary UI before send.
    stage = "approval-mode-composer-setup";
    const picker = page.locator('[data-composer-control="runtimeMode"]');
    await picker.waitFor({ state: "visible", timeout: 15000 });
    approvalComposerInitiallySupervised =
      (await picker.getAttribute("title"))?.startsWith("Supervised") === true;
    if (!approvalComposerInitiallySupervised) {
      await picker.click();
      await page.getByRole("menuitemradio", { name: /^Supervised/ }).click();
    }
    await waitFor(
      async () => (await picker.getAttribute("title"))?.startsWith("Supervised") === true,
      5000,
    );
  }
  if (profileIsolation) {
    profileIsolationObservation = await runProfileIsolation({
      application,
      page,
      fixture,
      root,
      state,
      home,
      sourceHome: resolve(sourceHome),
      threadId,
      appId,
      projectId,
      modelSelection,
      installRenderer,
      rpc,
      waitFor,
      delay,
      stage: (value) => {
        stage = value;
      },
      instructions: async (text, target = page) => {
        if (target === page) await instructions(text);
        else
          await target.evaluate((value) => {
            let panel = document.getElementById("f5-isolation-instructions");
            if (!panel) {
              panel = document.createElement("div");
              panel.id = "f5-isolation-instructions";
              panel.style.cssText =
                "position:fixed;bottom:12px;right:12px;max-width:340px;padding:12px;background:#172554;color:white;z-index:1000;pointer-events:none";
              document.body.append(panel);
            }
            panel.textContent = value;
          }, text);
      },
      readinessOnly: profileIsolationReadOnly,
      inspectionDiagnostic: profileInspectionDiagnostic,
      record: (value) => {
        profileIsolationObservation = value;
      },
      registerDiagnostics: (value) => {
        profileIsolationDiagnostics = value;
      },
      registerPause: (value) => {
        profileIsolationPause = value;
      },
      ownFixture: (value) => {
        additionalFixtures.push(value);
        return value;
      },
      ownClient: (value) => {
        additionalClients.push(value);
        return value;
      },
      helper: join(
        desktopDir,
        `dist-native/${process.platform === "win32" ? "win" : "mac"}-${process.arch}/${process.platform === "win32" ? "f5-computer-helper.exe" : "f5-computer-helper"}`,
      ),
      fixtureBinDirectory,
    });
    stage = "finished";
  } else if (sessionActions) {
    sessionActionsObservation = await runSessionActions({
      appId,
      projectId,
      threadId,
      checks,
      rpc,
      observer,
      stage: (name) => {
        stage = name;
      },
      presses: () => fixture.presses(),
      failures: () =>
        page.evaluate(() => {
          const state = window.__computerRehearsal;
          if (state.toolFailuresOverflow) throw new Error("Incomplete activity trace.");
          return state.toolFailures;
        }),
      review: async (kind, allow) =>
        reviewedTurn({
          kind,
          allow,
          instructionsText:
            (provider === "codex"
              ? `FIRST: If Codex asks tool approval, allow only ${kind === "apps" ? "computer_request_access" : "computer_activate_app"}. This only lets the call reach F5; app and session consent remain separate. THEN follow the F5 Computer access dialog instructions below. `
              : "") +
            (kind === "apps"
              ? "READY: Review access and allow only Computer Control Test Fixture. Leave Always allow off. No app input in this turn."
              : allow
                ? "RED: Review access and Allow this session to control separately approved apps. After Allow, stay idle: the agent will activate only the synthetic fixture and capture it once."
                : "READY: In F5's separate native Computer access dialog, Deny this session's actions. The agent must receive NotGranted without activating any app."),
          prompt:
            kind === "apps"
              ? `Approval-mode consent test for exact app ${appId}. Call computer_status once and computer_request_access exactly once for only this exact app ID, reason Synthetic session approval test. Do not activate, inspect, capture or send input. No shell, files, network or other apps. Stop on any failure, never retry. Finish READY.`
              : `Approval-mode session test for already granted exact app ${appId}. Call computer_activate_app exactly once for this app ID with screenshot:true. F5 will ask for genuine session-actions approval; the user will ${allow ? "allow" : "deny"}. ${allow ? "After success finish READY." : "Expect NotGranted after denial; report that tag and finish READY. Do not retry or substitute another tool after the denial."} No other action, screenshot tool, shell, files, network or other apps. Stop on any other error.`,
        }),
      pressTurn: async () => {
        await instructions(
          "READY: Session approval should survive into this next turn. Stay idle during the countdown.",
        );
        for (const seconds of [3, 2, 1]) {
          await instructions(`Countdown ${seconds}: keep mouse and keyboard idle.`);
          await delay(1000);
        }
        await instructions(
          "RED: One semantic button press in the fixture. No additional F5 session-actions dialog should appear." +
            (provider === "codex"
              ? " If Codex asks approval for computer_element_action, allow only that named tool call, then stay idle."
              : ""),
        );
        await startTurn(
          `Continue in the same approved session using only exact app ${appId}. Call computer_inspect once on this exact app ID, then use its snapshot and element reference to press Rehearsal press exactly once with computer_element_action, action press, screenshot:false. No other input, typing, activation, shell, files, network or apps. Do not request access again. Stop immediately on any failure or ambiguity; never retry. Finish READY.`,
        );
        await waitTurn();
      },
      stopSession: stopOwnedSession,
    });
    sessionActionsFailures = await page.evaluate(() => window.__computerRehearsal.toolFailures);
    checks.sessionActionsApprovalModeVerified =
      composerSubmissions === 4 && approvalModeVerifiedTurns === 4;
    stage = "finished";
    await instructions(
      "FINISHED: The provider session is stopped. Click Finish check in the synthetic fixture; it stays available until you acknowledge it. You can use your computer.",
    );
    fixture.child.stdin.write("WINDOWLESS_FINISHED\n");
    await waitFor(() => fixture.acknowledged(), 90000);
    checks.sessionActionsFinishAcknowledged = true;
  } else if (grantMemory) {
    grantMemoryObservation = await runGrantMemory({
      appId,
      projectId,
      threadId,
      checks,
      rpc,
      observer,
      waitFor,
      stage: (name) => {
        stage = name;
      },
      review: async ({ allow, remember, repeat }) => {
        const receipt = await reviewedTurn({
          allow,
          instructionsText: allow
            ? "Click Review access. In the native dialog for only Computer Control Test Fixture, check Always allow in this project and allow control. This phase sends no app input."
            : "Click Review access. Deny only Computer Control Test Fixture in the native dialog. This phase sends no app input.",
          prompt: `Consent-only test for exact app ID ${appId}. Call computer_status once and computer_request_access for only this exact app with reason Synthetic grant memory test. ${repeat === 2 ? "The user will deny this request. After that normal denial result, call computer_request_access once more for the same exact app in this turn to verify no second prompt appears. Do not retry any failed or interrupted tool." : "Call request access exactly once; the user will answer the genuine F5 dialog."} Do not activate, launch, inspect, capture or send input. Do not use shell, files, network or other apps. Finish READY.`,
        });
        grantMemoryConsentReceipts.push({
          ...receipt,
          appCount: 1,
          visible: receipt.visible,
          rememberRequested: remember,
        });
        return receipt.visible && receipt.settled && receipt.trustedReview;
      },
      rememberedTurn: async () => {
        await instructions(
          "Remembered-access restart. No new consent dialog should appear; no app input is requested.",
        );
        await startTurn(
          `Read-only grant memory test for exact app ${appId}. Call computer_status once and computer_request_access once for only this exact app, which was genuinely remembered in this project. It should already be granted. Do not activate, launch, inspect, capture or send input. No shell, files, network or other apps. Stop on any interruption or failed tool; never retry. Finish READY.`,
        );
        await waitTurn();
      },
      stopSession: stopOwnedSession,
    });
    checks.grantMemoryFourTurns = composerSubmissions === 4;
    stage = "finished";
    await instructions(
      "Grant memory check finished. Denial, remembering, revocation, forgetting and session cleanup were observed. You can use your computer.",
    );
  } else if (statusOnly) {
    stage = "read-only-status-turns";
    await instructions(
      "Read-only diagnostics: the provider will check computer status and list app metadata. No consent, screenshots or input are requested.",
    );
    for (let index = 0; index < 3; index++) {
      await startTurn(
        "Read-only F5 computer diagnostic. You may use tool discovery to locate F5's computer tools. Call computer_status once and computer_list_apps once. Report availability or a tagged error without app names. Do not request access, capture screenshots, use input, run commands, read files, or use tools beyond discovery and these two F5 tools.",
      );
      await waitTurn();
    }
    checks.readOnlyTurnsCompleted = composerSubmissions === 3;
    checks.noComputerLeaseAcquired = !(await observer()).leaseObserved;
    checks.threeCorrelatedMetadataResponses =
      (await observer()).operations.filter(
        (entry) => entry.op === "listApps" && entry.outcome === "ok" && entry.validApps === true,
      ).length === 3;
    if (approvalDiagnostic)
      checks.approvalDiagnosticSameSession = (await observer()).sessionGenerationsObserved === 1;
    stage = "finished";
  } else {
    stage = "human-consent-and-first-turn";
    await instructions(
      clusterWorkflows
        ? "Click Review access, then approve only Computer Control Test Fixture, TextEdit and Calculator. Leave remembering off. Follow Pause/Resume instructions, then stay idle for the real-app phase."
        : realApps
          ? "Click Review access, then approve only TextEdit and Calculator in the native F5 dialog. Leave remembering off. Keep input idle until the check finishes."
          : "Click Review access when the Computer access card appears, then approve only Computer Control Test Fixture in the native F5 dialog. Leave remembering off. Then keep mouse and keyboard idle until prompted.",
    );
    let overlayTimer;
    let overlayPoll = Promise.resolve();
    let overlayBusy = false;
    const overlay = {
      observed: false,
      protectedOptions: false,
      semanticOutline: false,
      coordinateCursor: false,
    };
    overlayTimer = setInterval(() => {
      if (overlayBusy) return;
      overlayBusy = true;
      overlayPoll = (async () => {
        const sample = await application.evaluate(async ({ BrowserWindow, screen }) => {
          const windows = BrowserWindow.getAllWindows().filter((w) =>
            w.webContents.getURL().startsWith("data:text/html"),
          );
          let outline = false,
            point = false;
          for (const w of windows)
            if (w.isVisible()) {
              const value = await Promise.race([
                w.webContents
                  .executeJavaScript(
                    "({outline:!!document.getElementById('outline') && !document.getElementById('outline').hidden,point:document.getElementById('point')?.style.display==='block'})",
                  )
                  .catch(() => ({})),
                new Promise((done) => setTimeout(() => done({}), 200)),
              ]);
              outline ||= value.outline === true;
              point ||= value.point === true;
            }
          return {
            observed: windows.some((w) => w.isVisible()),
            protectedOptions:
              windows.length === screen.getAllDisplays().length &&
              windows.every(
                (w) =>
                  !w.isFocusable() &&
                  w.isAlwaysOnTop() &&
                  w.webContents.getLastWebPreferences().sandbox &&
                  w.webContents.getLastWebPreferences().contextIsolation &&
                  !w.webContents.getLastWebPreferences().nodeIntegration,
              ),
            outline,
            point,
          };
        });
        overlay.observed ||= sample.observed;
        overlay.protectedOptions ||= sample.protectedOptions;
        overlay.semanticOutline ||= sample.outline;
        overlay.coordinateCursor ||= sample.point;
        if (await page.getByTestId("computer-use-banner").isVisible())
          checks.realLeaseBannerVisible = true;
      })()
        .catch(() => {})
        .finally(() => {
          overlayBusy = false;
        });
    }, 100);
    try {
      await startTurn(
        includesRealApps
          ? `Explicitly authorized real-app check. This turn is consent only. Use only F5 computer tools: computer_status, then computer_request_access for exactly ${JSON.stringify(consentApps)} with reason Temporary TextEdit document and Calculator test. Do not launch, activate, capture or send input yet. Finish READY once both apps are allowed. Never use shell, files, network or other apps. Stop on any interruption or failure. The user will answer F5 consent manually.`
          : `Explicitly authorized isolated F5 UI rehearsal. Use only F5 computer tools, only app ID ${appId}. This turn is for consent only: call computer_status, request access for that exact ID with reason Synthetic Electron UI rehearsal, then finish READY once access is allowed. Do not activate apps or execute input in this turn. Never use shell, files, network, any other app or the secure field. Stop immediately on any interruption, ambiguity or failure. The user will answer F5 consent manually.`,
      );
      await waitFor(async () => {
        if (await page.evaluate(() => window.__computerRehearsal.consent)) return true;
        const snapshot = await rpc(ORCHESTRATION_WS_METHODS.getSnapshot);
        const turn = snapshot.threads.find((thread) => thread.id === threadId)?.latestTurn;
        if (turn?.state === "error" || turn?.state === "interrupted")
          throw new Error("Provider turn failed before requesting consent.");
        return false;
      }, 90000);
      const requested = await page.evaluate(() => window.__computerRehearsal.consent);
      if (
        requested.kind !== "apps" ||
        requested.apps.length !== consentApps.length ||
        !consentApps.every((id) => requested.apps.some((app) => app.appId === id))
      )
        throw new Error("Unexpected access request.");
      checks.realConsentDialogVisible = await page.getByRole("dialog").isVisible();
      stage = "human-app-consent";
      await waitFor(async () => {
        const state = await page.evaluate(() => ({
          settled: window.__computerRehearsal.consentSettled,
          allowed: window.__computerRehearsal.consentAllowed,
          errorVisible: !!document.querySelector(
            '[data-testid="computer-access-card"] [role="alert"]',
          ),
        }));
        if (state.errorVisible || (state.settled && !state.allowed))
          throw new Error("Consent was rejected.");
        return state.settled && state.allowed;
      }, 90000);
      checks.realConsentSettledAllowed = true;
      stage = "consent-turn-completion";
      await waitTurn();
      checks.humanTrustedConsent = await page.evaluate(
        () => window.__computerRehearsal.trustedConsent,
      );
      checks.consentTurnEmittedNoInput =
        (!fixture || (fixture.presses() === 0 && !fixture.typed())) &&
        !(await observer()).leaseObserved;
      if (!checks.humanTrustedConsent || !checks.consentTurnEmittedNoInput)
        throw new Error("Consent-only turn evidence incomplete.");
      await instructions(
        realApps
          ? "Access confirmed. Keep input idle while the temporary TextEdit document and Calculator are tested."
          : "Access confirmed. Keep mouse and keyboard idle; the agent will now use only the fixture.",
      );
      await delay(2000);
      async function runRealAppPhase() {
        const captureBaseline = (await observer()).captureResponses;
        stage = "real-app-document-setup";
        const status = await verifyRealApp("--status");
        if (status.textEditRunning !== false || status.calculatorRunning !== false)
          throw new Error("An app was opened during consent; no test input will run.");
        documentRoot = await mkdtemp(join(tmpdir(), "f5-real-app-document-"));
        documentPath = join(documentRoot, "F5_REAL_APP_TEST.txt");
        await writeFile(documentPath, "F5_REAL_APP_INITIAL Ω🙂", { flag: "wx", mode: 0o600 });
        // Setup opens only this owned file, after real app consent and before a
        // provider lease. All edit/save/close/calculator actions use F5 tools.
        documentOpened = true;
        await exec("/usr/bin/open", ["-b", REAL_APP_REHEARSAL_IDS[0], documentPath], {
          timeout: 10000,
        });
        await waitFor(
          async () =>
            (await verifyRealApp("--verify-document", documentPath)).ownedDocumentFocused === true,
          10000,
        );
        checks.ownedTextEditDocumentFocusedBeforeInput = true;
        await rememberRealAppProcess(REAL_APP_REHEARSAL_IDS[0]);
        stage = "real-app-textedit-turn";
        await startTurn(
          `Use only F5 computer tools for com.apple.TextEdit and the single already-open document F5_REAL_APP_TEST.txt, seeded with F5_REAL_APP_INITIAL Ω🙂. Activate TextEdit with screenshot:true, take a fresh screenshot, inspect com.apple.TextEdit. Confirm this exact test document and seed text before editing; stop if any dialog or different document is focused. Focus its text area using a semantic action if offered. Send CMD+A, then computer_type exactly ${expectedRealAppText}, then CMD+S to save this existing test file (not Save As). Do not close yet. Finish READY. Never use shell, filesystem, network, another document or other apps. Stop on interruption, ambiguity, OutcomeUnknown or any failed action; never retry.`,
        );
        await waitTurn();
        checks.savedTestDocumentMatchesExpectedText =
          (await readFile(documentPath, "utf8")) === expectedRealAppText;
        if (!checks.savedTestDocumentMatchesExpectedText)
          throw new Error("Saved test content mismatch.");
        if ((await verifyRealApp("--verify-document", documentPath)).ownedDocumentFocused !== true)
          throw new Error("Test document lost focus before closing.");
        stage = "real-app-close-and-calculator-launch";
        await startTurn(
          `Use only F5 computer tools. Activate com.apple.TextEdit, inspect and confirm only F5_REAL_APP_TEST.txt remains focused. Close that saved test document using a semantic press on its Close button if offered; otherwise use CMD+W once. Request screenshot:false for the closing action. Do not quit apps or touch another document. Then computer_open_app for exact app com.apple.calculator with screenshot:true; take a fresh screenshot and inspect Calculator. Press its offered semantic Clear/All Clear button once to establish a zero baseline, and inspect again to confirm zero. Do not calculate yet or use keyboard/coordinate fallback in Calculator. Finish READY. Never use shell, filesystem, network or other apps. Stop on any interruption, ambiguity or failed action; never retry.`,
        );
        await waitTurn();
        documentClosed =
          (await verifyRealApp("--document-state", documentPath)).documentState === "closed";
        checks.ownedTestDocumentClosed = documentClosed;
        if (!documentClosed) throw new Error("Test document closure could not be confirmed.");
        await rememberRealAppProcess(REAL_APP_REHEARSAL_IDS[1]);
        const zeroBaseline = await verifyRealApp("--verify-calculator", "0");
        const beforeCalculation = await verifyRealApp("--verify-calculator", "42");
        calculatorBaselineObservation = {
          zeroAccessible: zeroBaseline.accessible === true,
          zeroVisible: zeroBaseline.expectedResultVisible === true,
          resultAccessible: beforeCalculation.accessible === true,
          resultAlreadyVisible: beforeCalculation.expectedResultVisible === true,
        };
        checks.calculatorResultInitiallyDifferent =
          zeroBaseline.accessible === true &&
          zeroBaseline.expectedResultVisible === true &&
          beforeCalculation.accessible === true &&
          beforeCalculation.expectedResultVisible === false;
        if (!checks.calculatorResultInitiallyDifferent)
          throw new Error("Calculator baseline is not distinguishable.");
        stage = "real-app-calculator-turn";
        await startTurn(
          `Use only F5 computer tools for exact app com.apple.calculator. Activate it with screenshot:true, take a NEW screenshot and inspect. Use computer_element_action press on the Calculator buttons to clear the display and calculate exactly 12 + 30 = 42. Use only offered semantic press actions, inspecting again when needed for fresh element references. Do not use coordinate clicks or keyboard fallback. Inspect the resulting display, then finish READY. Never use shell, files, network or other apps. Stop on interruption, ambiguity, OutcomeUnknown or any failed action; do not retry.`,
        );
        await waitTurn();
        const result = await verifyRealApp("--verify-calculator", "42");
        checks.calculatorResultVerifiedIndependently =
          result.accessible === true && result.expectedResultVisible === true;
        realAppObservation = await application.evaluate(() =>
          globalThis.__computerRehearsalRealApps.snapshot(),
        );
        checks.realAppNativeResponsesCorrelated =
          realAppObservation.traceComplete &&
          realAppObservation.failedMutations === 0 &&
          realAppObservation.ambiguousMutations === 0 &&
          realAppObservation.typingRequests === 1 &&
          !realAppObservation.unexpectedAppInput &&
          realAppObservation.textEditInspected &&
          realAppObservation.textEditTyping &&
          realAppObservation.textEditKeys >= 2 &&
          realAppObservation.expectedTextTyping &&
          realAppObservation.selectAllKeySucceeded &&
          realAppObservation.saveKeySucceeded &&
          realAppObservation.calculatorOpened &&
          realAppObservation.calculatorInspected &&
          realAppObservation.calculatorPresses >= 7;
        const after = await observer();
        checks.realAppCapturesReceived = after.captureResponses - captureBaseline >= 3;
        checks.realAppTurnLeaseReleased = after.leaseObserved && !after.held;
        checks.realAppComposerSubmittedFourTurns =
          composerSubmissions === (clusterWorkflows ? 6 : 4);
        checks.realAppGrantsSurvivedTurns = await page.evaluate(
          () => window.__computerRehearsal.fixtureGranted,
        );
        phaseEvidence.realApps = {
          checks: { ...checks },
          state: Object.values(checks).every(Boolean) ? "passed" : "failed",
        };
        stage = "finished";
        await instructions("Real-app check finished. You can use your computer again.");
      }
      if (windowless) {
        stage = "external-observer-connection";
        windowlessConsent = await page.evaluate(() => ({
          requested: !!window.__computerRehearsal.consent,
          trustedClick: window.__computerRehearsal.trustedConsent === true,
          settled: window.__computerRehearsal.consentSettled === true,
          allowed: window.__computerRehearsal.consentAllowed === true,
          fixtureGranted: window.__computerRehearsal.fixtureGranted === true,
        }));
        if (!Object.values(windowlessConsent).every(Boolean))
          throw new Error("Windowless consent prerequisite incomplete.");
        externalClient = await RehearsalExternalClient.connect(
          await page.evaluate(() => window.desktopBridge.getWsUrl()),
          (channel, data) => {
            if (channel === "preview.automation.pauseChanged" && data?.threadId === threadId) {
              if (typeof data.paused !== "boolean") throw new Error("Invalid pause observation.");
              externalPaused = data.paused === true;
            }
          },
        );
        await instructions(
          "F5's test windows will close. Keep input idle. After the check stops its session, click Finish check in the synthetic fixture when it becomes enabled.",
        );
        stage = "close-app-windows";
        await application.evaluate(() => {
          globalThis.__computerRehearsalWindowless.active = true;
          for (const win of globalThis.__computerRehearsalAppWindows()) win.close();
        });
        await waitFor(
          async () =>
            application.evaluate(() => globalThis.__computerRehearsalAppWindows().length === 0),
          5000,
        );
        appWindowsClosed = true;
        fixture.child.stdin.write("WINDOWLESS_READY\n");
        await delay(1000);
        for (const seconds of [3, 2, 1]) {
          if (interrupted || externalPaused) throw new Error("Windowless countdown interrupted.");
          fixture.child.stdin.write(`WINDOWLESS_COUNTDOWN_${seconds}\n`);
          await delay(1000);
        }
        fixture.child.stdin.write("WINDOWLESS_RUNNING\n");
        stage = "windowless-provider-actions";
        await startTurn(
          `Use only F5 computer tools for exact app ${appId}. The F5 app windows are now closed, but your genuine app grant remains in this session. Call computer_status, activate the exact app with screenshot:true, take a fresh computer_screenshot using its displayId, inspect the exact app. Press Rehearsal press once with a semantic action, focus Rehearsal input semantically, and type exactly F5_ELECTRON_REHEARSAL Ω🙂. Do not press Finish check or the secure-field control. Never use shell, files, network, other apps or the secure field. Stop on interruption, ambiguity or any failed tool; never retry. Finish READY.`,
        );
        await waitTurn();
        const observed = await observer();
        checks["native-receipt"] = windowlessChecks({
          nativeObservation: observed,
          fixtureObservation: {
            presses: fixture.presses(),
            expectedSyntheticTextReceived: fixture.typed(),
          },
        })["native-receipt"];
        if (!checks["native-receipt"]) throw new Error("Windowless native outcomes incomplete.");
        stage = "windowless-session-stop";
        await dispatch({ type: "thread.session.stop", threadId });
        await waitFor(async () => {
          const snapshot = await rpc(ORCHESTRATION_WS_METHODS.getSnapshot);
          return (
            snapshot.threads.find((thread) => thread.id === threadId)?.session?.status === "stopped"
          );
        }, 15000);
        await waitFor(async () => {
          const grants = await rpc("computer.access.list", { threadId });
          return Array.isArray(grants) && grants.length === 0 && !(await observer()).held;
        }, 5000);
        windowlessStopObservation = {
          sessionStopped: true,
          grantsCleared: true,
          leaseReleased: true,
        };
        checks.stop = true;
        windowlessObservation = await application.evaluate(() => {
          const observed = globalThis.__computerRehearsalWindowless;
          return {
            ...observed,
            finalWindowCount: globalThis.__computerRehearsalAppWindows().length,
          };
        });
        checks["windows-closed"] = windowlessChecks({ windowlessObservation })["windows-closed"];
        if (!checks["windows-closed"]) throw new Error("F5 windows reopened during the check.");
        stage = "windowless-finish-acknowledgement";
        fixture.child.stdin.write("WINDOWLESS_FINISHED\n");
        await waitFor(() => fixture.acknowledged(), 90000);
        checks.humanFinishAcknowledged = true;
        stage = "finished";
        process.stdout.write(
          "Test closed. Windowless check finished; you can use your computer again.\n",
        );
      } else if (backgroundFixture) {
        stage = "background-fixture-actions";
        windowsFixtureObserver = new WindowsFixtureObserver(fixture);
        const before = await windowsFixtureObserver.command();
        if (before.foregroundWindowId === before.windowId)
          throw new Error("Background fixture must not be frontmost.");
        const sessionReview = await reviewedTurn({
          kind: "session-actions",
          allow: true,
          instructionsText:
            "Click Review access when asked and approve background control for this synthetic session. Then keep input idle.",
          prompt: `Use only F5 computer tools for exact approved app ${appId}. This session uses background execution. Inspect that exact app without activation or focus changes. Use computer_element_action setValue on its ordinary Rehearsal input to set exactly F5_ELECTRON_REHEARSAL Ω🙂, then computer_element_action press on Rehearsal press exactly once. Take one app-scoped computer_screenshot for this exact app. Do not focus, activate, open apps, click coordinates, send keys, use computer_type, or request foreground. Do not touch Finish check or any password field. No shell/files/network or other apps. Stop on any failure, ambiguity or ForegroundRequired and never retry. Finish READY.`,
        });
        const after = await windowsFixtureObserver.command();
        const native = await observer();
        const mutations = native.operations.filter(
          (op) =>
            ![
              "status",
              "listApps",
              "inspect",
              "screenshot",
              "zoom",
              "resolveApps",
              "leaseAcquire",
            ].includes(op.op),
        );
        checks.backgroundSemanticInputReceived =
          fixture.typed() && fixture.presses() === 1 && after.receipt.secureEvents === 0;
        checks.backgroundTrustedSessionConsent =
          sessionReview.trustedReview &&
          sessionReview.visible &&
          sessionReview.settled &&
          sessionReview.allowed;
        checks.backgroundNativeDelivery =
          mutations.length === 2 &&
          mutations.every(
            (op) =>
              op.op === "elementAction" && op.outcome === "ok" && op.backgroundDelivery === true,
          );
        checks.backgroundFocusPreserved =
          before.foregroundWindowId === after.foregroundWindowId &&
          after.foregroundWindowId !== after.windowId;
        checks.backgroundCaptureReceived = native.captureResponses >= 1;
        checks.backgroundTurnLeaseReleased = native.leaseObserved && !native.held;
        if (!Object.values(checks).every(Boolean))
          throw new Error("Background workflow evidence incomplete.");
        stage = "finished";
        await instructions("Test closed. Background workflow finished. You can use your computer.");
      } else if (realApps) {
        await runRealAppPhase();
      } else if (stopOnly) {
        stage = "stop-clock-calibration";
        let clock;
        for (let index = 0; index < 3; index++) {
          const before = performance.now();
          fixture.child.stdin.write("CALIBRATE\n");
          await waitFor(() => stopTrace.calibrations.length > index, 5000, 1);
          const after = performance.now();
          const native = stopTrace.calibrations[index];
          const candidate = { offsetMinMs: native - after, offsetMaxMs: native - before };
          if (
            !clock ||
            candidate.offsetMaxMs - candidate.offsetMinMs < clock.offsetMaxMs - clock.offsetMinMs
          )
            clock = candidate;
        }
        if (clock.offsetMaxMs - clock.offsetMinMs > 25)
          throw new Error("Stop clock calibration uncertain.");
        // Resolve the real renderer PID before it is frozen. Main and helper stay
        // independent; no renderer RPC is needed on the stop path.
        const activeProfileId = await page.evaluate(() => window.desktopBridge.getProfileId());
        const targetPid = stopBackend
          ? await application.evaluate(
              (_electron, profileId) => globalThis.__computerRehearsalBackendPids[profileId],
              activeProfileId,
            )
          : stopMain
            ? application.process().pid
            : await application.evaluate(({ BrowserWindow }) =>
                BrowserWindow.getAllWindows()
                  .find((w) => w.webContents.getURL().startsWith("t3:"))
                  ?.webContents.getOSProcessId(),
              );
        if (!Number.isInteger(targetPid) || targetPid <= 0)
          throw new Error("Missing isolated process.");
        if (process.platform === "win32")
          windowsFreeze = await createWindowsProcessFreeze(targetPid);
        await instructions(
          process.platform === "win32"
            ? "Wait for the separate fixture to turn RED, then press Ctrl + Alt + Shift + F12 once. Keep input idle until RED."
            : "Wait for the separate fixture to turn RED, then press Control + Command + Escape once. Keep input idle until RED.",
        );
        fixture.child.stdin.write("COUNTDOWN_WAIT\n");
        await delay(3100);
        stage = "stop-input-turn";
        await startTurn(
          `Explicit isolated physical stop test. Use only F5 computer tools for exact app ${appId}. Call computer_status, activate that exact app with screenshot:false, then call computer_type once with text consisting of exactly 8000 lowercase x characters and screenshot:false. Do not use inspect, screenshots, element actions, any other app, shell, files or network. Do not retry any interrupted or failed call; stop immediately on interruption. The operator will press the native kill chord during this single typing action.`,
        );
        await waitFor(
          () =>
            stopTrace.evidence.samples.filter(
              (sample) => sample.kind === "injected" && sample.keyDown,
            ).length >= 8,
          150000,
        );
        if (
          stopTrace.evidence.overflow ||
          stopTrace.evidence.samples.some((sample) => sample.kind !== "injected")
        )
          throw new Error("Premature physical input or incomplete stop trace.");
        const heartbeat = await application.evaluate(
          () => globalThis.__computerRehearsalStop.snapshot().heartbeatSequence,
        );
        await waitFor(
          async () =>
            (await application.evaluate(
              () => globalThis.__computerRehearsalStop.snapshot().heartbeatSequence,
            )) > heartbeat,
          1000,
        );
        stage = stopBackend
          ? "backend-frozen-physical-stop"
          : stopMain
            ? "main-frozen-physical-stop"
            : "renderer-frozen-physical-stop";
        frozenPid = targetPid;
        // External supervisor, independent of the frozen app, always restores it.
        restoreTimer = setTimeout(restoreProcess, stopMain ? 850 : 10000);
        if (windowsFreeze) await windowsFreeze.freeze(stopMain ? 850 : 10000);
        else process.kill(frozenPid, "SIGSTOP");
        const stopped = windowsFreeze
          ? await windowsFreeze.stopped()
          : (
              await exec("ps", ["-o", "state=", "-p", String(frozenPid)], { timeout: 2000 })
            ).stdout.includes("T");
        if (!stopped) throw new Error("Process did not stop.");
        const startMs = performance.now();
        fixture.child.stdin.write("GO\n");
        if (stopMain) await delay(700);
        else
          await waitFor(
            () => stopTrace.evidence.samples.some((sample) => sample.kind === "chord"),
            8000,
          );
        const stillStopped = windowsFreeze
          ? await windowsFreeze.stopped()
          : (
              await exec("ps", ["-o", "state=", "-p", String(targetPid)], { timeout: 2000 })
            ).stdout.includes("T");
        const endMs = performance.now();
        if (!frozenPid || !stillStopped)
          throw new Error("Process freeze ended before measurement.");
        const bounds = { startMs, endMs, ...clock };
        if (stopBackend) {
          stopTrace.evidence.backendFreeze = bounds;
          stopTrace.evidence.backendFrozenAtStop = true;
        } else if (stopMain) stopTrace.evidence.hostStall = bounds;
        else stopTrace.evidence.rendererFreeze = bounds;
        await restoreProcess();
        checks.actualElectronProcessFrozen = true;
        await waitFor(async () => {
          const trace = await application.evaluate(() =>
            globalThis.__computerRehearsalStop.snapshot(),
          );
          stopTrace.helper({ type: "physicalInput", recognizedAtMs: trace.physicalRecognizedAtMs });
          stopTrace.helper({ type: "killSwitch", recognizedAtMs: trace.chordRecognizedAtMs });
          return stopTrace.evidence.chordRecognizedAtMs !== undefined;
        }, 10000);
        await waitFor(async () => !(await observer()).held, 10000);
        await delay(750);
        fixture.child.stdin.write("FINISH\n");
        await waitFor(() => stopTrace.evidence.observationEndedAtMs !== undefined, 5000);
        const native = await observer();
        stopTrace.evidence.mutationInterrupted = native.operations.some(
          (op) => op.op === "type" && op.outcome === "Interrupted",
        );
        stopTrace.evidence.leaseReleased = !native.held && native.leaseObserved;
        checks.helperRecognizedChordAndMirroredPause = native.pauseObserved;
        stage = "paused-mutation-refusal";
        await waitFor(async () => {
          const snapshot = await rpc(ORCHESTRATION_WS_METHODS.getSnapshot);
          const turn = snapshot.threads.find((t) => t.id === threadId)?.latestTurn;
          return turn && turn.turnId !== previousTurnId && turn.state !== "running";
        }, 60000);
        const before = native.operations.length;
        const failuresBefore = await page.evaluate(
          () => window.__computerRehearsal.toolOutcomeErrors.length,
        );
        await startTurn(
          `Isolated stop verification: use only F5 computer tools. Call computer_list_apps once, then attempt computer_type with text x and screenshot:false once. The thread is deliberately paused, so that call MUST be refused. Do not resume, retry or use any other tools, apps, shell, files or network. Finish READY after refusal.`,
        );
        await waitFor(async () => {
          const snapshot = await rpc(ORCHESTRATION_WS_METHODS.getSnapshot);
          const turn = snapshot.threads.find((t) => t.id === threadId)?.latestTurn;
          return turn && turn.turnId !== previousTurnId && turn.state !== "running";
        }, 90000);
        const final = await observer();
        stopTrace.evidence.pausedMutationRefused =
          final.operations
            .slice(before)
            .some(
              (op) =>
                (op.op === "leaseAcquire" || op.op === "type") &&
                op.outcome === "Interrupted" &&
                op.cause === "paused",
            ) ||
          (await page.evaluate(
            (count) =>
              window.__computerRehearsal.paused &&
              window.__computerRehearsal.toolOutcomeErrors.slice(count).includes("Interrupted"),
            failuresBefore,
          ));
        // Require a newly refused call, not the earlier interrupted input action.
        checks.noSyntheticInputAfterStop = !stopTrace.evidence.samples.some(
          (sample) =>
            sample.kind === "injected" &&
            sample.eventAtMs > stopTrace.evidence.chordRecognizedAtMs + 100,
        );
        stopMeasurement = measureStopLatency(stopTrace.evidence);
        checks.nativeStopMeasurementPassed = stopMeasurement.state === "passed";
        stage = "finished";
        await instructions("Stop check finished. You can use your computer again.");
      } else {
        stage = "first-action-turn";
        await startTurn(
          controlsOnly
            ? `Continue the isolated F5 UI controls check. Access was approved for exact app ${appId}; use only F5 computer tools for that app. Call computer_status, call computer_activate_app with app set to the exact appId and screenshot:true, take computer_screenshot, then finish READY. Do not inspect, click, type, send keys, scroll, drag or perform element actions. Never use shell, files, network or other apps. Stop immediately on any interruption, ambiguity or failed action.`
            : `Continue the isolated F5 UI rehearsal. Access was approved in the previous turn for exact app ${appId}; use only F5 computer tools for that app. You may use tool discovery to locate them. Call computer_status, call computer_activate_app with app set to the exact appId and screenshot:true, take computer_screenshot, inspect the exact appId. Use this exact appId in every tool app argument; never substitute the display name. Press Rehearsal press once using computer_element_action, focus Rehearsal input with an element action, and type exactly this synthetic text: F5_ELECTRON_REHEARSAL Ω🙂. Finish READY. Never use shell, files, network, any other app or the secure field. Stop immediately on any interruption, ambiguity or failed action.`,
        );
        await waitTurn();
        checks.humanTrustedConsent = await page.evaluate(
          () => window.__computerRehearsal.trustedConsent,
        );
        const first = await observer();
        if (controlsOnly) {
          checks.controlsFirstCaptureSucceeded = first.responses.nativeCaptureSucceeded;
          checks.controlsFirstActivationSucceeded = first.operations.some(
            (op) => op.op === "activateApp" && op.outcome === "ok",
          );
        } else {
          checks.firstTurnNativeResponses = Object.values(first.responses).every(Boolean);
          checks.fixtureReceivedOnePressAndUnicode = fixture.presses() === 1 && fixture.typed();
          if (chromiumFixture)
            checks.chromiumFixtureNativeInputObserved =
              checks.firstTurnNativeResponses && checks.fixtureReceivedOnePressAndUnicode;
        }
        if (
          !checks.humanTrustedConsent ||
          (controlsOnly
            ? !checks.controlsFirstCaptureSucceeded || !checks.controlsFirstActivationSucceeded
            : !checks.firstTurnNativeResponses || !checks.fixtureReceivedOnePressAndUnicode)
        )
          throw new Error("First turn evidence incomplete.");
        if (!actionsOnly) {
          stage = "human-pause";
          checks.pauseControlVisibleAfterTurn = await page
            .getByTestId("computer-live-card")
            .getByRole("button", { name: "Pause", exact: true })
            .isVisible();
          if (!checks.pauseControlVisibleAfterTurn)
            throw new Error("Pause control was not visible.");
          await application.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
              .find((w) => w.webContents.getURL().startsWith("t3:"))
              ?.focus(),
          );
          await instructions(
            "First turn finished. Click Pause in the Agent computer control card now.",
          );
          await waitFor(() => page.evaluate(() => window.__computerRehearsal.paused), 180000);
          checks.humanPauseMirrored =
            (await observer()).pauseObserved &&
            (await page.evaluate(() => window.__computerRehearsal.trustedPause));
          await delay(1500);
          checks.untrustedResumeRefused = await page.evaluate(async (id) => {
            try {
              await window.desktopBridge.computerAutomation.setPaused(id, false);
              return false;
            } catch {
              return true;
            }
          }, threadId);
          if (!checks.untrustedResumeRefused) throw new Error("Untrusted resume was accepted.");
          stage = "human-resume";
          await instructions(
            controlsOnly
              ? "Click Resume in the same card and confirm Resume in the native F5 dialog, then keep input idle. The agent will only activate the fixture and take a fresh screenshot."
              : "Click Resume in the same card and confirm Resume in the native F5 dialog, then keep mouse and keyboard idle. The agent will take a fresh screenshot and click the test button once.",
          );
          await waitFor(() => page.evaluate(() => !window.__computerRehearsal.paused), 180000);
          checks.humanResumeMirrored =
            (await observer()).resumeObserved &&
            (await page.evaluate(() => window.__computerRehearsal.trustedResume));
        }
        const before = await observer();
        await delay(2000);
        stage = actionsOnly ? "second-action-turn" : "second-turn-after-resume";
        await startTurn(
          controlsOnly
            ? `Continue this isolated F5 controls check. Use only F5 computer tools for exact app ${appId}. First computer_status; call computer_activate_app with app set to the exact appId and screenshot:true; take a NEW computer_screenshot, then finish READY. Do not inspect, click, type, send keys, scroll, drag or perform element actions. Never use shell, filesystem, network or other apps. Stop immediately on any failure or interruption; do not retry.`
            : `Continue this explicit isolated UI rehearsal. Use only F5 computer tools for exact app ${appId}; you may use tool discovery to locate them. First computer_status; call computer_activate_app with app set to the exact appId and screenshot:true; take a NEW computer_screenshot; inspect Rehearsal press and compute its center from its bounds. Use computer_click once at that center with the screenshot displayId and screenshot:true. Never use a cached screenshot, element action for this click, shell, filesystem, network, other apps or the secure field. Finish READY. Stop immediately on any failure or interruption; do not retry.`,
        );
        await waitTurn();
        const after = await observer();
        checks[actionsOnly ? "freshCaptureOnNextTurn" : "freshCaptureAfterResume"] =
          after.captureResponses > before.captureResponses;
        if (controlsOnly)
          checks.controlsOnlyEmittedNoInput =
            fixture.presses() === 0 &&
            !fixture.typed() &&
            after.operations.every(
              (op) =>
                ![
                  "inspect",
                  "type",
                  "key",
                  "click",
                  "move",
                  "drag",
                  "scroll",
                  "elementAction",
                ].includes(op.op),
            );
        else checks.fixtureReceivedSecondCoordinatePress = fixture.presses() === 2;
        const visibleImage = page.getByAltText("Last captured computer action");
        checks.liveCardThumbnailRendered =
          (await visibleImage.isVisible()) &&
          (await visibleImage.evaluate((img) => img.complete && img.naturalWidth > 0));
        checks.realActivityAndThumbnailPush = await page.evaluate(
          () =>
            window.__computerRehearsal.activitySeen &&
            window.__computerRehearsal.thumbnailSeen &&
            window.__computerRehearsal.leaseSeen,
        );
        checks.turnLeaseReleased = !after.held && after.leaseObserved;
        checks.realComposerSubmittedAllThreeTurns = composerSubmissions === 3;
        clearInterval(overlayTimer);
        await Promise.race([overlayPoll, delay(1000)]);
        checks.realOverlayObserved = overlay.observed && overlay.protectedOptions;
        if (!controlsOnly) {
          checks.realSemanticOutlineObserved = overlay.semanticOutline;
          checks.realCoordinateCursorObserved = overlay.coordinateCursor;
        }
        checks.overlayClosedAfterLease = await application.evaluate(
          ({ BrowserWindow }) =>
            !BrowserWindow.getAllWindows().some((w) =>
              w.webContents.getURL().startsWith("data:text/html"),
            ),
        );
        stage = "finished";
        if (clusterWorkflows) {
          phaseEvidence.fixture = {
            checks: { ...checks },
            state: Object.values(checks).every(Boolean) ? "passed" : "failed",
          };
          if (phaseEvidence.fixture.state !== "passed")
            throw new Error("Fixture phase incomplete; real-app phase will not run.");
          await instructions(
            "Fixture and UI checks finished. Keep input idle for the real-app phase.",
          );
          await application.evaluate(() => globalThis.__computerRehearsalResetRealApps());
          await runRealAppPhase();
        } else await instructions("Check finished. You can use your computer again.");
      }
    } finally {
      clearInterval(overlayTimer);
      await Promise.race([overlayPoll, delay(1000)]);
    }
  }
} catch (cause) {
  failureStage = stage;
  failureCode = rehearsalHarnessFailureCode(cause);
  failureLocation = rehearsalHarnessFailureLocation(cause);
  // Narrow local device authority before waiting on server diagnostics.
  if (profileIsolationPause) await Promise.race([profileIsolationPause(), delay(1000)]);
  if (profileIsolationDiagnostics) {
    const diagnostics = await profileIsolationDiagnostics().catch(() => ({
      diagnosticsUnavailable: true,
    }));
    profileIsolationObservation = { ...profileIsolationObservation, ...diagnostics };
  }
  process.exitCode = 1;
} finally {
  windowsFixtureObserver?.close();
  await restoreProcess();
  await windowsFreeze?.close();
  // Preserve a native focus receipt even when waiting for the chord failed.
  // This observation cannot turn a failed stage into a successful run.
  if (
    stopOnly &&
    fixture &&
    !interrupted &&
    stopTrace.evidence.observationEndedAtMs === undefined &&
    fixture.child.exitCode === null &&
    fixture.child.signalCode === null &&
    !fixture.child.stdin.destroyed
  ) {
    fixture.child.stdin.write("FINISH\n");
    await waitFor(() => stopTrace.evidence.observationEndedAtMs !== undefined, 1000).catch(
      () => {},
    );
  }
  if (stopOnly) stopMeasurement = measureStopLatency(stopTrace.evidence);
  process.off("SIGINT", halt);
  process.off("SIGTERM", halt);
  if (application) nativeObservation = await observer().catch(() => undefined);
  if (nativeObservation) {
    const stdout = stdoutObservation.snapshot();
    const stderr = stderrObservation.snapshot();
    nativeObservation.backendRestarts = [...stdout.backendRestarts, ...stderr.backendRestarts];
    nativeObservation.backendLifecycle = [
      ...new Set([...stdout.backendLifecycle, ...stderr.backendLifecycle]),
    ].sort();
    const transport = [...stdout.mcpTransport, ...stderr.mcpTransport];
    nativeObservation.mcpTransport = transport.slice(0, profileObservationLimit);
    nativeObservation.mcpTransportOverflow =
      stdout.mcpTransportOverflow ||
      stderr.mcpTransportOverflow ||
      transport.length > profileObservationLimit;
  }
  if (includesRealApps && application)
    realAppObservation = await application
      .evaluate(() => globalThis.__computerRehearsalRealApps.snapshot())
      .catch(() => undefined);
  if (page && application && !appWindowsClosed) {
    if (sessionActions || approvalDiagnostic) {
      const modes = (submittedRuntimeModes = await page
        .evaluate(() => window.__computerRehearsal.submittedRuntimeModes)
        .catch(() => []));
      checks.approvalModeActuallySubmitted =
        modes.length === composerSubmissions &&
        composerSubmissions > 0 &&
        modes.every((mode) => mode === "approval-required");
    }
    const image = page.getByAltText("Last captured computer action");
    thumbnailObservation = await image
      .isVisible()
      .then(async (visible) => ({
        visible,
        loaded: visible && (await image.evaluate((img) => img.complete && img.naturalWidth > 0)),
      }))
      .catch(() => ({ visible: false, loaded: false }));
    const tail = await rpc(ORCHESTRATION_WS_METHODS.getThreadTailDetails, {
      threadId,
      messageLimit: 0,
      checkpointLimit: 0,
      activityLimit: 100,
    }).catch(() => undefined);
    providerErrorCodes = rehearsalProviderErrorCodes(tail?.activities);
    providerActivityCounts = rehearsalProviderActivityCounts(tail?.activities);
    if (grantMemory) {
      providerTailObserved = Array.isArray(tail?.activities);
      checks.grantMemoryProviderTailObserved = providerTailObserved;
      checks.grantMemoryNoTaggedProviderErrors = providerErrorCodes.length === 0;
    }
    if (sessionActions) {
      providerTailObserved = Array.isArray(tail?.activities);
      checks.sessionActionsProviderTailObserved = providerTailObserved;
      checks.sessionActionsOnlyExpectedDenial =
        providerTailObserved && providerErrorCodes.every((code) => code === "NotGranted");
      sessionActionsFailures = await page
        .evaluate(() => {
          if (window.__computerRehearsal.toolFailuresOverflow)
            throw new Error("Incomplete activity trace.");
          return window.__computerRehearsal.toolFailures;
        })
        .catch(() => undefined);
      checks.sessionActionsOnlyExpectedDenial &&=
        sessionActionsFailures?.length === 1 &&
        sessionActionsFailures[0]?.op === "activateApp" &&
        sessionActionsFailures[0]?.outcome === "NotGranted";
    }
    toolOutcomeErrors = await page
      .evaluate(() => window.__computerRehearsal.toolOutcomeErrors)
      .then((codes) => [...new Set(codes.filter(Schema.is(ComputerToolOutcomeCode)))].sort())
      .catch(() => []);
    if (statusOnly) {
      checks.noTaggedProviderErrors = providerErrorCodes.length === 0;
      checks.hostAvailableAtEnd = nativeObservation?.hostStatus?.available === true;
    }
    consentObservation = await page
      .evaluate(() => {
        const state = window.__computerRehearsal;
        return {
          requested: !!state?.consent,
          trustedClick: state?.trustedConsent === true,
          settled: state?.consentSettled === true,
          allowed: state?.consentAllowed === true,
          fixtureGranted: state?.fixtureGranted === true,
          cardHasError: !!document.querySelector(
            '[data-testid="computer-access-card"] [role="alert"]',
          ),
          dialogPresentInDom: !!document.querySelector('[role="dialog"]'),
        };
      })
      .catch(() => undefined);
    if (statusOnly) checks.noConsentRequested = consentObservation?.requested === false;
    threadObservation = await page
      .evaluate(
        async ([method, id]) => {
          const snapshot = await window.__computerRehearsal.rpc(method);
          const thread = snapshot.threads.find((entry) => entry.id === id);
          if (!thread) return { found: false };
          const modes = ["full-access", "approval-required"];
          const interactions = ["default", "plan"];
          const turnStates = ["running", "completed", "interrupted", "error"];
          return {
            found: true,
            runtimeMode: modes.includes(thread.runtimeMode) ? thread.runtimeMode : "unknown",
            sessionRuntimeMode: modes.includes(thread.session?.runtimeMode)
              ? thread.session.runtimeMode
              : "unknown",
            interactionMode: interactions.includes(thread.interactionMode)
              ? thread.interactionMode
              : "unknown",
            turnState: turnStates.includes(thread.latestTurn?.state)
              ? thread.latestTurn.state
              : "unknown",
            pendingUserInputs: Math.min(100, thread.pendingUserInputs?.length ?? 0),
            hasUsageLimit: !!thread.session?.usageLimit,
            requestedInstance: ["codex", "claudeAgent"].includes(thread.modelSelection?.instanceId)
              ? thread.modelSelection.instanceId
              : "unknown",
            sessionInstance: ["codex", "claudeAgent"].includes(thread.session?.providerInstanceId)
              ? thread.session.providerInstanceId
              : "unknown",
          };
        },
        [ORCHESTRATION_WS_METHODS.getSnapshot, threadId],
      )
      .catch(() => undefined);
    const failureSnapshot = await rpc(ORCHESTRATION_WS_METHODS.getSnapshot).catch(() => undefined);
    if (threadObservation)
      threadObservation.sessionErrorCode = rehearsalSessionErrorCode(
        failureSnapshot?.threads.find((thread) => thread.id === threadId)?.session?.lastError,
      );
  }
  if (appWindowsClosed && externalClient) {
    consentObservation = windowlessConsent;
    const tail = await rpc(ORCHESTRATION_WS_METHODS.getThreadTailDetails, {
      threadId,
      messageLimit: 0,
      checkpointLimit: 0,
      activityLimit: 100,
    }).catch(() => undefined);
    providerErrorCodes = rehearsalProviderErrorCodes(tail?.activities);
    providerTailObserved = Array.isArray(tail?.activities);
    checks.noTaggedProviderErrors = providerTailObserved && providerErrorCodes.length === 0;
  }
  if (page)
    await page
      .evaluate((id) => window.desktopBridge.computerAutomation.setPaused(id, true), threadId)
      .catch(() => {});
  const ownedPids = application
    ? await application
        .evaluate(() => [...globalThis.__computerRehearsalChildPids])
        .catch(() => undefined)
    : [];
  let applicationClosed = !application;
  if (application) {
    try {
      await application.close();
      applicationClosed = true;
    } catch {
      /* No exit proof. Never mark failed cleanup as passed. */
    }
  }
  let childrenClosed =
    Array.isArray(ownedPids) &&
    ownedPids.length <= 32 &&
    ownedPids.every((pid) => Number.isInteger(pid) && pid > 0);
  if (childrenClosed) {
    const deadline = Date.now() + 5000;
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return error?.code !== "ESRCH";
      }
    };
    while (ownedPids.some(alive) && Date.now() < deadline) await delay(50);
    childrenClosed = ownedPids.every((pid) => !alive(pid));
  }
  if (failureStage) process.stdout.write("Test closed. You can use your computer again.\n");
  if (fixture)
    fixtureObservation = {
      presses: Math.min(100, fixture.presses()),
      expectedSyntheticTextReceived: fixture.typed(),
      ...(windowless || sessionActions ? { humanFinishAcknowledged: fixture.acknowledged() } : {}),
    };
  let fixtureClosed = await closeRehearsalChild(fixture?.child);
  for (const owned of additionalFixtures)
    fixtureClosed = (await closeRehearsalChild(owned.child)) && fixtureClosed;
  if (documentRoot) {
    const state = documentOpened
      ? await verifyRealApp("--document-state", documentPath).catch(() => undefined)
      : { documentState: "closed" };
    documentClosed = state?.documentState === "closed";
    if (documentClosed) await rm(documentRoot, { recursive: true, force: true });
    else process.stdout.write(`Test document retained: ${documentPath}\n`);
  }
  let realAppsClosed = !includesRealApps;
  if (includesRealApps && realAppProcessVerifier) {
    if (!failureStage && !interrupted && documentClosed) {
      for (const [id, pid] of Object.entries(realAppOwnedPids)) {
        const safe =
          id === REAL_APP_REHEARSAL_IDS[0]
            ? (await verifyRealApp("--textedit-has-no-windows").catch(() => undefined))
                ?.safeToTerminate === true
            : (await verifyRealApp("--verify-calculator", "42").catch(() => undefined))
                ?.expectedResultVisible === true;
        if (safe)
          await verifyRealAppProcesses("--terminate-owned", id, String(pid)).catch(() => undefined);
      }
    }
    const deadline = Date.now() + 5000;
    let pids;
    do {
      pids = await verifyRealAppProcesses("--status").catch(() => undefined);
      realAppsClosed =
        !!pids &&
        REAL_APP_REHEARSAL_IDS.every((id) => Array.isArray(pids[id]) && pids[id].length === 0);
      if (!realAppsClosed) await delay(50);
    } while (!realAppsClosed && Date.now() < deadline);
  }
  const cleanup = {
    applicationClosed,
    childrenClosed,
    fixtureClosed,
    realAppsClosed,
    documentClosed: !documentRoot || documentClosed,
    confirmed:
      applicationClosed &&
      childrenClosed &&
      fixtureClosed &&
      realAppsClosed &&
      (!documentRoot || documentClosed),
  };
  if (cleanup.confirmed)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  else
    process.stdout.write(
      "Test state retained because process/document cleanup was not confirmed.\n",
    );
  if (windowless)
    Object.assign(
      checks,
      windowlessChecks({
        nativeObservation,
        fixtureObservation,
        consentObservation,
        windowlessObservation,
        windowlessStopObservation,
        externalSubmissions,
        providerTailObserved,
        providerErrorCodes,
        stopScope: "session-stop-after-completed-native-actions",
        cleanup,
      }),
    );
  if (grantMemory) checks.grantMemoryCleanup = cleanup.confirmed;
  if (sessionActions) checks.sessionActionsCleanup = cleanup.confirmed;
  if (profileIsolation)
    Object.assign(
      checks,
      (profileInspectionDiagnostic
        ? profileInspectionDiagnosticChecks
        : profileIsolationReadOnly
          ? profileReadinessChecks
          : profileIsolationChecks)({
        profileIsolationObservation,
        cleanup,
      }),
    );
  for (const client of additionalClients) client.close();
  externalClient?.close();
  const passed =
    !failureStage && !interrupted && cleanup.confirmed && Object.values(checks).every(Boolean);
  if (!passed) process.exitCode = 1;
  await writeFile(
    resolve(output),
    JSON.stringify(
      {
        reportVersion: 1,
        admissionId: process.env.F5_COMPUTER_CERTIFICATION_ADMISSION,
        recordedAt: new Date().toISOString(),
        scope: profileInspectionDiagnostic
          ? "unsigned-real-electron-codex-profile-inspection-diagnostic"
          : profileIsolationReadOnly
            ? "unsigned-real-electron-codex-profile-readiness"
            : profileIsolation
              ? "unsigned-real-electron-codex-profile-isolation"
              : sessionActions
                ? `unsigned-real-electron-${provider}-session-actions`
                : grantMemory
                  ? `unsigned-real-electron-${provider}-grant-memory`
                  : windowless
                    ? `unsigned-real-electron-${provider}-all-app-windows-closed`
                    : clusterWorkflows
                      ? "unsigned-real-electron-clustered-workflows"
                      : realApps
                        ? `unsigned-real-electron-${provider}-textedit-and-calculator`
                        : backgroundFixture
                          ? `unsigned-real-electron-${provider}-background-fixture`
                          : stopOnly
                            ? `unsigned-real-electron-${provider}-${stopBackend ? "backend" : stopMain ? "main" : "renderer"}-frozen-physical-stop`
                            : statusOnly
                              ? `unsigned-real-electron-${provider}-${approvalDiagnostic ? "approval-mode-" : ""}read-only-discovery-diagnostic`
                              : controlsOnly
                                ? `unsigned-real-electron-${provider}-human-consent-and-controls`
                                : actionsOnly
                                  ? `unsigned-real-electron-${provider}-human-consent-and-actions`
                                  : `unsigned-real-electron-${provider}-human-consent-synthetic-app`,
        platform: process.platform,
        arch: process.arch,
        osVersion: release(),
        repositoryCommit,
        workingTreeDirty,
        helperSha256,
        buildHashes,
        signed: false,
        certified: false,
        provider,
        ...(sessionActions || approvalDiagnostic
          ? { approvalComposerInitiallySupervised, submittedRuntimeModes }
          : {}),
        ...(sessionActions
          ? {
              sessionActionsObservation,
              sessionActionsFailures,
              providerActivityCounts,
              providerTailObserved,
              composerSubmissions,
              approvalModeVerifiedTurns,
            }
          : {}),
        ...(approvalDiagnostic
          ? { approvalDiagnostic: true, approvalModeVerifiedTurns, composerSubmissions }
          : {}),
        ...(grantMemory
          ? { grantMemoryObservation, grantMemoryConsentReceipts, providerTailObserved }
          : {}),
        ...(profileIsolation ? { profileIsolationObservation } : {}),
        ...(windowless
          ? {
              externalSubmissions,
              providerTailObserved,
              windowlessObservation,
              windowlessStopObservation,
              stopScope: "session-stop-after-completed-native-actions",
            }
          : {}),
        ...(claudeAuthentication ? { claudeAuthentication } : {}),
        runtimeMode,
        state: passed ? "passed" : "failed",
        interrupted,
        ...(failureStage ? { failureStage, failureCode, failureLocation } : {}),
        permissionStatus,
        nativeObservation,
        threadObservation,
        consentObservation,
        providerErrorCodes,
        toolOutcomeErrors,
        thumbnailObservation,
        fixtureObservation,
        ...(includesRealApps
          ? {
              realAppObservation,
              realAppPrerequisites,
              calculatorBaselineObservation,
              retainedTestDocument: !!documentRoot && !documentClosed,
              setupOpenedTemporaryDocument: documentOpened,
            }
          : {}),
        ...(stopOnly ? { stopMeasurement } : {}),
        ...(chordTrace ? { chordObservation: chordTrace.summary() } : {}),
        checks,
        ...(clusterWorkflows ? { phaseEvidence } : {}),
        cleanup,
        ...(controlsOnly ? { controlsOnly: true } : {}),
        ...(actionsOnly ? { actionsOnly: true } : {}),
        limitations: [
          ...(includesRealApps
            ? [
                "One real provider, TextEdit and Calculator, on the current display only",
                "Real human app consent; full-access mode excludes the session-actions consent test",
                "Setup opened its own temporary TextEdit file after consent; provider tools performed edit/save/close and Calculator launch/arithmetic",
                "App grants are app-wide; this run does not certify capture privacy, protected targets or the complete real-app matrix",
              ]
            : statusOnly
              ? [
                  "Read-only tool discovery/status/app metadata only; no consent, screenshots, OS input or human controls tested",
                ]
              : [
                  "One real provider and one synthetic AppKit app, on the current display only",
                  sessionActions
                    ? "Genuine app and session-actions reviews in approval-required mode; denied activation, one allowed activation/capture and next-turn semantic press; no expiry, stale-answer, typing-upgrade or session-restart approval reset proof"
                    : grantMemory
                      ? "Genuine app denial and remembering, authenticated narrowing APIs and provider session restarts only; no OS capture/input, session-actions approval, expiry, stale-answer or web-client proof"
                      : windowless
                        ? "Human app consent; app windows closed during one provider turn, followed by session stop after completed actions; no in-flight stop latency proof"
                        : stopOnly
                          ? "Human app consent and physical chord; UI Pause/Resume is excluded"
                          : actionsOnly
                            ? "Human app consent; Pause/Resume is excluded from this actions-only run"
                            : "Human app consent and pause/resume; no session-actions consent in full-access mode",
                  ...(actionsOnly ? ["No session-actions consent in full-access mode"] : []),
                  ...(controlsOnly
                    ? [
                        "Controls-only check: no inspection, pointer/keyboard/semantic input or coordinate/element overlay proof",
                      ]
                    : []),
                ]),
          "No installed-build TCC attribution, signed packaging, multi-profile/display or complete real-app certification",
          stopOnly
            ? "Suspension of one isolated Electron process; does not prove arbitrary deadlocks, signed packaging or other operating-system versions"
            : "Overlay capture exclusion, hung-renderer/host stop latency, Stop interruption and Windows runtime remain pending",
          "Provider built-in and Chrome gates remain closed; no image bytes, typed values, accessibility content or raw errors retained",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    `Electron rehearsal: ${resolve(output)} (${passed ? "passed" : "failed"}; release gates unchanged).\n`,
  );
}
