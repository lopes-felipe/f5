import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { release, tmpdir } from "node:os";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { Schema } from "effect";
import { ComputerInspectResult } from "@t3tools/contracts";
import {
  computerInspectionDigest,
  computerInspectionRehearsalRequest,
} from "./computerInspectionRehearsal";
import { ComputerControlError } from "@t3tools/shared/computerControl";
import { ComputerHelperClient } from "./ComputerHelperClient";
import { createRehearsalFixture, prepareRehearsalExecutable } from "./rehearsalFixture";
import { closeRehearsalChild } from "./rehearsalCleanup";
import { rehearsalExecutionCode } from "./rehearsalResponses";
import {
  measure,
  metadata,
  type PerformanceReport,
} from "../../../../scripts/lib/performance/report";

// Observation only: one background synthetic app, a fixture-only grant, no permit,
// resume, capture, activation, input, provider session or existing-user-app grant.
const args = process.argv.slice(2);
const argument = (key: string) => {
  const index = args.indexOf(key);
  return index >= 0 ? args[index + 1] : undefined;
};
const helperPath = argument("--helper");
const output = argument("--output");
const performanceMode = args.includes("--performance");
const measurements: PerformanceReport["measurements"] = {};
const nodesDigests: Record<string, string> = {};
let displayConfiguration: unknown;
if (process.platform !== "darwin" || !helperPath || !output) {
  process.stderr.write(
    "Usage: bun apps/desktop/src/computer/rehearseInspectMacos.ts --helper <dev helper> --output <new report.json>\n",
  );
  process.exit(1);
}
await writeFile(resolve(output), "", { flag: "wx" });
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "f5-inspect-diagnostic-"));
let helper = new ComputerHelperClient(dirname(resolve(helperPath)), resolve(helperPath));
let fixture: Awaited<ReturnType<typeof createRehearsalFixture>> | undefined;
let heartbeats = 0;
let suspended = true;
helper.onEvent((event) => {
  if (event.type === "heartbeat") {
    heartbeats++;
    suspended &&= event.suspended === true;
  }
});
const checks: Array<Record<string, string | number | boolean>> = [];
let failure = false;
const coldSamples: Record<string, number> = {};
const helperSha256 = createHash("sha256")
  .update(await readFile(resolve(helperPath)))
  .digest("hex");
