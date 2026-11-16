import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { tmpdir, release } from "node:os";
import { promisify } from "node:util";
import type { DesktopComputerHostMessage, ComputerAutomationRequest } from "@t3tools/contracts";
import { ComputerController } from "./ComputerController";
import { ComputerHelperClient } from "./ComputerHelperClient";
import { ComputerHostChannel } from "./ComputerHostChannel";
import { ComputerLeaseAuthority } from "./ComputerLeaseAuthority";
import { createRehearsalFixture } from "./rehearsalFixture";
import { rehearsalAccessAnswer } from "./rehearsalConsent";
import { RehearsalResponses } from "./rehearsalResponses";

const args = process.argv.slice(2);
const argument = (name: string) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const helperPath = argument("--helper");
const output = argument("--output");
const provider = argument("--provider");
if (
  process.platform !== "darwin" ||
  process.env.F5_COMPUTER_PROVIDER_REHEARSAL !== "1" ||
  !helperPath ||
  !output ||
  (provider !== "claude" && provider !== "codex" && provider !== "both")
) {
  process.stderr.write(
    "Explicit opt-in required (real account quota and foreground input): F5_COMPUTER_PROVIDER_REHEARSAL=1 bun apps/desktop/src/computer/rehearseProviderMacos.ts --helper <development helper> --provider <claude|codex|both> --output <new report.json>\n",
  );
  process.exit(1);
}
await writeFile(resolve(output), "", { flag: "wx" });
const helper = new ComputerHelperClient(dirname(resolve(helperPath)), resolve(helperPath));
const lease = new ComputerLeaseAuthority();
let channel: ComputerHostChannel;
let physicalInterruption = false;
let cancelled = false;
let worker: ChildProcess | undefined;
let fixture: Awaited<ReturnType<typeof createRehearsalFixture>> | undefined;
let root: string | undefined;
let helperSha256: string | undefined;
let repositoryCommit: string | undefined;
let workingTreeDirty: boolean | undefined;
let prerequisiteFailure: string | undefined;
const results: Array<Record<string, unknown>> = [];
const controller = new ComputerController(
  lease,
  helper,
  {
    show: () => {},
    clear: () => {},
    action: async () => {},
    windowIds: () => [],
  },
  {
    f5Pids: () => [process.pid, ...(worker?.pid ? [worker.pid] : [])],
    f5BundlePath: resolve(import.meta.dirname, "../../.."),
    platform: "darwin",
    activity: (profileId, activity) => channel.send(profileId, { type: "activity", activity }),
    executionState: (_profileId, update) => {
      if (update.state === "waiting-user") {
        physicalInterruption = true;
        worker?.kill();
      }
    },
    cooperationEnabled: (profileId) => channel.cooperationCapable(profileId),
    targetYielded: (holder, appId) =>
      channel.send(holder.profileId, {
        type: "targetYielded",
        threadId: holder.threadId,
        sessionGeneration: holder.sessionGeneration,
        ...(appId ? { appId } : {}),
      }),
    paused: (holder, cause) => {
      if (cause === "user-input" || cause === "kill-switch") physicalInterruption = true;
      channel.send(holder.profileId, {
        type: "pauseChanged",
        threadId: holder.threadId,
        paused: true,
      });
      // Never resume on an interruption, including between provider runs.
      worker?.kill();
    },
  },
);
const offHelper = helper.onEvent((message) => {
  if (message.type === "status") channel?.broadcast({ type: "status", status: helper.status() });
  if (message.type === "physicalInput" || message.type === "killSwitch") {
    physicalInterruption = true;
    worker?.kill();
  }
});
let consentCount = 0;
let fixtureAppId = `org.example.computer-rehearsal.${randomUUID()}`;
let responseEvidence: { profileId: string; responses: RehearsalResponses } | undefined;
class RehearsalHostChannel extends ComputerHostChannel {
  override send(profileId: string, message: DesktopComputerHostMessage): void {
    if (responseEvidence?.profileId === profileId) responseEvidence.responses.response(message);
    super.send(profileId, message);
  }
}
channel = new RehearsalHostChannel(
  controller,
  () => helper.status(),
  (profileId, request) => {
    consentCount++;
    const incarnation = channel.incarnation(profileId);
    if (incarnation)
      channel.answerAccess(profileId, rehearsalAccessAnswer(request, incarnation, fixtureAppId));
  },
);
const offLease = lease.subscribe(() => channel.publishLeases());
const stop = () => {
  cancelled = true;
  controller.stop();
  worker?.kill();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  helperSha256 = createHash("sha256")
    .update(await readFile(resolve(helperPath)))
    .digest("hex");
  const exec = promisify(execFile);
  repositoryCommit = (await exec("git", ["rev-parse", "HEAD"], { timeout: 5000 })).stdout.trim();
  workingTreeDirty = Boolean(
    (await exec("git", ["status", "--porcelain"], { timeout: 5000 })).stdout.trim(),
  );
  helper.start();
  const readyBy = Date.now() + 5000;
  while (!helper.status().available) {
    if (Date.now() > readyBy) throw new Error("Helper prerequisites unavailable.");
    await new Promise<void>((done) => setTimeout(done, 25));
  }
  root = await mkdtemp(join(tmpdir(), "f5-provider-native-rehearsal-"));
  fixture = await createRehearsalFixture({
    root,
    appId: fixtureAppId,
    expectedText: "F5_PROVIDER_REHEARSAL Ω🙂",
  });
  for (const selected of provider === "both" ? ["claude", "codex"] : [provider]) {
    if (physicalInterruption || cancelled) throw new Error("The rehearsal was interrupted.");
    // A fresh fixture gives each provider an empty input and independent press count.
    if (results.length) {
      fixture.child.kill();
      fixtureAppId = `org.example.computer-rehearsal.${randomUUID()}`;
      fixture = await createRehearsalFixture({
        root,
        appId: fixtureAppId,
        expectedText: "F5_PROVIDER_REHEARSAL Ω🙂",
        executableSource: fixture.executable,
      });
    }
    process.stdout.write(
      `Starting ${selected} through F5's private host channel (synthetic app only).\n`,
    );
    const seen: ComputerAutomationRequest["op"][] = [];
    let serverReleasedLease = false;
    const profileId = `rehearsal-${randomUUID()}`;
    const responses = new RehearsalResponses();
    responseEvidence = { profileId, responses };
    const incarnation = randomUUID();
    const consentBefore = consentCount;
    worker = spawn(
      process.execPath,
      [resolve(import.meta.dirname, "../../../server/scripts/rehearse-computer-provider.ts")],
      {
        env: {
          ...process.env,
          F5_DESKTOP_COMPUTER_HOST: "ipc",
          F5_DESKTOP_BACKEND_INCARNATION: incarnation,
          F5_REHEARSAL_PROFILE_ID: profileId,
          F5_REHEARSAL_PROVIDER: selected,
          F5_REHEARSAL_APP_ID: fixtureAppId,
          F5_REHEARSAL_ROOT: root,
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    worker.stdout?.resume();
    worker.stderr?.resume();
    worker.on("message", (raw: unknown) => {
      const message = raw as DesktopComputerHostMessage;
      if (message.type === "request") {
        seen.push(message.request.op);
        responses.request(message.request);
      }
      if (message.type === "leaseRelease") serverReleasedLease = true;
    });
    channel.register(profileId, incarnation, worker);
    const child = worker;
    const exitCode = await new Promise<number | null>((done, reject) => {
      const timeout = setTimeout(() => {
        stop();
        reject(new Error("Provider rehearsal timed out."));
      }, 165000);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        done(code);
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    let providerResult: Record<string, unknown> = {};
    try {
      providerResult = JSON.parse(await readFile(join(root, `${selected}-result.json`), "utf8"));
    } catch {
      /* A terminated worker cannot supply successful evidence. */
    }
    const checks = {
      providerCompleted:
        exitCode === 0 && providerResult.completed === true && !providerResult.interrupted,
      scriptedFixtureConsent: consentCount > consentBefore,
      nativeCaptureDispatched: seen.includes("screenshot"),
      ...(selected === "claude"
        ? { modelReceivedNativeImage: providerResult.modelReceivedImage === true }
        : {}),
      nativeInspectionDispatched: seen.includes("inspect"),
      nativeInputDispatched: seen.includes("type") && seen.includes("elementAction"),
      ...responses.checks(),
      realAppReceivedExactlyOnePress: fixture.presses() === 1,
      realAppReceivedExpectedUnicodeText: fixture.typed(),
      serverReleasedTurnLease: serverReleasedLease,
      leaseReleasedAfterWorkerExit: lease.holders().length === 0,
    };
    const passed = Object.values(checks).every(Boolean) && !physicalInterruption && !cancelled;
    results.push({
      ...providerResult,
      provider: selected,
      state: passed ? "passed" : "failed",
      exitCode,
      checks,
      operations: seen,
    });
    process.stdout.write(
      `${selected}: ${passed ? "passed" : "failed"}; synthetic app ${fixture.presses()} press(es), expected typing ${fixture.typed()}.\n`,
    );
    if (!passed) {
      process.exitCode = 1;
      break;
    }
  }
} catch {
  const status = helper.status();
  prerequisiteFailure = physicalInterruption
    ? "physical-input"
    : cancelled
      ? "cancelled"
      : status.available
        ? "rehearsal-failure"
        : status.reason;
  process.exitCode = 1;
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  worker?.kill();
  controller.close();
  await helper.suspend();
  offHelper();
  offLease();
  helper.close();
  fixture?.child.kill();
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await writeFile(
    resolve(output),
    JSON.stringify(
      {
        reportVersion: 1,
        recordedAt: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        osVersion: release(),
        repositoryCommit,
        workingTreeDirty,
        helperSha256,
        scope: "unsigned-real-provider-native-controller-synthetic-app-rehearsal",
        signed: false,
        certified: false,
        scriptedConsent: true,
        physicalInterruption,
        cancelled,
        ...(prerequisiteFailure ? { prerequisiteFailure } : {}),
        results,
        limitations: [
          "Production controller, lease, host IPC, broker and provider transports; no Electron renderer or real overlay windows",
          "Scripted consent permits only this run's synthetic fixture; no real trusted consent dialog proof",
          "Physical kill chord, stop latency, renderer/backend stalls and multiple profiles/displays remain pending",
          "Real-app workflow/capture matrix, Windows desktop, signing and installed-build TCC attribution remain pending",
          "Provider built-in and Chrome integration gates remain closed",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(`Provider/native report: ${resolve(output)} (release gates unchanged).\n`);
}
