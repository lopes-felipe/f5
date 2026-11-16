import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { release, tmpdir } from "node:os";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { Schema } from "effect";
import {
  ComputerApp,
  ComputerInspectResult,
  ComputerScreenshot,
  type ComputerAutomationError,
  type ComputerAutomationRequest,
  type ComputerAuthorization,
  type ComputerGrant,
} from "@t3tools/contracts";
import { ComputerHelperClient } from "./ComputerHelperClient";
import { createRehearsalFixture, prepareRehearsalExecutable } from "./rehearsalFixture";
import { closeRehearsalChild } from "./rehearsalCleanup";
import { createBrowserProtectionFixture } from "./rehearsalBrowserFixture";
import {
  BROWSER_PROTECTION_IDS,
  BROWSER_SECURE_LABEL,
  BROWSER_MARKER_LABEL,
  browserSecureInspection,
  expectedProtectionRefusal,
  protectionChromeArguments,
  protectionFailureSummary,
} from "./rehearsalProtection";

// Opt-in native-helper boundary checks, not provider consent or release certification.
// Terminal receives a click-only grant, never command/key input. Chrome receives
// a new private profile and a local synthetic password page, never a user profile.
const args = process.argv.slice(2);
const argument = (key: string) => {
  const index = args.indexOf(key);
  return index < 0 ? undefined : args[index + 1];
};
const helperPath = argument("--helper");
const output = argument("--output");
const fixtureBinDirectory = argument("--fixture-bin-dir");
const chromeBinary = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (
  process.platform !== "darwin" ||
  process.env.F5_COMPUTER_PROTECTION_REHEARSAL !== "1" ||
  !helperPath ||
  !output
) {
  process.stderr.write(
    "Human idle coordination required: F5_COMPUTER_PROTECTION_REHEARSAL=1 bun apps/desktop/src/computer/rehearseProtectedAppsMacos.ts --helper <dev helper> --output <new report.json>\n",
  );
  process.exit(1);
}
await writeFile(resolve(output), "", { flag: "wx" });
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "f5-protected-apps-rehearsal-"));
const helper = new ComputerHelperClient(dirname(resolve(helperPath)), resolve(helperPath));
const nativeSource = resolve(import.meta.dirname, "../../native/macos/Fixtures");
const appVerifier = join(root, "app-verifier");
const captureVerifier = join(root, "capture-verifier");
let browserFixture: Awaited<ReturnType<typeof createBrowserProtectionFixture>> | undefined;
const checks: Array<{
  name: string;
  state: "passed" | "failed";
  outcome?: string;
  unavailableReason?: string;
  missing?: readonly string[];
  captureFailure?: Extract<ComputerAutomationError, { _tag: "Unavailable" }>["captureFailure"];
  helperAvailable?: boolean;
  helperUnavailableReason?: string;
  elapsedMs: number;
}> = [];
let stage = "prerequisites";
let failureStage: string | undefined;
let physicalInterruption = false;
let chrome: ChildProcess | undefined;
let excluded: Awaited<ReturnType<typeof createRehearsalFixture>> | undefined;
let renewal: ReturnType<typeof setInterval> | undefined;
let startedTerminalPid: number | undefined;
let terminalLaunchAttempted = false;
let startedChromePid: number | undefined;
let browserOwnedProcessObserved = false;
let retainedTerminal = false;
let retainedChrome = false;
let metadata: Record<string, unknown> = {};
let authorization: ComputerAuthorization = {
  profileId: "native-protection-rehearsal",
  threadId: randomUUID(),
  sessionGeneration: randomUUID(),
  turnId: "protection-check",
  executionGeneration: 1,
  grantVersion: 1,
  grants: [],
};
helper.onEvent((event) => {
  if (event.type === "physicalInput" || event.type === "killSwitch") physicalInterruption = true;
});
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function waitFor(condition: () => boolean | Promise<boolean>, ms = 10000) {
  const deadline = performance.now() + ms;
  while (!(await condition())) {
    if (physicalInterruption || performance.now() >= deadline)
      throw new Error("Rehearsal interrupted or timed out.");
    await delay(25);
  }
}
function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error("Protection assertion failed.");
}
async function check(name: string, run: () => Promise<void>) {
  stage = name;
  process.stdout.write(`Checking: ${name}\n`);
  const start = performance.now();
  try {
    if (physicalInterruption) throw new Error("Physical interruption.");
    await run();
    checks.push({ name, state: "passed", elapsedMs: Math.round(performance.now() - start) });
  } catch (error) {
    checks.push({
      name,
      state: "failed",
      elapsedMs: Math.round(performance.now() - start),
      ...protectionFailureSummary(error, helper.status()),
    });
    throw error;
  }
}
type Operation = ComputerAutomationRequest extends infer R
  ? R extends ComputerAutomationRequest
    ? Omit<R, "requestId" | "payloadHash" | "authorization" | "deadlineAtMs" | "agent">
    : never
  : never;
