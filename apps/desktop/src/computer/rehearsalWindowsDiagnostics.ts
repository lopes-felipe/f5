import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import type {
  ComputerAutomationBackendStatus,
  ComputerAutomationRequest,
} from "@t3tools/contracts";
import type { ComputerHelperClient } from "./ComputerHelperClient";

const UNAVAILABLE_REASONS = new Set([
  "not-certified",
  "unsupported-platform",
  "missing-permissions",
  "disabled",
  "no-host",
  "helper-missing",
  "helper-crashed",
  "os-too-old",
  "monitor-unhealthy",
  "other-instance",
]);
const FOREGROUND_REASONS = new Set([
  "unsupported-in-background",
  "unsupported-app",
  "window-unavailable",
  "typing-unsupported",
  "activation-side-effect",
]);
const ERROR_TAGS = new Set([
  "Unavailable",
  "Busy",
  "Interrupted",
  "OutcomeUnknown",
  "NotGranted",
  "TargetBlocked",
  "ForegroundRequired",
  "GeometryChanged",
  "StaleElement",
  "UnsupportedAction",
  "ReplayRejected",
  "PayloadMismatch",
  "ResultTooLarge",
  "Execution",
]);
const ERROR_KINDS = new Set([
  "f5",
  "system-ui",
  "elevated",
  "secure-field",
  "focus-unknown",
  "owner-unknown",
  "protection-unknown",
  "user-active",
  "foreground-busy",
  "other-app",
]);
const ERROR_CAUSES = new Set([
  "paused",
  "user-input",
  "access-changed",
  "permit-expired",
  "turn-ended",
]);
const FIXED_FAILURES: Readonly<Record<string, string>> = {
  "Synthetic fixture startup timed out.": "fixture-startup-timeout",
  "Synthetic fixture exited before becoming ready.": "fixture-exited-before-ready",
  "Synthetic fixture receipt overflow.": "fixture-receipt-overflow",
  "Windows fixture must be inside its isolated rehearsal directory.": "fixture-path-invalid",
  "helper-handshake-timeout": "helper-handshake-timeout",
  "inspection-incomplete": "inspection-incomplete",
  "invalid-inspection": "invalid-inspection",
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Diagnostic selection never updates the suite or supplies acceptance evidence. */
export function windowsDiagnosticIdentity(
  manifest: unknown,
  currentHelperSha256: string,
  selectedHelperSha256?: string,
) {
  const sha = (value: unknown): value is string =>
    typeof value === "string" && /^[a-fA-F0-9]{64}$/.test(value);
  const suiteHash =
    isRecord(manifest) && isRecord(manifest.identity) && isRecord(manifest.identity.files)
      ? manifest.identity.files.helper
      : undefined;
  if (!sha(suiteHash) || !sha(currentHelperSha256)) throw new Error("invalid-helper-identity");
  if (selectedHelperSha256 !== undefined && !sha(selectedHelperSha256))
    throw new Error("invalid-helper-identity");
  const suiteHelperSha256 = suiteHash.toLowerCase();
  const selected = (selectedHelperSha256 ?? suiteHelperSha256).toLowerCase();
  const current = currentHelperSha256.toLowerCase();
  return {
    suiteHelperSha256,
    selectedHelperSha256: selected,
    currentHelperSha256: current,
    matchesSuiteHelper: current === suiteHelperSha256,
    matchesSelectedHelper: current === selected,
  };
}

/** Fixed vocabulary only. Never publish error messages, paths, stacks or tool IO. */
export function windowsDiagnosticFailure(error: unknown) {
  if (isRecord(error) && isRecord(error.error) && ERROR_TAGS.has(String(error.error._tag))) {
    const value = error.error;
    return {
      code: String(value._tag),
      ...(typeof value.kind === "string" && ERROR_KINDS.has(value.kind)
        ? { kind: value.kind }
        : {}),
      ...(typeof value.reason === "string" &&
      (UNAVAILABLE_REASONS.has(value.reason) || FOREGROUND_REASONS.has(value.reason))
        ? { reason: value.reason }
        : {}),
      ...(typeof value.cause === "string" && ERROR_CAUSES.has(value.cause)
        ? { cause: value.cause }
        : {}),
    };
  }
  if (error instanceof Error) {
    const code = isRecord(error) ? error.code : undefined;
    if (
      typeof code === "string" &&
      ["ENOENT", "EACCES", "EPERM", "ENOEXEC", "ETIMEDOUT"].includes(code)
    )
      return { code };
    if (Object.hasOwn(FIXED_FAILURES, error.message))
      return { code: FIXED_FAILURES[error.message]! };
  }
  return { code: "diagnostic-failed" };
}
export function windowsDiagnosticStatus(status: ComputerAutomationBackendStatus) {
  return status.available
    ? {
        available: true as const,
        passwordMaskingSupported: status.passwordMaskingSupported === true,
      }
    : {
        available: false as const,
        reason: UNAVAILABLE_REASONS.has(status.reason) ? status.reason : "unknown",
      };
}
export function windowsInspectionFacts(result: unknown) {
  if (
    !isRecord(result) ||
    typeof result.accessible !== "boolean" ||
    !Array.isArray(result.nodes) ||
    result.nodes.length > 800
  )
    throw new Error("invalid-inspection");
  const nodes = result.nodes;
  if (
    !nodes.every(
      (node) =>
        isRecord(node) &&
        typeof node.name === "string" &&
        typeof node.enabled === "boolean" &&
        Array.isArray(node.actions),
    )
  )
    throw new Error("invalid-inspection");
  return {
    accessible: result.accessible,
    truncated: result.truncated === true,
    nodeCount: nodes.length,
    pressButtonCount: nodes.filter(
      (node) => node.name === "Rehearsal press" && node.actions.includes("press"),
    ).length,
    editableCount: nodes.filter((node) => node.enabled && node.actions.includes("setValue")).length,
    secureSentinelAbsent: !JSON.stringify(result).includes("F5_SYNTHETIC_PASSWORD_SENTINEL"),
  };
}
/** Read-only startup settling for owned synthetic fixtures. Never retries a
 * mutation, a native error, malformed data or a detected secure sentinel. */
export async function settleWindowsFixtureInspection<T>(
  read: () => Promise<T>,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
) {
  for (let attempt = 1; ; attempt++) {
    const tree = await read();
    const facts = windowsInspectionFacts(tree);
    if (
      !facts.secureSentinelAbsent ||
      (facts.accessible && facts.pressButtonCount > 0 && facts.editableCount > 0) ||
      attempt >= 6
    )
      return { tree, attempts: attempt };
    await wait(200);
  }
}

type DiagnosticHelper = Pick<
  ComputerHelperClient,
  "start" | "status" | "capabilities" | "onEvent" | "control" | "request" | "closeAndWait"
>;
interface DiagnosticFixture {
  executable: string;
  close(): Promise<boolean>;
}
export interface WindowsInspectionDependencies {
  helper: DiagnosticHelper;
  fixture(name: string, ungranted: boolean): Promise<DiagnosticFixture>;
  payload(request: Omit<ComputerAutomationRequest, "payloadHash">): string;
  waitUntilReady?: () => Promise<void>;
}
/** Deliberately has no mutation stage. Grants are for owned synthetic fixtures
 * only. It never issues permits, resume, capture, activation or input requests. */
export async function diagnoseWindowsInspection(root: string, deps: WindowsInspectionDependencies) {
  const fixtures: DiagnosticFixture[] = [];
  let stage = "fixture-approved-start";
  let failure: ReturnType<typeof windowsDiagnosticFailure> | undefined;
  let facts: ReturnType<typeof windowsInspectionFacts> | undefined;
  let helperStatus: ReturnType<typeof windowsDiagnosticStatus> | undefined;
  let backgroundCapability = false;
  let helperVersion: string | undefined;
  let interrupted = false;
  let fixtureStartupPending = false;
  const off = deps.helper.onEvent((event) => {
    if (
      event.type === "hello" &&
      typeof event.helperVersion === "string" &&
      /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(event.helperVersion)
    )
      helperVersion = event.helperVersion;
    if (event.type === "physicalInput" || event.type === "killSwitch") interrupted = true;
  });
  try {
    for (const name of ["approved", "other-app", "ungranted"]) {
      stage = "fixture-" + name + "-start";
      fixtureStartupPending = true;
      fixtures.push(await deps.fixture(name, name === "ungranted"));
      fixtureStartupPending = false;
    }
    stage = "helper-handshake";
    deps.helper.start();
    if (deps.waitUntilReady) await deps.waitUntilReady();
    else {
      const end = Date.now() + 5000;
      while (!deps.helper.status().available) {
        if (Date.now() >= end) throw new Error("helper-handshake-timeout");
        await new Promise<void>((done) => setTimeout(done, 20));
      }
    }
    backgroundCapability = deps.helper.capabilities().includes("background-ax-v1");
    const appId = fixtures[0]!.executable.toLowerCase();
    const authorization = {
      profileId: "windows-inspection-diagnostic",
      threadId: randomUUID(),
      sessionGeneration: randomUUID(),
      turnId: "inspection-only",
      executionGeneration: 1,
      grantVersion: 1,
      grants: fixtures.slice(0, 2).map((fixture) => ({
        appId: fixture.executable.toLowerCase(),
        tier: "full" as const,
        allowTyping: false,
      })),
    };
    stage = "native-inspection";
    deps.helper.control({ type: "grantsChanged", authorization });
    const request = {
      op: "inspect" as const,
      appId,
      maxNodes: 800,
      authorization,
      requestId: randomUUID(),
      deadlineAtMs: Date.now() + 9000,
      agent: { provider: "codex" as const, threadTitle: "Synthetic Windows inspection diagnostic" },
    };
    const result = await deps.helper.request(
      {
        ...request,
        payloadHash: createHash("sha256").update(deps.payload(request)).digest("hex"),
      },
      { f5Pids: [process.pid], f5BundlePath: join(root, "protected-f5"), overlayWindowIds: [] },
    );
    facts = windowsInspectionFacts(result);
    if (
      !facts.accessible ||
      facts.pressButtonCount === 0 ||
      facts.editableCount === 0 ||
      !facts.secureSentinelAbsent
    )
      throw new Error("inspection-incomplete");
    stage = "inspection-complete";
  } catch (error) {
    failure = windowsDiagnosticFailure(error);
  } finally {
    helperStatus = windowsDiagnosticStatus(deps.helper.status());
    off();
  }
  const helperClosed = await deps.helper.closeAndWait().catch(() => false);
  const fixturesClosed = await Promise.all(
    fixtures.map((fixture) => fixture.close().catch(() => false)),
  );
  const cleanup = {
    confirmed: helperClosed && !fixtureStartupPending && fixturesClosed.every(Boolean),
    helperClosed,
    fixturesClosed: fixturesClosed.every(Boolean),
    fixtureStartupConfirmed: !fixtureStartupPending,
  };
  return {
    reportVersion: 1,
    scope: "windows-native-inspection-diagnostic",
    platform: process.platform,
    arch: process.arch,
    state: !failure && !interrupted && cleanup.confirmed ? "passed" : "failed",
    stage,
    fixtureCount: fixtures.length,
    helperStatus,
    backgroundCapability,
    ...(helperVersion ? { helperVersion } : {}),
    ...(facts ? { inspection: facts } : {}),
    ...(failure ? { failure } : {}),
    physicalInterruption: interrupted,
    cleanup,
    safety: { permitsSent: false, resumesSent: false, inputSent: false, capturesTaken: false },
  };
}

if (import.meta.main) {
  let root: string | undefined;
  let identity: ReturnType<typeof windowsDiagnosticIdentity> | undefined;
  try {
    if (process.platform !== "win32" || process.arch !== "x64") throw new Error("windows-required");
    const args = process.argv.slice(2);
    const argument = (name: string) =>
      args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
    const checkout = argument("--checkout"),
      suite = argument("--suite");
    if (!checkout || !suite) throw new Error("checkout-and-suite-required");
    const repo = resolve(checkout),
      prepared = join(resolve(suite), "fixtures");
    const helperPath = join(repo, "apps/desktop/dist-native/win-x64/f5-computer-helper.exe");
    const manifest = JSON.parse(await readFile(join(resolve(suite), "manifest.json"), "utf8"));
    const actualHash = createHash("sha256")
      .update(await readFile(helperPath))
      .digest("hex");
    identity = windowsDiagnosticIdentity(manifest, actualHash, argument("--helper-sha256"));
    if (!identity.matchesSelectedHelper) throw new Error("helper-identity-mismatch");
    const load = (name: string) => import(pathToFileURL(join(repo, name)).href);
    const [
      { ComputerHelperClient },
      { createRehearsalFixture },
      { closeRehearsalChild },
      { computerRequestPayload },
    ] = await Promise.all([
      load("apps/desktop/src/computer/ComputerHelperClient.ts"),
      load("apps/desktop/src/computer/rehearsalFixture.ts"),
      load("apps/desktop/src/computer/rehearsalCleanup.ts"),
      load("packages/shared/src/computerControl.ts"),
    ]);
    root = await mkdtemp(join(tmpdir(), "f5-inspection-diagnostic-"));
    const fixtureRoot = root;
    const report = await diagnoseWindowsInspection(root, {
      helper: new ComputerHelperClient(dirname(helperPath), helperPath),
      fixture: async (name, ungranted) => {
        const fixture = await createRehearsalFixture({
          root: fixtureRoot,
          appId: join(fixtureRoot, name, "ComputerControlFixture.exe").toLowerCase(),
          preparedDirectory: prepared,
          ungranted,
        });
        return { executable: fixture.executable, close: () => closeRehearsalChild(fixture.child) };
      },
      payload: computerRequestPayload,
    });
    const helperUnchanged = await readFile(helperPath).then(
      (bytes) => createHash("sha256").update(bytes).digest("hex") === actualHash,
      () => false,
    );
    const temporaryFilesRemoved = report.cleanup.confirmed
      ? await rm(root, { recursive: true, force: true }).then(
          () => true,
          () => false,
        )
      : false;
    process.stdout.write(
      JSON.stringify(
        {
          ...report,
          state: helperUnchanged ? report.state : "failed",
          diagnosticOnly: true,
          identity: { ...identity, helperUnchanged },
          temporaryFilesRemoved,
          helperSha256: actualHash,
          recordedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
    if (report.state !== "passed" || !helperUnchanged) process.exitCode = 1;
  } catch (error) {
    const known =
      error instanceof Error &&
      [
        "windows-required",
        "checkout-and-suite-required",
        "helper-identity-mismatch",
        "invalid-helper-identity",
      ].includes(error.message)
        ? error.message
        : windowsDiagnosticFailure(error).code;
    process.stdout.write(
      JSON.stringify(
        {
          state: "failed",
          stage: "diagnostic-setup",
          diagnosticOnly: true,
          ...(identity ? { identity } : {}),
          failure: { code: known },
          safety: {
            permitsSent: false,
            resumesSent: false,
            inputSent: false,
            capturesTaken: false,
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.exitCode = 1;
  }
}