const sourceSha256 = createHash("sha256")
  .update(
    Buffer.concat(
      await Promise.all(
        [
          import.meta.filename,
          resolve(import.meta.dirname, "computerInspectionRehearsal.ts"),
          resolve(import.meta.dirname, "rehearsalFixture.ts"),
          resolve(import.meta.dirname, "rehearsalCleanup.ts"),
        ].map((file) => readFile(file)),
      ),
    ),
  )
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
try {
  let preparedFixture: string | undefined;
  if (performanceMode) {
    preparedFixture = join(root, "fixture-executable");
    await prepareRehearsalExecutable(fixtureSource, preparedFixture);
    for (let index = 0; index < 5; index++) {
      const start = performance.now();
      helper.start();
      const deadline = start + 5000;
      while (!helper.status().available && performance.now() < deadline)
        await new Promise((done) => setTimeout(done, 25));
      const coldStatus = helper.status();
      if (!coldStatus.available) {
        process.stderr.write("Cold helper unavailable: " + coldStatus.reason + "\n");
        throw new Error("Cold helper unavailable.");
      }
      const cold = await createRehearsalFixture({
        root,
        appId: "org.example.cold-inspection." + randomUUID(),
        background: true,
        executableSource: preparedFixture,
      });
      coldSamples["cold." + index + ".wallMs"] = performance.now() - start;
      await closeRehearsalChild(cold.child);
      helper.close();
      helper = new ComputerHelperClient(dirname(resolve(helperPath)), resolve(helperPath));
    }
    helper.onEvent((event) => {
      if (event.type === "heartbeat") {
        heartbeats++;
        suspended &&= event.suspended === true;
      }
    });
  }
  helper.start();
  const startupDeadline = performance.now() + 5000;
  while (!helper.status().available && performance.now() < startupDeadline)
    await new Promise((done) => setTimeout(done, 25));
  if (!helper.status().available) throw new Error("Helper unavailable.");
  const status = helper.status();
  displayConfiguration = status.available
    ? status.displays?.map((display) => ({
        displayId: display.displayId,
        nativeBounds: display.nativeBounds,
        modelSize: display.modelSize,
        pixelSize: display.pixelSize,
      }))
    : undefined;
  const cases = performanceMode
    ? [
        { name: "small", treeNodes: undefined },
        { name: "large", treeNodes: 380 },
      ]
    : [{ name: "diagnostic", treeNodes: undefined }];
  for (const scenario of cases) {
    const appId = "org.example.inspect-diagnostic." + randomUUID();
    fixture = await createRehearsalFixture({
      root,
      appId,
      background: true,
      sourceFile: fixtureSource,
      ...(preparedFixture ? { executableSource: preparedFixture } : {}),
      ...(scenario.treeNodes ? { treeNodes: scenario.treeNodes } : {}),
      ...(args.includes("--delayed-focus") ? { delayedFocus: true } : {}),
    });
    const authorization = {
      profileId: "inspection-diagnostic",
      threadId: randomUUID(),
      sessionGeneration: randomUUID(),
      turnId: "observation",
      executionGeneration: 0,
      grantVersion: 1,
      grants: [{ appId, tier: "full" as const, allowTyping: false }],
    };
    helper.control({ type: "grantsChanged", authorization });
    for (const maxNodes of performanceMode ? [400] : [20, 100, 400]) {
      const start = performance.now();
      const read = async () =>
        Schema.decodeUnknownSync(ComputerInspectResult)(
          await helper.request(computerInspectionRehearsalRequest(appId, maxNodes, authorization), {
            f5Pids: [process.pid],
            f5BundlePath: join(root, "protected-host"),
            overlayWindowIds: [],
          }),
        );
      try {
        const result = await read();
        const digest = computerInspectionDigest(result);
        checks.push({
          scenario: scenario.name,
          maxNodes,
          elapsedMs: Math.round(performance.now() - start),
          accessible: result.accessible,
          nodes: result.nodes.length,
          truncated: result.truncated ?? false,
          nodesSha256: digest,
          outcome: "ok",
        });
        if (
          !result.accessible ||
          !result.nodes.length ||
          (performanceMode &&
            (result.truncated || (scenario.name === "large" && result.nodes.length < 350)))
        ) {
          failure = true;
          break;
        }
        if (performanceMode) {
          const name = "inspect." + scenario.name + "." + maxNodes;
          nodesDigests[name] = digest;
          measurements[name] = await measure(
            async () => {
              if (computerInspectionDigest(await read()) !== digest)
                throw new Error("Inspection content or completeness changed between samples.");
            },
            undefined,
            () => fixture!.reset(),
          );
        }
      } catch (error) {
        const tag = error instanceof ComputerControlError ? error.error._tag : "diagnostic-failure";
        const code =
          error instanceof ComputerControlError && error.error._tag === "Execution"
            ? rehearsalExecutionCode(error.error.message)
            : undefined;
        checks.push({
          scenario: scenario.name,
          maxNodes,
          elapsedMs: Math.round(performance.now() - start),
          outcome: tag,
          ...(code ? { executionCode: code } : {}),
        });
        failure = true;
        break;
      }
    }
    await closeRehearsalChild(fixture.child);
    fixture = undefined;
    if (failure) break;
  }
} catch {
  failure = true;
} finally {
  helper.close();
  fixture?.child.kill();
  await rm(root, { recursive: true, force: true });
  const passed =
    !failure && suspended && heartbeats > 0 && checks.length === (performanceMode ? 2 : 3);
  const performanceReport: PerformanceReport | undefined = performanceMode
    ? {
        schemaVersion: 1,
        scope: "computer",
        mode: "measurement",
        metadata: metadata(resolve(import.meta.dirname, "../../../..")),
        method: { warmups: 5, repetitions: 30 },
        measurements,
        diagnostics: coldSamples,
        observations: [
          {
            name: "native-inspection-failures",
            actual: failure ? 1 : 0,
            maximum: 0,
            passed: !failure,
          },
        ],
        notMeasured: [
          "CPU samples measure only the driving process; helper and desktop CPU not measured.",
          "Mutations, captures, waits, overlays and batches are not measured by this inspection harness.",
          "Performance acceptance requires matched baseline and candidate reports; this run is not certification.",
        ],
        computer: {
          fixtureDigest: fixtureSourceSha256,
          harnessDigest: sourceSha256,
          platform: process.platform,
          displays: displayConfiguration,
          masking: "fast",
          build: "debug-unsigned",
          helperIdentity: helperSha256,
          executionMode: "background",
          nodesDigests,
        },
      }
    : undefined;
  await writeFile(
    resolve(output),
    JSON.stringify(
      performanceReport ?? {
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
        scope: "unsigned-background-synthetic-app-inspection-only",
        signed: false,
        certified: false,
        state: passed ? "passed" : "failed",
        helperStayedSuspended: suspended,
        heartbeats,
        checks,
        limitations: [
          "Scripted grant only for the synthetic fixture, without any execution permit; no F5 consent or provider transport proof",
          "No input, capture, focus/activation, installed-build TCC attribution or release certification",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    `Background inspection: ${passed ? "passed" : "failed"}; report ${resolve(output)}\n`,
  );
  if (!passed) process.exitCode = 1;
}
