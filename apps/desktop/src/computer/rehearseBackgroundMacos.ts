import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { release, tmpdir } from "node:os";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { Schema } from "effect";
import {
  COMPUTER_BACKGROUND_CAPABILITY,
  ComputerInspectResult,
  type ComputerAutomationRequest,
  type ComputerLeaseScope,
} from "@t3tools/contracts";
import { COMPUTER_BACKGROUND_POLICY } from "@t3tools/shared/computerApps";
import { ComputerControlError } from "@t3tools/shared/computerControl";
import { ComputerHelperClient } from "./ComputerHelperClient";
import { createRehearsalFixture } from "./rehearsalFixture";
import { rehearsalExecutionCode } from "./rehearsalResponses";

// Phase 0 background-delivery spike: one background synthetic app, a fixture-only grant and
// an app-scoped permit. Measures whether accessibility press, setValue and app-filtered
// capture reach the fixture without changing the frontmost app. Records metadata only, never
// screenshots, text or element names.
const args = process.argv.slice(2);
const argument = (key: string) => {
  const index = args.indexOf(key);
  return index >= 0 ? args[index + 1] : undefined;
};
const helperPath = argument("--helper");
// Repeatable `--real-app <bundle id>`; only certified background apps are accepted.
const realApps = args.flatMap((value, index) => (args[index - 1] === "--real-app" ? [value] : []));
for (const realApp of realApps)
  if (!COMPUTER_BACKGROUND_POLICY.certified.includes(realApp)) {
    process.stderr.write(`Not a certified background app: ${realApp}\n`);
    process.exit(1);
  }
const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const output =
  argument("--output") ??
  join(
    repositoryRoot,
    "docs/computer-certification",
    `${new Date().toISOString().slice(0, 10)}-macos-background-delivery-spike.json`,
  );
if (process.platform !== "darwin" || !helperPath) {
  process.stderr.write(
    "Usage: bun apps/desktop/src/computer/rehearseBackgroundMacos.ts --helper <background-enabled dev helper> [--real-app <certified bundle id>]... [--output <new report.json>]\n",
  );
  process.exit(1);
}
// Never overwrite an earlier receipt.
await writeFile(resolve(output), "", { flag: "wx" });
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "f5-background-spike-"));
const helper = new ComputerHelperClient(dirname(resolve(helperPath)), resolve(helperPath));
let fixture: Awaited<ReturnType<typeof createRehearsalFixture>> | undefined;
let heartbeats = 0;
const frontmost = new Set<string>();
const unexpectedEvents = new Set<string>();
helper.onEvent((event) => {
  if (event.type === "heartbeat") {
    heartbeats++;
    if (typeof event.frontmostAppId === "string") frontmost.add(event.frontmostAppId);
  } else if (
    ["physicalInput", "targetInterrupted", "activationIncident", "permitExpired"].includes(
      String(event.type),
    )
  )
    unexpectedEvents.add(String(event.type));
});
const checks: Array<Record<string, string | number | boolean>> = [];
let failure = false;
let helperCapable = false;
const helperSha256 = createHash("sha256")
  .update(await readFile(resolve(helperPath)))
  .digest("hex");
const sourceSha256 = createHash("sha256")
  .update(await readFile(import.meta.filename))
  .digest("hex");
const repositoryCommit = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
const workingTreeDirty = Boolean((await exec("git", ["status", "--porcelain"])).stdout.trim());
const fixtureSource = resolve(
  import.meta.dirname,
  "../../native/macos/Fixtures/ComputerControlFixture.swift",
);
const fixtureSourceSha256 = createHash("sha256")
  .update(await readFile(fixtureSource))
  .digest("hex");
