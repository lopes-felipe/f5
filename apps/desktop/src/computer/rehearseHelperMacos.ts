import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { tmpdir, release } from "node:os";
import { performance } from "node:perf_hooks";
import type {
  ComputerAutomationRequest,
  ComputerInspectResult,
  ComputerScreenshot,
} from "@t3tools/contracts";
import { ComputerControlError } from "@t3tools/shared/computerControl";
import { ComputerHelperClient } from "./ComputerHelperClient";
import { createRehearsalFixture, prepareRehearsalExecutable } from "./rehearsalFixture";
import { closeRehearsalChild } from "./rehearsalCleanup";

const exec = promisify(execFile);
const args = process.argv.slice(2);
const argument = (name: string) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const helperPath = argument("--helper");
const output = argument("--output");
const fixtureBinDirectory = argument("--fixture-bin-dir");
const privacyOnly = args.includes("--privacy-only");
const sequencing = args.includes("--sequencing");
const sequenceText = "SYNTHETIC Ω🙂 input ".repeat(3);
if (process.platform !== "darwin" || !helperPath || !output) {
  process.stderr.write(
    "Usage on macOS: bun apps/desktop/src/computer/rehearseHelperMacos.ts --helper <development helper> --output <new report.json>\n",
  );
  process.exit(1);
}
// Refuse overwrite before launching or controlling anything.
await writeFile(resolve(output), "", { flag: "wx" });
const helper = new ComputerHelperClient(dirname(resolve(helperPath)), resolve(helperPath));
const checks: Array<{
  name: string;
  state: "passed" | "failed" | "blocked";
  elapsedMs?: number;
  outcome?: string;
  blockKind?: string;
}> = [];
let physicalInterruption = false;
const confirmations = new Map<string, number>();
const sequenceTimings: Array<{ op: string; completedAt: number; confirmedAt?: number }> = [];
let fixture: ReturnType<typeof spawn> | undefined;
let ungrantedFixture: ReturnType<typeof spawn> | undefined;
let renewal: ReturnType<typeof setInterval> | undefined;
const fixtureId = `org.example.computer-rehearsal.${randomUUID()}`;
const authorization = {
  profileId: "native-rehearsal",
  threadId: randomUUID(),
  sessionGeneration: randomUUID(),
  turnId: "rehearsal",
  executionGeneration: 1,
  grantVersion: 1,
  grants: [{ appId: fixtureId, tier: "full" as const, allowTyping: false }],
};
helper.onEvent((message) => {
  if (message.type === "actionConfirmed" && typeof message.requestId === "string")
    confirmations.set(message.requestId, performance.now());
  if (message.type === "physicalInput" || message.type === "killSwitch")
    physicalInterruption = true;
});
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function waitFor(condition: () => boolean, ms = 5000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error("Rehearsal condition timed out.");
    await pause(25);
  }
}
type ComputerOperation = ComputerAutomationRequest extends infer Request
  ? Request extends ComputerAutomationRequest
    ? Omit<Request, "requestId" | "payloadHash" | "authorization" | "deadlineAtMs" | "agent">
    : never
  : never;
