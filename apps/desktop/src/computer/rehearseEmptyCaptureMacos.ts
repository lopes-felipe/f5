import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { release, tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { Schema } from "effect";
import { ComputerScreenshot, type ComputerAutomationRequest } from "@t3tools/contracts";
import { ComputerControlError } from "@t3tools/shared/computerControl";
import { ComputerHelperClient } from "./ComputerHelperClient";

// No grants, permit, resume, app launch or input. The helper must synthesize a
// neutral canvas rather than request OS pixels. Images are verified in memory.
const args = process.argv.slice(2);
const argument = (key: string) => {
  const index = args.indexOf(key);
  return index < 0 ? undefined : args[index + 1];
};
const executable = argument("--helper");
const output = argument("--output");
if (process.platform !== "darwin" || !executable || !output) {
  process.stderr.write(
    "Usage: bun apps/desktop/src/computer/rehearseEmptyCaptureMacos.ts --helper <dev helper> --output <new report.json>\n",
  );
  process.exit(1);
}
await writeFile(resolve(output), "", { flag: "wx" });
const root = await mkdtemp(join(tmpdir(), "f5-empty-capture-rehearsal-"));
const exec = promisify(execFile);
const helper = new ComputerHelperClient(dirname(resolve(executable)), resolve(executable));
const verifier = join(root, "verifier");
let suspended = true;
let heartbeats = 0;
helper.onEvent((event) => {
  if (event.type === "heartbeat") {
    heartbeats++;
    suspended &&= event.suspended === true;
  }
});
const checks: Array<{ displayId: string; op: string; passed: boolean; outcome?: string }> = [];
let metadata: Record<string, unknown> = {};
let expectedChecks = 0;
let failed = false;
try {
  const repo = resolve(import.meta.dirname, "../../../..");
  const verifierSource = resolve(
    import.meta.dirname,
    "../../native/macos/Fixtures/CaptureVerifier.swift",
  );
  const hashes = Object.fromEntries(
    await Promise.all(
      [
        ["helper", resolve(executable)],
        ["rehearsal", import.meta.filename],
        ["verifier", verifierSource],
      ].map(async ([name, path]) => [
        name!,
        createHash("sha256")
          .update(await readFile(path!))
          .digest("hex"),
      ]),
    ),
  );
  metadata = {
    repositoryCommit: (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim(),
    workingTreeDirty: Boolean(
      (await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout.trim(),
    ),
    sourceHashes: hashes,
  };
  await exec("swiftc", ["-framework", "AppKit", verifierSource, "-o", verifier], {
    timeout: 30000,
  });
  helper.start();
  const deadline = performance.now() + 5000;
  while (!helper.status().available && performance.now() < deadline)
    await new Promise((done) => setTimeout(done, 25));
  const status = helper.status();
  if (!status.available || !status.displays?.length) throw new Error("Helper/display unavailable.");
  metadata.displayGeometry = status.displays;
  expectedChecks = status.displays.length * 2;
  const authorization = {
    profileId: "empty-capture-rehearsal",
    threadId: randomUUID(),
    sessionGeneration: randomUUID(),
    turnId: "observe",
    executionGeneration: 0,
    grantVersion: 1,
    grants: [],
  };
  helper.control({ type: "grantsChanged", authorization });
  for (const display of status.displays) {
    for (const op of ["screenshot", "zoom"] as const) {
      try {
        const request = {
          op,
          displayId: display.displayId,
          ...(op === "zoom"
            ? {
                rect: {
                  x: 0,
                  y: 0,
                  width: Math.min(100, display.modelSize.width),
                  height: Math.min(100, display.modelSize.height),
                },
              }
            : {}),
          requestId: randomUUID(),
          payloadHash: "empty-capture-observation",
          authorization,
          deadlineAtMs: Date.now() + 10000,
          agent: { provider: "codex", threadTitle: "Empty capture rehearsal" },
        } as ComputerAutomationRequest;
        const image = Schema.decodeUnknownSync(ComputerScreenshot)(
          await helper.request(request, {
            f5Pids: [process.pid],
            f5BundlePath: join(root, "protected-host"),
            overlayWindowIds: [],
          }),
        );
        const neutral = await new Promise<boolean>((done, reject) => {
          const child = execFile(
            verifier,
            [],
            { timeout: 10000, maxBuffer: 2048 },
            (error, stdout) => {
              if (error) return reject(new Error("Pixel verifier failed."));
              try {
                done(JSON.parse(stdout).allNeutral === true);
              } catch {
                reject(new Error("Invalid verifier result."));
              }
            },
          );
          child.stdin!.end(
            JSON.stringify({
              data: image.data,
              mimeType: image.mimeType,
              requireBlue: false,
              neutralFrame: true,
            }),
          );
        });
        const passed =
          neutral &&
          image.displayId === display.displayId &&
          image.geometryGeneration === display.geometryGeneration &&
          image.mimeType === (op === "screenshot" ? "image/jpeg" : "image/png");
        checks.push({ displayId: display.displayId, op, passed });
        if (!passed) throw new Error("Empty capture was not neutral or geometry changed.");
      } catch (error) {
        if (
          !checks.at(-1) ||
          checks.at(-1)!.displayId !== display.displayId ||
          checks.at(-1)!.op !== op
        )
          checks.push({
            displayId: display.displayId,
            op,
            passed: false,
            outcome:
              error instanceof ComputerControlError ? error.error._tag : "VerificationFailure",
          });
        throw error;
      }
    }
  }
} catch {
  failed = true;
} finally {
  helper.close();
  await rm(root, { recursive: true, force: true });
  const passed =
    !failed &&
    expectedChecks > 0 &&
    checks.length === expectedChecks &&
    checks.every((check) => check.passed) &&
    suspended &&
    heartbeats > 0;
  await writeFile(
    resolve(output),
    JSON.stringify(
      {
        reportVersion: 1,
        recordedAt: new Date().toISOString(),
        ...metadata,
        platform: process.platform,
        arch: process.arch,
        osVersion: release(),
        scope: "unsigned-suspended-helper-empty-grant-capture",
        signed: false,
        certified: false,
        state: passed ? "passed" : "failed",
        helperStayedSuspended: suspended,
        heartbeats,
        checks,
        limitations: [
          "Empty-grant neutral frames only; no granted app, provider, consent, overlay, OS input or active lease tested",
          "Each connected display's neutral encoding/zoom geometry checked; not multi-display app privacy, focus or pointer proof",
          "No signed installed-build attribution, real-keychain/autofill, Windows or complete release certification",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    `Empty-grant capture: ${passed ? "passed" : "failed"}; report ${resolve(output)}\n`,
  );
  if (!passed) process.exitCode = 1;
}
