import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type {
  ComputerAuthorization,
  ComputerAutomationOperation,
  ComputerAutomationRequest,
  ComputerInspectResult,
  ComputerLeaseScope,
  ComputerScreenshot,
} from "@t3tools/contracts";
import { ComputerControlError, computerRequestPayload } from "@t3tools/shared/computerControl";
import { ComputerHelperClient } from "./ComputerHelperClient";
import { createRehearsalFixture } from "./rehearsalFixture";
import { closeRehearsalChild } from "./rehearsalCleanup";
import { WindowsWorkflowTrace } from "./rehearsalWindowsTrace";
import {
  windowsDiagnosticFailure,
  windowsDiagnosticStatus,
  windowsInspectionFacts,
  settleWindowsFixtureInspection,
} from "./rehearsalWindowsDiagnostics";

const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const helperPath = arg("--helper");
const output = arg("--output");
const preparedDirectory = arg("--fixture-bin-dir");
if (
  process.platform !== "win32" ||
  process.env.F5_COMPUTER_WINDOWS_REHEARSAL !== "1" ||
  !helperPath ||
  !output ||
  !preparedDirectory
) {
  throw new Error(
    "Run on an interactive Windows desktop with F5_COMPUTER_WINDOWS_REHEARSAL=1, --helper, --fixture-bin-dir and a new --output path.",
  );
}
await writeFile(resolve(output), "", { flag: "wx", mode: 0o600 });
const root = await mkdtemp(join(tmpdir(), "f5-windows-computer-"));
const helper = new ComputerHelperClient(dirname(resolve(helperPath)), resolve(helperPath));
const fixtures: Awaited<ReturnType<typeof createRehearsalFixture>>[] = [];
const checks: Record<string, boolean> = {};
const generations = new Map<number, ComputerLeaseScope>();
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function until(check: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Windows rehearsal timed out");
    await wait(20);
  }
}
function assert(value: unknown) {
  if (!value) throw new Error("Windows rehearsal assertion failed");
}
let interrupted = false;
let cleanupConfirmed = false;
let failure = false;
let stage = "fixture-approved-start";
let failureDetails: ReturnType<typeof windowsDiagnosticFailure> | undefined;
let inspection: ReturnType<typeof windowsInspectionFacts> | undefined;
let inspectionAttempts = 0;
const trace = new WindowsWorkflowTrace();
const off = helper.onEvent((event) => {
  trace.event(event);
  if (event.type === "physicalInput" || event.type === "killSwitch") interrupted = true;
});
const renewal = setInterval(() => {
  if (!interrupted)
    for (const executionGeneration of generations.keys())
      helper.control({ type: "permit", executionGeneration, expiresInMs: 1000 });
}, 250);
let authorization: ComputerAuthorization = {
  profileId: "windows-native-rehearsal",
  threadId: randomUUID(),
  sessionGeneration: randomUUID(),
  turnId: "synthetic-workflow",
  executionGeneration: 1,
  grantVersion: 1,
  grants: [],
};
function arm(id: number, scope: ComputerLeaseScope) {
  if (interrupted)
    throw new Error(
      "Physical input interrupted the rehearsal; resume requires a fresh operator run.",
    );
  generations.set(id, scope);
  helper.control({ type: "permit", executionGeneration: id, expiresInMs: 1000, scope });
  helper.control({ type: "resume", executionGeneration: id, scope });
}
async function request<T = unknown>(
  op: ComputerAutomationOperation,
  fields: Record<string, unknown> = {},
  auth = authorization,
): Promise<T> {
  if (interrupted) throw new Error("Rehearsal interrupted");
  const value = {
    op,
    ...fields,
    authorization: auth,
    requestId: randomUUID(),
    deadlineAtMs: Date.now() + 9000,
    agent: { provider: "codex" as const, threadTitle: "Synthetic Windows helper acceptance" },
  } as Omit<ComputerAutomationRequest, "payloadHash">;
  trace.start(value);
  try {
    const result = await helper.request(
      {
        ...value,
        payloadHash: createHash("sha256").update(computerRequestPayload(value)).digest("hex"),
      } as ComputerAutomationRequest,
      { f5Pids: [process.pid], f5BundlePath: join(root, "protected-f5"), overlayWindowIds: [] },
    );
    trace.finish();
    return result as T;
  } catch (error) {
    trace.finish(error);
    throw error;
  }
}
async function refused(operation: () => Promise<unknown>, tag: string) {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof ComputerControlError && error.error._tag === tag);
    return;
  }
  throw new Error("Expected refusal");
}
try {
  for (const name of ["approved", "other-app", "ungranted"]) {
    stage = "fixture-" + name + "-start";
    fixtures.push(
      await createRehearsalFixture({
        root,
        appId: join(root, name, "ComputerControlFixture.exe").toLowerCase(),
        preparedDirectory,
        ...(name === "ungranted" ? { ungranted: true } : {}),
      }),
    );
  }
  const [first, second, ungranted] = fixtures;
  if (!first || !second || !ungranted) throw new Error("Fixture startup failed");
  const appId = first.executable.toLowerCase();
  const secondApp = second.executable.toLowerCase();
  authorization = {
    ...authorization,
    grants: [
      { appId, tier: "full", allowTyping: false },
      { appId: secondApp, tier: "full", allowTyping: false },
    ],
  };
  stage = "helper-handshake";
  helper.start();
  await until(() => helper.status().available);
  stage = "helper-capability";
  assert(helper.capabilities().includes("background-ax-v1"));
  helper.control({ type: "grantsChanged", authorization });
  stage = "native-inspection";
  const settled = await settleWindowsFixtureInspection(() =>
    request<ComputerInspectResult>("inspect", { appId, maxNodes: 800 }),
  );
  const tree = settled.tree;
  inspectionAttempts = settled.attempts;
  inspection = windowsInspectionFacts(tree);
  const button = tree.nodes.find(
    (node) => node.name === "Rehearsal press" && node.actions.includes("press"),
  );
  const input = tree.nodes.find((node) => node.actions.includes("setValue") && node.enabled);
  assert(button && input);
  assert(!JSON.stringify(tree).includes("F5_SYNTHETIC_PASSWORD_SENTINEL"));
  checks.nativeInspection = true;
  stage = "targeted-inspection";
  const subtree = await request<ComputerInspectResult>("inspect", {
    appId,
    maxNodes: 800,
    snapshotId: tree.snapshotId,
    elementRef: button!.elementRef,
  });
  assert(subtree.nodes.some((node) => node.name === "Rehearsal press"));
  checks.targetedInspection = true;
  stage = "grant-and-snapshot-isolation";
  await refused(
    () => request("inspect", { appId: ungranted.executable.toLowerCase(), maxNodes: 800 }),
    "NotGranted",
  );
  const foreign = { ...authorization, threadId: randomUUID() };
  helper.control({ type: "grantsChanged", authorization: foreign });
  await refused(
    () =>
      request(
        "inspect",
        { appId, maxNodes: 800, snapshotId: tree.snapshotId, elementRef: button!.elementRef },
        foreign,
      ),
    "StaleElement",
  );
  checks.grantAndSnapshotIsolation = true;
  stage = "foreground-unicode-and-press";
  arm(1, { kind: "foreground" });
  await request("elementAction", {
    appId,
    snapshotId: tree.snapshotId,
    elementRef: input!.elementRef,
    action: "setValue",
    value: "F5_ELECTRON_REHEARSAL Ω🙂",
  });
  await request("elementAction", {
    appId,
    snapshotId: tree.snapshotId,
    elementRef: button!.elementRef,
    action: "press",
  });
  await until(() => first.typed() && first.presses() === 1);
  checks.nativeUnicodeAndPress = true;
  stage = "capture-masking-metadata";
  const status = helper.status();
  assert(status.available && status.passwordMaskingSupported);
  if (!status.available || !status.displays?.length) throw new Error("No interactive display");
  for (const passwordMasking of ["fast", "conservative"]) {
    const image = await request<ComputerScreenshot>("screenshot", {
      displayId: status.displays[0]!.displayId,
      passwordMasking,
    });
    assert(
      image.passwordMasking === passwordMasking &&
        image.data.length > 0 &&
        image.masked !== undefined,
    );
  }
  checks.captureMaskingMetadata = true;
  stage = "foreground-suspend";
  await helper.suspend(1);
  stage = "foreground-retire";
  helper.control({ type: "retire", executionGeneration: 1 });
  generations.delete(1);
  authorization = { ...authorization, executionGeneration: 2 };
  stage = "background-arm";
  arm(2, { kind: "app", appId });
  stage = "background-inspection";
  const background = await request<ComputerInspectResult>("inspect", {
    appId,
    maxNodes: 800,
    delivery: "background",
  });
  const press = background.nodes.find(
    (node) => node.name === "Rehearsal press" && node.actions.includes("press"),
  );
  assert(press);
  stage = "background-press";
  await request("elementAction", {
    appId,
    delivery: "background",
    snapshotId: background.snapshotId,
    elementRef: press!.elementRef,
    action: "press",
  });
  stage = "background-press-receipt";
  await until(() => first.presses() === 2);
  checks.backgroundSemanticAction = true;
  stage = "background-global-input-refusal";
  await refused(
    () => request("key", { delivery: "background", chords: ["Ctrl+A"], repeat: 1 }),
    "ForegroundRequired",
  );
  checks.backgroundRefusesGlobalInput = true;
  stage = "selective-pause";
  const secondAuth = { ...authorization, threadId: randomUUID(), executionGeneration: 3 };
  helper.control({ type: "grantsChanged", authorization: secondAuth });
  arm(3, { kind: "app", appId: secondApp });
  await helper.suspend(2);
  await refused(
    () =>
      request("elementAction", {
        appId,
        delivery: "background",
        snapshotId: background.snapshotId,
        elementRef: press!.elementRef,
        action: "press",
      }),
    "Interrupted",
  );
  const secondTree = await request<ComputerInspectResult>(
    "inspect",
    { appId: secondApp, maxNodes: 800, delivery: "background" },
    secondAuth,
  );
  const secondButton = secondTree.nodes.find(
    (node) => node.name === "Rehearsal press" && node.actions.includes("press"),
  );
  assert(secondButton);
  await request(
    "elementAction",
    {
      appId: secondApp,
      delivery: "background",
      snapshotId: secondTree.snapshotId,
      elementRef: secondButton!.elementRef,
      action: "press",
    },
    secondAuth,
  );
  await until(() => second.presses() === 1);
  checks.selectivePause = true;
  stage = "monitor-stability";
  const monitorUntil = Date.now() + 8000;
  while (Date.now() < monitorUntil) {
    assert(!interrupted && helper.status().available);
    await wait(25);
  }
  checks.monitorStability = true;
  stage = "helper-close";
  await helper.suspend();
  assert(await helper.closeAndWait());
  checks.helperExitConfirmed = true;
  stage = "complete";
} catch (error) {
  failure = true;
  failureDetails = windowsDiagnosticFailure(error);
} finally {
  const helperStatus = windowsDiagnosticStatus(helper.status());
  clearInterval(renewal);
  off();
  const helperClosed = await helper.closeAndWait();
  const fixtureClosed = await Promise.all(
    fixtures.map((fixture) => closeRehearsalChild(fixture.child)),
  );
  cleanupConfirmed = helperClosed && fixtureClosed.every(Boolean);
  if (cleanupConfirmed) await rm(root, { recursive: true, force: true });
  await writeFile(
    resolve(output),
    JSON.stringify(
      {
        reportVersion: 1,
        platform: process.platform,
        arch: process.arch,
        admissionId: process.env.F5_COMPUTER_CERTIFICATION_ADMISSION,
        recordedAt: new Date().toISOString(),
        helperSha256: createHash("sha256")
          .update(await readFile(resolve(helperPath)))
          .digest("hex"),
        state: !failure && !interrupted && cleanupConfirmed ? "passed" : "failed",
        scope: "windows-native-helper-workflow",
        diagnosticOnly: process.env.F5_COMPUTER_WINDOWS_WORKFLOW_DIAGNOSTIC === "1",
        checks,
        diagnostics: {
          stage,
          helperStatus,
          ...(inspection ? { inspection } : {}),
          inspectionAttempts,
          protocol: trace.report(),
          fixtureReceipts: fixtures.map((fixture) => ({
            presses: fixture.presses(),
            expectedSyntheticTextReceived: fixture.typed(),
          })),
        },
        ...(failureDetails ? { failure: failureDetails } : {}),
        physicalInterruption: interrupted,
        cleanup: { confirmed: cleanupConfirmed },
        limitations: [
          "Native helper evidence only; does not prove provider consent, capture pixel privacy, physical stop latency, signed packaging or monitor/display transitions.",
        ],
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
if (failure || interrupted || !cleanupConfirmed) process.exitCode = 1;
