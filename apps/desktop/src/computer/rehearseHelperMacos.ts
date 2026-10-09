import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { tmpdir, release } from "node:os";
import { performance } from "node:perf_hooks";
import type { ComputerAutomationRequest, ComputerInspectResult } from "@t3tools/contracts";
import { ComputerControlError } from "@t3tools/shared/computerControl";
import { ComputerHelperClient } from "./ComputerHelperClient";

const exec = promisify(execFile);
const args = process.argv.slice(2);
const argument = (name: string) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const helperPath = argument("--helper");
const output = argument("--output");
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
let fixture: ReturnType<typeof spawn> | undefined;
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
  return (await helper.request(
    {
      ...payload,
      requestId: randomUUID(),
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
  )) as T;
};
async function check(name: string, run: () => Promise<void>): Promise<void> {
  process.stdout.write(`Checking: ${name}\n`);
  const started = performance.now();
  try {
    await run();
    checks.push({ name, state: "passed", elapsedMs: Math.round(performance.now() - started) });
  } catch (error) {
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
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
let helperHash: string | null = null;
try {
  helperHash = createHash("sha256")
    .update(await readFile(resolve(helperPath)))
    .digest("hex");
  helper.start();
  await waitFor(() => helper.status().available);
  const root = await mkdtemp(join(tmpdir(), "f5-native-rehearsal-"));
  const bundle = join(root, "ComputerControlFixture.app", "Contents");
  await mkdir(join(bundle, "MacOS"), { recursive: true });
  await writeFile(
    join(bundle, "Info.plist"),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${fixtureId}</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleName</key><string>Computer Control Test Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>NSPrincipalClass</key><string>NSApplication</string><key>LSMinimumSystemVersion</key><string>14.0</string></dict></plist>`,
  );
  await exec(
    "swiftc",
    [
      "-framework",
      "AppKit",
      resolve(import.meta.dirname, "../../native/macos/Fixtures/ComputerControlFixture.swift"),
      "-o",
      join(bundle, "MacOS", "Fixture"),
    ],
    { timeout: 30000 },
  );
  fixture = spawn(join(bundle, "MacOS", "Fixture"), [], { stdio: "ignore" });
  fixture.on("error", () => {});
  await pause(1000);
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
    await request({
      op: "elementAction",
      appId: fixtureId,
      snapshotId: current.snapshotId,
      elementRef: field.elementRef,
      action: "focus",
    });
    const text = "SYNTHETIC Ω🙂 input ".repeat(3);
    await request({ op: "type", text });
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
  });
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
  helper.close();
  fixture?.kill();
  const report = {
    reportVersion: 1,
    recordedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    osVersion: release(),
    helperSha256: helperHash,
    scope: "unsigned-native-helper-only",
    signed: false,
    certified: false,
    checks,
    physicalInterruption,
    remaining: [
      "Provider-mediated app consent and real provider turns",
      "Capture isolation and secure masking",
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