const settle = (ms: number) => new Promise((done) => setTimeout(done, ms));
try {
  helper.start();
  const startupDeadline = performance.now() + 5000;
  while (!helper.status().available && performance.now() < startupDeadline) await settle(25);
  if (!helper.status().available) throw new Error("Helper unavailable.");
  helperCapable = helper.capabilities().includes(COMPUTER_BACKGROUND_CAPABILITY);
  if (!helperCapable) throw new Error("Helper was built without background support.");
  const appId = `org.example.background-spike.${randomUUID()}`;
  const expectedText = "f5 background spike";
  fixture = await createRehearsalFixture({
    root,
    appId,
    background: true,
    expectedText,
    sourceFile: fixtureSource,
  });
  const executionGeneration = 1;
  const scope: ComputerLeaseScope = { kind: "app", appId };
  const authorization = {
    profileId: "background-spike",
    threadId: randomUUID(),
    sessionGeneration: randomUUID(),
    turnId: randomUUID(),
    executionGeneration,
    grantVersion: 1,
    grants: [{ appId, tier: "full" as const, allowTyping: true }],
  };
  helper.control({ type: "grantsChanged", authorization });
  helper.control({ type: "permit", executionGeneration, expiresInMs: 1000, scope });
  helper.control({ type: "resume", executionGeneration, scope });
  const renew = setInterval(
    () => helper.control({ type: "permit", executionGeneration, expiresInMs: 1000, scope }),
    250,
  );
  // Let a heartbeat record the user's frontmost app before any background step.
  await settle(600);
  const before = new Set(frontmost);
  const context = {
    f5Pids: [process.pid],
    f5BundlePath: join(root, "protected-host"),
    overlayWindowIds: [],
  };
  const run = async (
    name: string,
    request: Record<string, unknown> & { op: ComputerAutomationRequest["op"] },
    record: (result: unknown) => Record<string, string | number | boolean> = () => ({}),
  ): Promise<unknown> => {
    const start = performance.now();
    try {
      const result = await helper.request(
        {
          ...request,
          delivery: "background",
          requestId: randomUUID(),
          payloadHash: "spike",
          authorization,
          deadlineAtMs: Date.now() + 30_000,
          agent: { provider: "codex", threadTitle: "Background delivery spike" },
        } as ComputerAutomationRequest,
        context,
      );
      checks.push({
        step: name,
        elapsedMs: Math.round(performance.now() - start),
        outcome: "ok",
        ...record(result),
      });
      return result;
    } catch (error) {
      const tag = error instanceof ComputerControlError ? error.error._tag : "spike-failure";
      const code =
        error instanceof ComputerControlError && error.error._tag === "Execution"
          ? rehearsalExecutionCode(error.error.message)
          : undefined;
      checks.push({
        step: name,
        elapsedMs: Math.round(performance.now() - start),
        outcome: tag,
        ...(code ? { executionCode: code } : {}),
      });
      failure = true;
      return undefined;
    }
  };
  try {
    const inspect = Schema.decodeUnknownSync(ComputerInspectResult)(
      await run("inspect", { op: "inspect", appId, maxNodes: 200 }, (value) => ({
        nodes: (value as ComputerInspectResult).nodes.length,
      })),
    );
    const button = inspect.nodes.find(
      (node) => node.role === "AXButton" && node.actions.includes("press") && node.enabled,
    );
    const field = inspect.nodes.find(
      (node) => node.role === "AXTextField" && node.actions.includes("setValue"),
    );
    checks.push({ step: "targets", button: !!button, field: !!field });
    if (button) {
      const presses = fixture.presses();
      await run("press", {
        op: "elementAction",
        appId,
        snapshotId: inspect.snapshotId,
        elementRef: button.elementRef,
        action: "press",
      });
      await settle(300);
      checks.push({ step: "press-delivered", delivered: fixture.presses() > presses });
      if (fixture.presses() <= presses) failure = true;
    } else failure = true;
    if (field)
      await run(
        "setValue",
        {
          op: "elementAction",
          appId,
          snapshotId: inspect.snapshotId,
          elementRef: field.elementRef,
          action: "setValue",
          value: expectedText,
        },
        (value) => {
          const verification = (value as { verification?: { verified?: unknown } }).verification;
          if (verification?.verified !== true) failure = true;
          return { verified: verification?.verified === true };
        },
      );
    else failure = true;
    // Selected-text insertion into the fixture's focused field: the path computer_type uses.
    await run("type", { op: "type", appId, text: " typed" }, (value) => {
      const verification = (value as { verification?: { verified?: unknown } }).verification;
      if (verification?.verified !== true) failure = true;
      return { verified: verification?.verified === true };
    });
    await run("screenshot", { op: "screenshot", appId }, (value) => {
      const shot = value as { captureScope?: unknown; data?: unknown };
      if (shot.captureScope !== "app") failure = true;
      return {
        captureScope: String(shot.captureScope ?? "missing"),
        bytes: typeof shot.data === "string" ? shot.data.length : 0,
      };
    });
    await settle(600);
    // The spike succeeds only if the frontmost app never became the fixture.
    const activated = frontmost.has(appId);
    checks.push({
      step: "frontmost",
      unchanged: !activated && [...frontmost].every((id) => before.has(id)),
      observed: frontmost.size,
    });
    if (activated) failure = true;
    // Real certified apps, read-only: never mutate the user's documents from a script. Each
    // must already be running; inspect and app-scoped capture must not change the frontmost app.
    for (const realApp of realApps) {
      const realAuthorization = {
        ...authorization,
        grantVersion: authorization.grantVersion + 1 + realApps.indexOf(realApp),
        grants: [
          ...authorization.grants,
          { appId: realApp, tier: "view" as const, allowTyping: false },
        ],
      };
      helper.control({ type: "grantsChanged", authorization: realAuthorization });
      const frontBefore = [...frontmost].at(-1);
      for (const op of ["inspect", "screenshot"] as const) {
        const start = performance.now();
        try {
          const value = await helper.request(
            {
              op,
              appId: realApp,
              ...(op === "inspect" ? { maxNodes: 200 } : {}),
              requestId: randomUUID(),
              payloadHash: "spike",
              authorization: realAuthorization,
              deadlineAtMs: Date.now() + 30_000,
              agent: { provider: "codex", threadTitle: "Background delivery spike" },
            } as ComputerAutomationRequest,
            context,
          );
          const shot = value as { captureScope?: unknown; nodes?: unknown[] };
          if (op === "screenshot" && shot.captureScope !== "app") failure = true;
          checks.push({
            step: `real-app-${op}`,
            app: realApp,
            elapsedMs: Math.round(performance.now() - start),
            outcome: "ok",
            ...(op === "inspect" ? { nodes: shot.nodes?.length ?? 0 } : {}),
          });
        } catch (error) {
          failure = true;
          checks.push({
            step: `real-app-${op}`,
            app: realApp,
            elapsedMs: Math.round(performance.now() - start),
            outcome: error instanceof ComputerControlError ? error.error._tag : "spike-failure",
          });
        }
      }
      await settle(600);
      const unchanged = !frontmost.has(realApp) || frontBefore === realApp;
      checks.push({ step: "real-app-frontmost", app: realApp, unchanged });
      if (!unchanged) failure = true;
    }
  } finally {
    clearInterval(renew);
    helper.control({ type: "retire", executionGeneration });
  }
} catch {
  failure = true;
} finally {
  helper.close();
  fixture?.child.kill();
  await rm(root, { recursive: true, force: true });
  const passed = !failure && helperCapable && heartbeats > 0 && unexpectedEvents.size === 0;
  await writeFile(
    resolve(output),
    JSON.stringify(
      {
        reportVersion: 1,
        recordedAt: new Date().toISOString(),
        repositoryCommit,
        workingTreeDirty,
        sourceSha256,
        fixtureSourceSha256,
        helperSha256,
        platform: process.platform,
        arch: process.arch,
        osVersion: release(),
        scope: "unsigned-background-synthetic-app-delivery-spike",
        signed: false,
        certified: false,
        state: passed ? "passed" : "failed",
        helperCapable,
        heartbeats,
        unexpectedEvents: [...unexpectedEvents].sort(),
        checks,
        limitations: [
          "Scripted grant and app-scoped permit for the synthetic fixture only; no F5 consent, session receipt or provider transport proof",
          "Real apps are probed read-only (inspect and app-scoped capture); real-app press, setValue and typing stay a manual certification step",
          "No pointer-position measurement, takeover, installed-build TCC attribution or release certification",
        ],
        realApps,
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    `Background delivery spike: ${passed ? "passed" : "failed"}; report ${resolve(output)}\n`,
  );
  if (!passed) process.exitCode = 1;
}