const request = async <T = unknown>(
  payload: ComputerOperation,
  grants = authorization.grants,
): Promise<T> => {
  if (physicalInterruption)
    throw new Error("Physical input interrupted the rehearsal; it will not resume automatically.");
  const requestId = randomUUID();
  const result = await helper.request(
    {
      ...payload,
      requestId,
      payloadHash: "rehearsal",
      authorization: { ...authorization, grants },
      deadlineAtMs: Date.now() + 10000,
      agent: { provider: "codex", threadTitle: "Native helper rehearsal" },
    } as ComputerAutomationRequest,
    {
      f5Pids: [process.pid],
      f5BundlePath: join(tmpdir(), "f5-rehearsal-protected-host"),
      overlayWindowIds: [],
    },
  );
  const confirmedAt = confirmations.get(requestId);
  confirmations.delete(requestId);
  if (sequencing)
    sequenceTimings.push({
      op: payload.op,
      completedAt: performance.now(),
      ...(confirmedAt === undefined ? {} : { confirmedAt }),
    });
  return result as T;
};
async function check(name: string, run: () => Promise<void>): Promise<void> {
  process.stdout.write(`Checking: ${name}\n`);
  const started = performance.now();
  try {
    await run();
    checks.push({ name, state: "passed", elapsedMs: Math.round(performance.now() - started) });
  } catch (error) {
    if (error instanceof RehearsalAssertion) process.stderr.write(`${error.message}\n`);
    const outcome = error instanceof ComputerControlError ? error.error._tag : "RehearsalFailure";
    checks.push({
      name,
      state: "failed",
      outcome,
      ...(error instanceof ComputerControlError && error.error._tag === "TargetBlocked"
        ? { blockKind: error.error.kind }
        : {}),
      elapsedMs: Math.round(performance.now() - started),
    });
    throw error;
  }
}
class RehearsalAssertion extends Error {}
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new RehearsalAssertion(message);
};
let helperHash: string | null = null;
let repositoryCommit: string | undefined;
let workingTreeDirty: boolean | undefined;
let rehearsalSourceSha256: string | undefined;
let captureVerifierSha256: string | undefined;
let root: string | undefined;
try {
  const repo = resolve(import.meta.dirname, "../../../..");
  repositoryCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  workingTreeDirty = Boolean(
    (await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout.trim(),
  );
  rehearsalSourceSha256 = createHash("sha256")
    .update(await readFile(import.meta.filename))
    .digest("hex");
  captureVerifierSha256 = createHash("sha256")
    .update(
      await readFile(
        resolve(import.meta.dirname, "../../native/macos/Fixtures/CaptureVerifier.swift"),
      ),
    )
    .digest("hex");
  helperHash = createHash("sha256")
    .update(await readFile(resolve(helperPath)))
    .digest("hex");
  helper.start();
  await waitFor(() => helper.status().available);
  root = await mkdtemp(join(tmpdir(), "f5-native-rehearsal-"));
  await check(
    "A second helper with a different HOME cannot acquire the OS user's device lock",
    async () => {
      const second = await exec(resolve(helperPath), [], {
        env: { ...process.env, HOME: root },
        timeout: 5000,
        maxBuffer: 4096,
      });
      assert(
        second.stdout
          .split("\n")
          .filter(Boolean)
          .some((line) => {
            const message = JSON.parse(line) as { type: string; status?: { reason?: string } };
            return message.type === "status" && message.status?.reason === "other-instance";
          }),
        "The second helper acquired a separate device lock.",
      );
    },
  );
  const captureVerifier = join(root, "capture-verifier");
  await prepareRehearsalExecutable(
    resolve(import.meta.dirname, "../../native/macos/Fixtures/CaptureVerifier.swift"),
    captureVerifier,
    fixtureBinDirectory,
  );
  const verifyCapture = (
    image: ComputerScreenshot,
    secureRect?: { x: number; y: number; width: number; height: number },
    requireBlue = true,
    requireGreen = false,
  ): Promise<{ width: number; height: number }> =>
    new Promise((done, reject) => {
      const verifier = execFile(
        captureVerifier,
        [],
        { timeout: 10000, maxBuffer: 4096 },
        (error, stdout) => {
          if (error) return reject(new Error("Capture verifier failed."));
          try {
            const outcome = JSON.parse(stdout) as {
              grantedMarkerVisible: boolean;
              ungrantedMarkerAbsent: boolean;
              greenMarkerVisible: boolean;
              secureMasked: boolean;
              width: number;
              height: number;
            };
            assert(outcome.grantedMarkerVisible, "Granted fixture marker is missing.");
            assert(
              requireGreen ? outcome.greenMarkerVisible : outcome.ungrantedMarkerAbsent,
              requireGreen
                ? "Capture control fixture marker is missing."
                : "Ungranted fixture pixels leaked.",
            );
            assert(outcome.secureMasked, "Secure field pixels were not masked.");
            done(outcome);
          } catch (error) {
            reject(error);
          }
        },
      );
      verifier.stdin?.end(
        JSON.stringify({ data: image.data, mimeType: image.mimeType, secureRect, requireBlue }),
      );
    });
  const ungrantedFixtureId = `org.example.ungranted-rehearsal.${randomUUID()}`;
  const granted = await createRehearsalFixture({
    root,
    appId: fixtureId,
    ...(sequencing ? { delayedFocus: true, expectedText: sequenceText } : {}),
    ...(fixtureBinDirectory ? { preparedDirectory: fixtureBinDirectory } : {}),
  });
  fixture = granted.child;
  const excluded = await createRehearsalFixture({
    root,
    appId: ungrantedFixtureId,
    ungranted: true,
    executableSource: granted.executable,
  });
  ungrantedFixture = excluded.child;
  await pause(300);
  helper.control({ type: "grantsChanged", authorization });
  helper.control({ type: "permit", executionGeneration: 1, expiresInMs: 1000 });
  helper.control({ type: "resume", executionGeneration: 1 });
  renewal = setInterval(
    () => helper.control({ type: "permit", executionGeneration: 1, expiresInMs: 1000 }),
    250,
  );
  await check("Granted fixture app activation", async () => {
    await request({ op: "activateApp", appId: fixtureId });
  });
  let snapshot: ComputerInspectResult | undefined;
  await check("Real accessibility inspection and secure-value omission", async () => {
    snapshot = await request<ComputerInspectResult>({
      op: "inspect",
      appId: fixtureId,
      maxNodes: 100,
    });
    assert(snapshot.accessible && snapshot.nodes.length, "Fixture AX tree is unavailable.");
    assert(
      !JSON.stringify(snapshot).includes("SYNTHETIC_SECURE_SENTINEL"),
      "Secure value leaked into inspect.",
    );
    assert(
      snapshot.nodes.some(
        (node) =>
          node.name === "Rehearsal secure field" &&
          !node.actions.length &&
          node.value === undefined,
      ),
      "Secure element was not recognized.",
    );
  });
  await check(
    "Capture control includes both synthetic markers when both fixtures are granted",
    async () => {
      const secure = snapshot?.nodes.find((node) => node.name === "Rehearsal secure field");
      if (!secure?.bounds || !secure.displayId)
        throw new Error("Secure field geometry is missing.");
      authorization.grants.push({ appId: ungrantedFixtureId, tier: "full", allowTyping: false });
      authorization.grantVersion += 1;
      helper.control({ type: "grantsChanged", authorization });
      try {
        const image = await request<ComputerScreenshot>({
          op: "screenshot",
          displayId: secure.displayId,
        });
        await verifyCapture(image, secure.bounds, true, true);
      } finally {
        authorization.grants.pop();
        authorization.grantVersion += 1;
        helper.control({ type: "grantsChanged", authorization });
      }
    },
  );
  await check(
    "Capture includes granted pixels, excludes revoked fixture pixels and masks secure fields",
    async () => {
      const secure = snapshot?.nodes.find((node) => node.name === "Rehearsal secure field");
      if (!secure?.bounds || !secure.displayId)
        throw new Error("Secure field geometry is missing.");
      const image = await request<ComputerScreenshot>({
        op: "screenshot",
        displayId: secure.displayId,
      });
      assert(image.hiddenContent, "Capture did not report omitted windows.");
      await verifyCapture(image, secure.bounds);
    },
  );
  await check("Zoom masks secure fields and provides additional Retina detail", async () => {
    const secure = snapshot?.nodes.find((node) => node.name === "Rehearsal secure field");
    const status = helper.status();
    const display = status.available
      ? status.displays?.find((item) => item.displayId === secure?.displayId)
      : undefined;
    if (!secure?.bounds || !display) throw new Error("Secure field display is missing.");
    const image = await request<ComputerScreenshot>({
      op: "zoom",
      displayId: display.displayId,
      rect: secure.bounds,
    });
    const dimensions = await verifyCapture(image, { x: 0, y: 0, ...image.modelSize }, false);
    const captureScale = Math.min(
      1,
      2560 / Math.max(display.pixelSize.width, display.pixelSize.height),
    );
    if (display.pixelSize.width * captureScale > display.modelSize.width)
      assert(dimensions.width > secure.bounds.width, "Zoom added no capture detail.");
  });
  if (!privacyOnly) {
    await check("Semantic press reaches the real app", async () => {
      const current = snapshot;
      if (!current) throw new Error("Inspect did not return a snapshot.");
      const button = current.nodes.find(
        (node) => node.name === "Rehearsal press" && node.actions.includes("press"),
      );
      if (!button) throw new Error("Fixture button is missing.");
      await request({
        op: "elementAction",
        appId: fixtureId,
        snapshotId: current.snapshotId,
        elementRef: button.elementRef,
        action: "press",
      });
      await pause(100);
      const after = await request({ op: "inspect", appId: fixtureId, maxNodes: 100 });
      assert(JSON.stringify(after).includes("presses: 1"), "Press did not reach the fixture.");
    });
    await check("Secure semantic setValue is refused", async () => {
      const current = snapshot;
      const secure = current?.nodes.find((node) => node.name === "Rehearsal secure field");
      if (!current || !secure) throw new Error("Secure element is missing.");
      try {
        await request({
          op: "elementAction",
          appId: fixtureId,
          snapshotId: current.snapshotId,
          elementRef: secure.elementRef,
          action: "setValue",
          value: "SYNTHETIC_REHEARSAL_TEXT",
        });
      } catch (error) {
        assert(
          error instanceof ComputerControlError &&
            error.error._tag === "TargetBlocked" &&
            error.error.kind === "secure-field",
          "Unexpected refusal.",
        );
        return;
      }
      throw new Error("Secure field accepted setValue.");
    });
    await check("Revoked fixture inspect is refused", async () => {
      const revoked = { ...authorization, grantVersion: 2, grants: [] };
      helper.control({ type: "grantsChanged", authorization: revoked });
      try {
        await request({ op: "inspect", appId: fixtureId, maxNodes: 100 });
      } catch (error) {
        assert(
          error instanceof ComputerControlError && error.error._tag === "Interrupted",
          "Stale grant was accepted.",
        );
        return;
      } finally {
        authorization.grantVersion = 3;
        helper.control({ type: "grantsChanged", authorization });
      }
      throw new Error("Stale grant was accepted.");
    });
    await check("Unicode typing reaches only the fixture's editable field", async () => {
      const current = await request<ComputerInspectResult>({
        op: "inspect",
        appId: fixtureId,
        maxNodes: 100,
      });
      const field = current.nodes.find((node) => node.name === "Rehearsal input");
      if (!field) throw new Error("Editable field is missing.");
      const focused = await request<{ verification?: { verified: boolean } }>({
        op: "elementAction",
        appId: fixtureId,
        snapshotId: current.snapshotId,
        elementRef: field.elementRef,
        action: "focus",
      });
      if (sequencing) assert(focused.verification?.verified === true, "Focus was not confirmed.");
      const text = sequenceText;
      await request({ op: "type", text, ...(sequencing ? { appId: fixtureId } : {}) });
      if (sequencing) {
        await request({ op: "key", appId: fixtureId, chords: ["Enter"], repeat: 1 });
        await waitFor(granted.entered);
        const recent = sequenceTimings.slice(-3);
        const status = helper.status();
        if (status.available && status.displays?.length === 1) {
          for (let i = 1; i < recent.length; i++)
            assert(
              (recent[i]!.confirmedAt ?? -Infinity) - recent[i - 1]!.completedAt >= 275,
              "Helper input was posted before the deferred settling gap.",
            );
        }
      }
      const after = await request<ComputerInspectResult>({
        op: "inspect",
        appId: fixtureId,
        maxNodes: 100,
      });
      assert(
        after.nodes.some((node) => node.name === "Rehearsal input" && node.value === text),
        "Unicode typing did not reach the fixture.",
      );
    });
    await check("Protected system chord is refused without emitting input", async () => {
      try {
        await request({ op: "key", chords: ["cmd+space"], repeat: 1 });
      } catch (error) {
        assert(
          error instanceof ComputerControlError &&
            error.error._tag === "TargetBlocked" &&
            error.error.kind === "system-ui",
          "Unexpected chord result.",
        );
        return;
      }
      throw new Error("Protected chord was accepted.");
    });
    await check("Focused secure field rejects keyboard typing", async () => {
      const current = await request<ComputerInspectResult>({
        op: "inspect",
        appId: fixtureId,
        maxNodes: 100,
      });
      const button = current.nodes.find((node) => node.name === "Focus secure");
      if (!button) throw new Error("Secure-focus fixture button is missing.");
      await request({
        op: "elementAction",
        appId: fixtureId,
        snapshotId: current.snapshotId,
        elementRef: button.elementRef,
        action: "press",
      });
      try {
        await request({ op: "type", text: "SYNTHETIC_REJECTED_TEXT" });
      } catch (error) {
        assert(
          error instanceof ComputerControlError &&
            error.error._tag === "TargetBlocked" &&
            error.error.kind === "secure-field",
          "Unexpected secure-focus result.",
        );
        return;
      }
      throw new Error("Secure focus accepted typing.");
    });
    await check("Coordinate click reaches the fixture in display model space", async () => {
      const current = await request<ComputerInspectResult>({
        op: "inspect",
        appId: fixtureId,
        maxNodes: 100,
      });
      const button = current.nodes.find((node) => node.name === "Rehearsal press");
      const status = helper.status();
      const display = status.available
        ? status.displays?.find((display) => display.displayId === button?.displayId)
        : undefined;
      if (!button?.bounds || !display) throw new Error("Button display geometry is unavailable.");
      await request({
        op: "click",
        displayId: display.displayId,
        geometryGeneration: display.geometryGeneration,
        x: Math.floor(button.bounds.x + button.bounds.width / 2),
        y: Math.floor(button.bounds.y + button.bounds.height / 2),
        button: "left",
        clickCount: 1,
        modifiers: [],
      });
      const after = await request({ op: "inspect", appId: fixtureId, maxNodes: 100 });
      assert(
        JSON.stringify(after).includes("presses: 2"),
        "Coordinate click missed the fixture button.",
      );
    }).catch((error: unknown) => {
      // Keep the pointer refusal failed. The independent expiry check below
      // verifies refusal only; it never retries pointer input or resumes input.
      if (
        error instanceof ComputerControlError &&
        error.error._tag === "TargetBlocked" &&
        error.error.kind === "system-ui"
      ) {
        process.exitCode = 1;
        return;
      }
      throw error;
    });
  }
  await check("Permit expiry blocks the next real action", async () => {
    clearInterval(renewal);
    renewal = undefined;
    await pause(1250);
    try {
      await request({ op: "activateApp", appId: fixtureId });
    } catch (error) {
      assert(
        error instanceof ComputerControlError && error.error._tag === "Interrupted",
        "Expired permit was accepted.",
      );
      return;
    }
    throw new Error("Expired permit was accepted.");
  });
} catch {
  const status = helper.status();
  if (!checks.some((entry) => entry.state === "failed"))
    checks.push({
      name: "Rehearsal prerequisites",
      state: "blocked",
      outcome: status.available ? "RehearsalFailure" : status.reason,
    });
  process.exitCode = 1;
} finally {
  clearInterval(renewal);
  await helper.suspend();
  const helperClosed = await helper.closeAndWait();
  const fixturesClosed = (
    await Promise.all([closeRehearsalChild(fixture), closeRehearsalChild(ungrantedFixture)])
  ).every(Boolean);
  const cleanup = { helperClosed, fixturesClosed, confirmed: helperClosed && fixturesClosed };
  if (!cleanup.confirmed) process.exitCode = 1;
  if (root) await rm(root, { recursive: true, force: true });
  const report = {
    reportVersion: 1,
    admissionId: process.env.F5_COMPUTER_CERTIFICATION_ADMISSION,
    recordedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    osVersion: release(),
    helperSha256: helperHash,
    scope: privacyOnly
      ? "unsigned-native-helper-synthetic-capture-privacy"
      : "unsigned-native-helper-only",
    repositoryCommit,
    workingTreeDirty,
    rehearsalSourceSha256,
    captureVerifierSha256,
    ...(privacyOnly ? { privacyOnly: true } : {}),
    signed: false,
    certified: false,
    checks,
    physicalInterruption,
    cleanup,
    remaining: [
      ...(privacyOnly
        ? ["Capture-only mode excludes semantic, keyboard and coordinate input checks"]
        : []),
      "Provider-mediated app consent and real provider turns",
      "Capture isolation and secure masking across real apps, popups and moving windows",
      "Coordinate/drag/typing focus changes",
      "Physical kill-chord latency and user-input interruption",
      "Renderer/backend-stall stop path",
      "Multiple profiles, overlays and mixed-DPI/fullscreen displays",
      "Windows desktop runtime",
      "Signed packaging and TCC attribution",
    ],
  };
  await writeFile(resolve(output), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(
    `Native helper rehearsal report: ${resolve(output)} (${checks.filter((entry) => entry.state === "passed").length} passed; release gates unchanged).\n`,
  );
}