async function request<T>(operation: Operation): Promise<T> {
  if (physicalInterruption) throw new Error("Physical interruption; no automatic resume.");
  return (await helper.request(
    {
      ...operation,
      requestId: randomUUID(),
      payloadHash: createHash("sha256").update(JSON.stringify(operation)).digest("hex"),
      authorization,
      deadlineAtMs: Date.now() + 10000,
      agent: { provider: "codex", threadTitle: "Native protection rehearsal" },
    } as ComputerAutomationRequest,
    { f5Pids: [process.pid], f5BundlePath: join(root, "protected-host"), overlayWindowIds: [] },
  )) as T;
}
async function requireRefusal(
  operation: Operation,
  kind: Parameters<typeof expectedProtectionRefusal>[1],
) {
  try {
    await request(operation);
  } catch (error) {
    if (expectedProtectionRefusal(error, kind)) return;
    throw error;
  }
  // Stop immediately: an unexpectedly successful action is never retried.
  throw new Error("Protected request unexpectedly succeeded.");
}
function setGrants(grants: ReadonlyArray<ComputerGrant>) {
  authorization = { ...authorization, grantVersion: authorization.grantVersion + 1, grants };
  helper.control({ type: "grantsChanged", authorization });
}
async function appPids(): Promise<Record<string, number[]>> {
  const status = await exec(appVerifier, ["--status"], { timeout: 5000, maxBuffer: 2048 });
  return JSON.parse(status.stdout) as Record<string, number[]>;
}
async function inspect(appId: string) {
  return Schema.decodeUnknownSync(ComputerInspectResult)(
    await request({ op: "inspect", appId, maxNodes: 400 }),
  );
}
async function requireFrontmost(appId: string) {
  const apps = Schema.decodeUnknownSync(Schema.Array(ComputerApp))(
    await request({ op: "listApps" }),
  );
  assert(
    apps.filter((app) => app.frontmost).length === 1 &&
      apps.some((app) => app.frontmost && app.appId === appId),
  );
}
async function verifyPixels(
  image: ComputerScreenshot,
  rectangles: {
    secureRect?: { x: number; y: number; width: number; height: number };
    blueRect?: { x: number; y: number; width: number; height: number };
    greenRect?: { x: number; y: number; width: number; height: number };
  },
) {
  return new Promise<{
    blueMarkerVisible: boolean;
    greenMarkerVisible: boolean;
    secureMasked: boolean;
  }>((done, reject) => {
    const child = execFile(
      captureVerifier,
      [],
      { timeout: 10000, maxBuffer: 2048 },
      (error, stdout) => {
        if (error) return reject(new Error("Pixel verifier failed."));
        try {
          done(JSON.parse(stdout));
        } catch {
          reject(new Error("Invalid pixel verification."));
        }
      },
    );
    child.stdin?.end(
      JSON.stringify({
        data: image.data,
        mimeType: image.mimeType,
        requireBlue: false,
        ...rectangles,
      }),
    );
  });
}
async function capture(displayId: string) {
  return Schema.decodeUnknownSync(ComputerScreenshot)(
    await request({ op: "screenshot", displayId }),
  );
}
try {
  const repo = resolve(import.meta.dirname, "../../../..");
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      [
        ["rehearsal", import.meta.filename],
        ["protection", join(import.meta.dirname, "rehearsalProtection.ts")],
        ["browserFixture", join(import.meta.dirname, "rehearsalBrowserFixture.ts")],
        ["apps", join(nativeSource, "ProtectionAppVerifier.swift")],
        ["pixels", join(nativeSource, "CaptureVerifier.swift")],
        ["excludedFixture", join(nativeSource, "ComputerControlFixture.swift")],
        ["chromeExecutable", chromeBinary],
        ["helper", resolve(helperPath)],
      ].map(async ([name, file]) => [
        name!,
        createHash("sha256")
          .update(await readFile(file!))
          .digest("hex"),
      ]),
    ),
  );
  metadata = {
    repositoryCommit: (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim(),
    workingTreeDirty: Boolean(
      (await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout.trim(),
    ),
    sourceHashes,
  };
  const chromeVersion = (
    await exec(
      "/usr/libexec/PlistBuddy",
      [
        "-c",
        "Print :CFBundleShortVersionString",
        "/Applications/Google Chrome.app/Contents/Info.plist",
      ],
      { timeout: 5000, maxBuffer: 1024 },
    )
  ).stdout.trim();
  assert(/^\d{1,4}(\.\d{1,8}){1,4}$/.test(chromeVersion));
  metadata.chromeVersion = chromeVersion;
  await prepareRehearsalExecutable(
    join(nativeSource, "ProtectionAppVerifier.swift"),
    appVerifier,
    fixtureBinDirectory,
  );
  await prepareRehearsalExecutable(
    join(nativeSource, "CaptureVerifier.swift"),
    captureVerifier,
    fixtureBinDirectory,
  );
  await check("Terminal and Chrome initially closed", async () => {
    const pids = await appPids();
    assert(
      pids[BROWSER_PROTECTION_IDS.terminal]?.length === 0 &&
        pids[BROWSER_PROTECTION_IDS.browser]?.length === 0,
    );
  });
  helper.start();
  stage = "helper-startup";
  await waitFor(() => helper.status().available, 5000);
  const status = helper.status();
  if (status.available) metadata.displayGeometry = status.displays;
  setGrants([{ appId: BROWSER_PROTECTION_IDS.terminal, tier: "click", allowTyping: false }]);
  helper.control({ type: "permit", executionGeneration: 1, expiresInMs: 1000 });
  helper.control({ type: "resume", executionGeneration: 1 });
  renewal = setInterval(
    () => helper.control({ type: "permit", executionGeneration: 1, expiresInMs: 1000 }),
    250,
  );
  await check("Granted click-tier Terminal opens and is inspectable", async () => {
    terminalLaunchAttempted = true;
    await request({ op: "openApp", appId: BROWSER_PROTECTION_IDS.terminal });
    await waitFor(async () => (await appPids())[BROWSER_PROTECTION_IDS.terminal]?.length === 1);
    startedTerminalPid = (await appPids())[BROWSER_PROTECTION_IDS.terminal]![0];
    const tree = await inspect(BROWSER_PROTECTION_IDS.terminal);
    assert(tree.accessible && tree.nodes.length > 0);
  });
  await check("Terminal without typing grant rejects keyboard input", async () => {
    await requireFrontmost(BROWSER_PROTECTION_IDS.terminal);
    await requireRefusal({ op: "type", text: "F5_REJECTED_INPUT" }, "typing-grant");
    await requireFrontmost(BROWSER_PROTECTION_IDS.terminal);
  });
  await check("Terminal without typing grant rejects semantic setValue", async () => {
    const tree = await inspect(BROWSER_PROTECTION_IDS.terminal);
    const target = tree.nodes.find((node) => node.role === "AXTextArea");
    assert(target);
    await requireRefusal(
      {
        op: "elementAction",
        appId: tree.appId,
        snapshotId: tree.snapshotId,
        elementRef: target.elementRef,
        action: "setValue",
        value: "F5_REJECTED_INPUT",
      },
      "typing-grant",
    );
  });
  const browserGrant: ComputerGrant = {
    appId: BROWSER_PROTECTION_IDS.browser,
    tier: "full",
    allowTyping: false,
  };
  stage = "isolated-browser-setup";
  const excludedId = `org.example.protection-excluded.${randomUUID()}`;
  const excludedGrant: ComputerGrant = { appId: excludedId, tier: "full", allowTyping: false };
  setGrants([browserGrant, excludedGrant]);
  browserFixture = await createBrowserProtectionFixture();
  // Fixed isolated profile; no Chrome automation port, extension or default-profile state.
  chrome = spawn(
    chromeBinary,
    protectionChromeArguments(join(root, "chrome-profile"), browserFixture.url, "desktop"),
    { stdio: "ignore" },
  );
  chrome.on("error", () => {
    /* Prerequisite wait fails without leaking raw errors. */
  });
  startedChromePid = chrome.pid;
  await waitFor(async () => {
    const pids = (await appPids())[BROWSER_PROTECTION_IDS.browser];
    browserOwnedProcessObserved ||= pids?.length === 1 && pids[0] === chrome?.pid;
    return pids?.length === 1 && pids[0] === chrome?.pid && browserFixture?.state()?.ready === true;
  });
  await request({ op: "activateApp", appId: BROWSER_PROTECTION_IDS.browser });
  await waitFor(() => browserFixture?.state()?.secureFocused === true);
  let browserSnapshot: ComputerInspectResult | undefined;
  await check(
    "Chrome inspection identifies the synthetic secure field and omits its value",
    async () => {
      browserSnapshot = await inspect(BROWSER_PROTECTION_IDS.browser);
      assert(browserSecureInspection(browserSnapshot));
    },
  );
  await check("Chrome secure semantic setValue is refused", async () => {
    assert(browserSnapshot);
    const secure = browserSnapshot.nodes.find((node) => node.name === BROWSER_SECURE_LABEL)!;
    await requireRefusal(
      {
        op: "elementAction",
        appId: browserSnapshot.appId,
        snapshotId: browserSnapshot.snapshotId,
        elementRef: secure.elementRef,
        action: "setValue",
        value: "F5_REJECTED_INPUT",
      },
      "secure-field",
    );
  });
  await check(
    "Focused Chrome password refuses keyboard typing with unchanged DOM value",
    async () => {
      await requireFrontmost(BROWSER_PROTECTION_IDS.browser);
      const state = browserFixture?.state();
      assert(state?.secureFocused && state.secureUnchanged && state.inputEvents === 0);
      await requireRefusal({ op: "type", text: "F5_REJECTED_INPUT" }, "secure-field");
      await delay(350);
      const after = performance.now();
      await waitFor(() => (browserFixture?.lastObservationAt() ?? 0) > after);
      await requireFrontmost(BROWSER_PROTECTION_IDS.browser);
      const afterState = browserFixture?.state();
      assert(
        afterState?.secureFocused && afterState.secureUnchanged && afterState.inputEvents === 0,
      );
    },
  );
  stage = "capture-fixture-setup";
  browserSnapshot = await inspect(BROWSER_PROTECTION_IDS.browser);
  const secure = browserSnapshot.nodes.find((node) => node.name === BROWSER_SECURE_LABEL);
  const marker = browserSnapshot.nodes.find((node) => node.name === BROWSER_MARKER_LABEL);
  metadata.captureTargets = {
    secureBoundsKnown: Boolean(secure?.bounds),
    browserMarkerBoundsKnown: Boolean(marker?.bounds),
    secureDisplayId: secure?.displayId,
    browserMarkerDisplayId: marker?.displayId,
  };
  assert(secure?.displayId);
  excluded = await createRehearsalFixture({
    root,
    appId: excludedId,
    ungranted: true,
    background: true,
    displayId: secure.displayId,
    ...(fixtureBinDirectory ? { preparedDirectory: fixtureBinDirectory } : {}),
  });
  const excludedSnapshot = await inspect(excludedId);
  const green = excludedSnapshot.nodes.find((node) => node.name === "Rehearsal capture marker");
  metadata.captureTargets = {
    secureBoundsKnown: Boolean(secure?.bounds),
    browserMarkerBoundsKnown: Boolean(marker?.bounds),
    fixtureMarkerBoundsKnown: Boolean(green?.bounds),
    secureDisplayId: secure?.displayId,
    browserMarkerDisplayId: marker?.displayId,
    fixtureMarkerDisplayId: green?.displayId,
  };
  await check("Capture targets have known bounds on the same display", async () => {
    assert(
      secure?.bounds &&
        secure.displayId &&
        marker?.bounds &&
        green?.bounds &&
        secure.displayId === marker.displayId &&
        secure.displayId === green.displayId,
    );
  });
  // Revalidate below even when the earlier check established the bounds.
  assert(secure.bounds && marker?.bounds && green?.bounds);
  const rects = { secureRect: secure.bounds, blueRect: marker.bounds, greenRect: green.bounds };
  await check(
    "Capture positive control includes both granted markers and masks Chrome password",
    async () => {
      const pixels = await verifyPixels(await capture(secure.displayId!), rects);
      assert(pixels.blueMarkerVisible && pixels.greenMarkerVisible && pixels.secureMasked);
    },
  );
  setGrants([browserGrant]);
  await check("Revoked app inspection is refused", async () => {
    await requireRefusal({ op: "inspect", appId: excludedId, maxNodes: 100 }, "view-grant");
  });
  await check(
    "Capture omits revoked app marker while preserving browser marker and secure mask",
    async () => {
      const image = await capture(secure.displayId!);
      const pixels = await verifyPixels(image, rects);
      assert(
        image.hiddenContent &&
          pixels.blueMarkerVisible &&
          !pixels.greenMarkerVisible &&
          pixels.secureMasked,
      );
    },
  );
  await check("Chrome password zoom is masked", async () => {
    const image = Schema.decodeUnknownSync(ComputerScreenshot)(
      await request({ op: "zoom", displayId: secure.displayId!, rect: secure.bounds! }),
    );
    const pixels = await verifyPixels(image, { secureRect: { x: 0, y: 0, ...image.modelSize } });
    assert(pixels.secureMasked);
  });
  setGrants([]);
  await check("Revoked browser inspection and capture exclude its fixture", async () => {
    await requireRefusal(
      { op: "inspect", appId: BROWSER_PROTECTION_IDS.browser, maxNodes: 100 },
      "view-grant",
    );
    const image = await capture(secure.displayId!);
    const pixels = await verifyPixels(image, {
      blueRect: rects.blueRect,
      greenRect: rects.greenRect,
    });
    assert(image.hiddenContent && !pixels.blueMarkerVisible && !pixels.greenMarkerVisible);
  });
  stage = "finished";
} catch {
  failureStage = stage;
  process.exitCode = 1;
} finally {
  clearInterval(renewal);
  await helper.suspend();
  const helperClosed = await helper.closeAndWait();
  const fixtureClosed = await closeRehearsalChild(excluded?.child);
  if (terminalLaunchAttempted && !startedTerminalPid) retainedTerminal = true;
  // Never force-quit or adopt a pre-existing app. If physical input occurred or
  // a process cannot be identified/closed, retain it and its private state.
  for (const [id, pid] of [
    [BROWSER_PROTECTION_IDS.terminal, startedTerminalPid],
    [BROWSER_PROTECTION_IDS.browser, startedChromePid],
  ] as const) {
    if (!pid) continue;
    if (!physicalInterruption) {
      await exec(appVerifier, ["--terminate-owned", id, String(pid)], {
        timeout: 5000,
        maxBuffer: 2048,
      }).catch(() => undefined);
      const deadline = performance.now() + 5000;
      while (
        performance.now() < deadline &&
        (await appPids().catch(() => ({}) as Record<string, number[]>))[id]?.includes(pid)
      )
        await delay(50);
    }
    const pids = await appPids().catch(() => undefined);
    const retained =
      !pids ||
      pids[id]?.includes(pid) === true ||
      (id === BROWSER_PROTECTION_IDS.browser &&
        chrome?.exitCode === null &&
        chrome.signalCode === null);
    if (id === BROWSER_PROTECTION_IDS.terminal) retainedTerminal = retained;
    else retainedChrome = retained;
  }
  await browserFixture?.close();
  if (retainedChrome)
    process.stdout.write(
      `Private Chrome test profile retained at ${join(root, "chrome-profile")}; close the test browser before removing it.\n`,
    );
  else await rm(root, { recursive: true, force: true });
  // The retained browser belongs to the operator now. Do not keep the completed
  // CLI alive merely because its child-process handle is still referenced.
  if (retainedChrome) chrome?.unref();
  const passed =
    !failureStage &&
    !physicalInterruption &&
    checks.length === 13 &&
    checks.every((item) => item.state === "passed") &&
    browserFixture?.observation().stateRejected === false &&
    !retainedChrome &&
    !retainedTerminal;
  const cleanup = {
    helperClosed,
    fixtureClosed,
    appsClosed: !retainedChrome && !retainedTerminal,
    confirmed: helperClosed && fixtureClosed && !retainedChrome && !retainedTerminal,
  };
  await writeFile(
    resolve(output),
    JSON.stringify(
      {
        reportVersion: 1,
        admissionId: process.env.F5_COMPUTER_CERTIFICATION_ADMISSION,
        recordedAt: new Date().toISOString(),
        ...metadata,
        platform: process.platform,
        arch: process.arch,
        osVersion: release(),
        scope: "unsigned-native-helper-terminal-and-isolated-chrome-protection",
        signed: false,
        certified: false,
        state: passed && cleanup.confirmed ? "passed" : "failed",
        cleanup,
        ...(failureStage ? { failureStage } : {}),
        physicalInterruption,
        retainedTerminal,
        retainedChrome,
        mockKeychain: true,
        browserStartup: {
          ...browserFixture?.observation(),
          ownedProcessObserved: browserOwnedProcessObserved,
          launcherExited: !!chrome && (chrome.exitCode !== null || chrome.signalCode !== null),
          launcherSignal: chrome?.signalCode ?? null,
        },
        browserFixture: browserFixture?.state()
          ? {
              secureValueUnchanged: browserFixture.state()!.secureUnchanged,
              inputEvents: browserFixture.state()!.inputEvents,
            }
          : undefined,
        checks,
        limitations: [
          "Scripted native-helper grants and permit; no F5 renderer consent, provider transport, overlay or cross-profile proof",
          "Fresh local Chrome fixture/profile with test-only mock keychain; no real keychain, autofill, signed-in sites, extensions, popups or arbitrary browser/app trees tested",
          "Single display, fixed app windows; no moving-window, multi-display, system-surface or complete capture privacy matrix",
          "Terminal typing remains disabled; no command, chord or allow-typing workflow tested",
          "Unsigned development helper only; signed installed-build attribution, Windows runtime and all release gates remain pending",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    `Protection check finished. You can use your computer again. Report: ${resolve(output)} (${passed ? "passed" : "failed"}; release gates unchanged).\n`,
  );
  if (!passed) process.exitCode = 1;
}
