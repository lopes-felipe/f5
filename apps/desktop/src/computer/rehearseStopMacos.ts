import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { tmpdir, release } from "node:os";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type {
  ComputerAuthorization,
  ComputerAutomationRequest,
  ComputerApp,
  DesktopComputerHostMessage,
} from "@t3tools/contracts";
import { computerRequestPayload, ComputerControlError } from "@t3tools/shared/computerControl";
import { ComputerController } from "./ComputerController";
import { ComputerHelperClient } from "./ComputerHelperClient";
import { ComputerLeaseAuthority } from "./ComputerLeaseAuthority";
import { ComputerHostChannel } from "./ComputerHostChannel";
import { rehearsalAccessAnswer } from "./rehearsalConsent";
import { createRehearsalFixture } from "./rehearsalFixture";
import { closeRehearsalChild } from "./rehearsalCleanup";
import {
  measureStopLatency,
  type StopInputSample,
  type StopLatencyEvidence,
} from "./stopLatencyMeasurement";

const args = process.argv.slice(2);
const argument = (name: string) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const helperPath = argument("--helper");
const output = argument("--output");
const fixtureBinDirectory = argument("--fixture-bin-dir");
const stalled = args.includes("--stall-host");
const freezeBackend = args.includes("--freeze-backend");
if (
  process.platform !== "darwin" ||
  process.env.F5_COMPUTER_STOP_REHEARSAL !== "1" ||
  !helperPath ||
  !output ||
  (stalled && freezeBackend)
) {
  process.stderr.write(
    "Human coordination required: F5_COMPUTER_STOP_REHEARSAL=1 bun apps/desktop/src/computer/rehearseStopMacos.ts --helper <development helper> --output <new report.json> [--stall-host|--freeze-backend]\n",
  );
  process.exit(1);
}
await writeFile(resolve(output), "", { flag: "wx" });
const helper = new ComputerHelperClient(dirname(resolve(helperPath)), resolve(helperPath));
const lease = new ComputerLeaseAuthority();
let hostChannel: ComputerHostChannel | undefined;
let backend: ChildProcess | undefined;
let backendFrozen = false;
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
    f5Pids: () => [process.pid, ...(backend?.pid ? [backend.pid] : [])],
    f5BundlePath: resolve(import.meta.dirname, "../../.."),
    platform: "darwin",
    activity: (profileId, activity) => hostChannel?.send(profileId, { type: "activity", activity }),
    paused: (holder) =>
      hostChannel?.send(holder.profileId, {
        type: "pauseChanged",
        threadId: holder.threadId,
        paused: true,
      }),
  },
);
const evidence: StopLatencyEvidence = {
  samples: [],
  mutationInterrupted: false,
  pausedMutationRefused: false,
  leaseReleased: false,
  fixtureStillFrontmost: false,
  overflow: false,
};
const samples: StopInputSample[] = [];
evidence.samples = samples;
let latestHeartbeat = -Infinity;
let unexpectedPause = false;
let signalInterrupted = false;
const offHelper = helper.onEvent((message) => {
  if (message.type === "heartbeat") latestHeartbeat = performance.now();
  if (message.type === "physicalInput" && typeof message.recognizedAtMs === "number")
    evidence.physicalRecognizedAtMs ??= message.recognizedAtMs;
  if (message.type === "killSwitch" && typeof message.recognizedAtMs === "number")
    evidence.chordRecognizedAtMs ??= message.recognizedAtMs;
  if (message.type === "physicalInput" || message.type === "killSwitch") unexpectedPause = true;
  if (freezeBackend && message.type === "killSwitch") evidence.backendFrozenAtStop = backendFrozen;
});
const stop = () => {
  signalInterrupted = true;
  controller.stop();
  backend?.kill("SIGCONT");
  backend?.kill();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const waitFor = async (condition: () => boolean, ms = 5000) => {
  const deadline = performance.now() + ms;
  while (!condition()) {
    if (signalInterrupted || performance.now() >= deadline)
      throw new Error("Stop check interrupted or timed out.");
    await pause(1);
  }
};
let fixture: Awaited<ReturnType<typeof createRehearsalFixture>> | undefined;
let root: string | undefined;
let helperSha256: string | undefined;
let failure: string | undefined;
let typing: Promise<void> | undefined;
const appId = `org.example.computer-rehearsal.${randomUUID()}`;
let authorization: ComputerAuthorization = {
  profileId: "stop-rehearsal",
  threadId: randomUUID(),
  sessionGeneration: randomUUID(),
  turnId: "stop-rehearsal",
  executionGeneration: 1,
  grantVersion: 1,
  grants: [{ appId, tier: "full", allowTyping: false }],
};
type Operation = ComputerAutomationRequest extends infer R
  ? R extends ComputerAutomationRequest
    ? Omit<R, "requestId" | "payloadHash" | "authorization" | "deadlineAtMs" | "agent">
    : never
  : never;
const request = (operation: Operation) => {
  const envelope = {
    ...operation,
    requestId: randomUUID(),
    authorization,
    deadlineAtMs: Date.now() + 30000,
    agent: { provider: "codex" as const, threadTitle: "Physical stop rehearsal" },
  };
  return controller.invoke({
    ...envelope,
    payloadHash: createHash("sha256").update(computerRequestPayload(envelope)).digest("hex"),
  } as ComputerAutomationRequest);
};
try {
  helperSha256 = createHash("sha256")
    .update(await readFile(resolve(helperPath)))
    .digest("hex");
  helper.start();
  await waitFor(() => helper.status().available);
  root = await mkdtemp(join(tmpdir(), "f5-stop-rehearsal-"));
  fixture = await createRehearsalFixture({
    root,
    appId,
    ...(fixtureBinDirectory ? { preparedDirectory: fixtureBinDirectory } : {}),
    sourceFile: resolve(
      import.meta.dirname,
      "../../native/macos/Fixtures/StopLatencyFixture.swift",
    ),
  });
  let buffer = "";
  const calibrations: number[] = [];
  let countdownAtMs: number | undefined;
  fixture.child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line === "FIXTURE_READY") continue;
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (typeof value.observedAtMs !== "number" || !Number.isFinite(value.observedAtMs))
          throw new Error();
        if (value.kind === "calibration") calibrations.push(value.observedAtMs);
        else if (value.kind === "countdown") countdownAtMs = value.observedAtMs;
        else if (value.kind === "prompt") evidence.promptAtMs = value.observedAtMs;
        else if (value.kind === "finished") evidence.observationEndedAtMs = value.observedAtMs;
        else if (
          (value.kind === "injected" || value.kind === "physical" || value.kind === "chord") &&
          typeof value.eventAtMs === "number" &&
          Number.isFinite(value.eventAtMs) &&
          typeof value.keyDown === "boolean"
        ) {
          if (samples.length >= 8192) throw new Error();
          samples.push({
            kind: value.kind,
            eventAtMs: value.eventAtMs,
            observedAtMs: value.observedAtMs,
            keyDown: value.keyDown,
          });
        } else throw new Error();
      } catch {
        evidence.overflow = true;
        controller.stop();
      }
    }
    if (buffer.length > 4096) {
      evidence.overflow = true;
      controller.stop();
    }
  });
  // Bound the offset between the fixture's native uptime and this process's
  // performance clock by the complete round trip, without assuming their origins.
  let clock: { offsetMinMs: number; offsetMaxMs: number } | undefined;
  for (let index = 0; index < 3; index++) {
    const before = performance.now();
    fixture.child.stdin?.write("CALIBRATE\n");
    await waitFor(() => calibrations.length > index);
    const after = performance.now();
    const native = calibrations[index]!;
    if (!clock || after - before < clock.offsetMaxMs - clock.offsetMinMs)
      clock = { offsetMinMs: native - after, offsetMaxMs: native - before };
  }
  if (unexpectedPause || evidence.overflow) throw new Error("Input arrived before the prompt.");
  if (freezeBackend) {
    const incarnation = randomUUID();
    const profileId = authorization.profileId;
    hostChannel = new ComputerHostChannel(
      controller,
      () => helper.status(),
      (profile, access) => {
        hostChannel!.answerAccess(profile, rehearsalAccessAnswer(access, incarnation, appId));
      },
    );
    lease.subscribe(() => hostChannel?.publishLeases());
    helper.onEvent((message) => {
      if (message.type === "status")
        hostChannel?.broadcast({ type: "status", status: helper.status() });
    });
    let ready = false;
    backend = spawn(
      process.execPath,
      [resolve(import.meta.dirname, "../../../server/scripts/rehearse-computer-stop-worker.ts")],
      {
        env: {
          ...process.env,
          F5_DESKTOP_COMPUTER_HOST: "ipc",
          F5_DESKTOP_BACKEND_INCARNATION: incarnation,
          F5_REHEARSAL_PROFILE_ID: profileId,
          F5_REHEARSAL_THREAD_ID: authorization.threadId,
          F5_REHEARSAL_GENERATION: authorization.sessionGeneration,
          F5_REHEARSAL_APP_ID: appId,
          F5_REHEARSAL_ROOT: root,
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    backend.on("error", () => {});
    let stdout = "";
    backend.stdout?.setEncoding("utf8");
    backend.stdout?.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-128);
      if (stdout.includes("STOP_WORKER_READY\n")) ready = true;
    });
    backend.stderr?.resume();
    backend.on("message", (raw: unknown) => {
      const message = raw as DesktopComputerHostMessage;
      if (message.type === "request") authorization = message.request.authorization;
    });
    hostChannel.register(profileId, incarnation, backend);
    typing = new Promise<void>((done) => backend!.once("exit", () => done()));
    await waitFor(() => ready, 10000);
    fixture.child.stdin?.write("COUNTDOWN\n");
    await waitFor(() => countdownAtMs !== undefined);
    const typingAtPerf = countdownAtMs! + 2000 - (clock!.offsetMinMs + clock!.offsetMaxMs) / 2;
    await waitFor(() => performance.now() >= typingAtPerf);
    backend.kill("SIGUSR2");
  } else {
    controller.updateGrants(authorization);
    const holder = controller.acquire({
      ...authorization,
      backend: "native",
      threadTitle: "Physical stop rehearsal",
      scope: { kind: "foreground" },
      policyRevision: 0,
    });
    authorization = { ...authorization, executionGeneration: holder.executionGeneration };
    await request({ op: "activateApp", appId, screenshot: false });
    const started = performance.now();
    typing = (async () => {
      while (!unexpectedPause && !signalInterrupted && performance.now() - started < 20000) {
        try {
          await request({ op: "type", text: "x".repeat(10000), screenshot: false });
        } catch (error) {
          evidence.mutationInterrupted =
            error instanceof ComputerControlError && error.error._tag === "Interrupted";
          return;
        }
      }
    })();
  }
  await waitFor(
    () => samples.filter((sample) => sample.kind === "injected" && sample.keyDown).length >= 8,
  );
  if (unexpectedPause) throw new Error("Input arrived before the prompt.");
  if (freezeBackend) {
    if (!backend?.pid || !backend.kill("SIGSTOP")) throw new Error("Backend did not stop.");
    const state = await promisify(execFile)(
      "/bin/ps",
      ["-o", "state=", "-p", String(backend.pid)],
      { timeout: 1000 },
    );
    backendFrozen = state.stdout.trim().startsWith("T");
    if (!backendFrozen) throw new Error("Backend stop was not confirmed.");
  } else if (stalled) {
    process.stdout.write("Watch the fixture's 3, 2, 1 countdown; press only when it turns RED.\n");
    await waitFor(() => performance.now() - latestHeartbeat < 10);
    fixture.child.stdin?.write("COUNTDOWN_WAIT\n");
    await waitFor(() => countdownAtMs !== undefined);
    const cueAtPerfMs = countdownAtMs! + 3000 - (clock!.offsetMinMs + clock!.offsetMaxMs) / 2;
    await waitFor(() => performance.now() >= cueAtPerfMs);
    await waitFor(() => performance.now() - latestHeartbeat < 10);
    if (unexpectedPause || signalInterrupted) throw new Error("Input arrived before the stall.");
    // The fixture holds its red cue until renewal is fresh and we are ready to
    // block. Confirm the tiny command was flushed before blocking its pipe writer.
    // Recognition still has to fall inside the measured stall; no timing grace.
    await new Promise<void>((done, reject) => {
      fixture!.child.stdin!.write("GO\n", (error) => (error ? reject(error) : done()));
    });
    const startMs = performance.now();
    // Intentional, bounded main-thread stall. The native helper and fixture keep
    // running; no renewal or main-side stop can execute during this interval.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
    evidence.hostStall = { startMs, endMs: performance.now(), ...clock! };
  } else fixture.child.stdin?.write("GO\n");
  process.stdout.write(
    `Press Control+Command+Escape when the synthetic window turns red (${freezeBackend ? "frozen backend" : stalled ? "host stall" : "responsive host"}).\n`,
  );
  await waitFor(() => evidence.chordRecognizedAtMs !== undefined, 20000);
  if (!freezeBackend) await typing;
  await pause(750);
  try {
    await request({ op: "type", text: "x", screenshot: false });
  } catch (error) {
    evidence.pausedMutationRefused =
      error instanceof ComputerControlError &&
      error.error._tag === "Interrupted" &&
      error.error.cause === "paused";
  }
  const apps = (await request({ op: "listApps" })) as ComputerApp[];
  evidence.fixtureStillFrontmost = apps.some((app) => app.appId === appId && app.frontmost);
  evidence.leaseReleased = lease.holders().length === 0;
  fixture.child.stdin?.write("FINISH\n");
  await waitFor(() => evidence.observationEndedAtMs !== undefined);
  if (freezeBackend) {
    const state = await promisify(execFile)(
      "/bin/ps",
      ["-o", "state=", "-p", String(backend!.pid)],
      { timeout: 1000 },
    );
    evidence.backendFrozenAtStop =
      evidence.backendFrozenAtStop === true && state.stdout.trim().startsWith("T");
    backendFrozen = false;
    backend!.kill("SIGCONT");
    await Promise.race([
      typing,
      pause(5000).then(() => {
        throw new Error("Backend cleanup timed out.");
      }),
    ]);
    const result = JSON.parse(await readFile(join(root, "stop-worker-result.json"), "utf8")) as {
      mutationInterrupted?: boolean;
    };
    evidence.mutationInterrupted = result.mutationInterrupted === true;
  }
} catch {
  const status = helper.status();
  failure = signalInterrupted
    ? "signal-interrupted"
    : status.available
      ? "incomplete-measurement"
      : status.reason;
  process.exitCode = 1;
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  controller.close();
  backend?.kill("SIGCONT");
  backend?.kill();
  await helper.suspend();
  if (typing) await Promise.race([typing, pause(2000)]);
  if (backend && backend.exitCode === null && backend.signalCode === null) backend.kill("SIGKILL");
  offHelper();
  const helperClosed = await helper.closeAndWait();
  const fixtureClosed = await closeRehearsalChild(fixture?.child);
  const backendClosed = await closeRehearsalChild(backend);
  const cleanup = {
    helperClosed,
    fixtureClosed,
    backendClosed,
    confirmed: helperClosed && fixtureClosed && backendClosed,
  };
  if (root) await rm(root, { recursive: true, force: true });
  const measurement = measureStopLatency(evidence);
  if (measurement.state !== "passed" || !cleanup.confirmed) process.exitCode = 1;
  await writeFile(
    resolve(output),
    JSON.stringify(
      {
        reportVersion: 1,
        admissionId: process.env.F5_COMPUTER_CERTIFICATION_ADMISSION,
        recordedAt: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        osVersion: release(),
        helperSha256,
        scope: "unsigned-native-controller-human-physical-chord-synthetic-app",
        signed: false,
        certified: false,
        hostStalled: stalled,
        backendFrozen: freezeBackend,
        ...(failure ? { failure } : {}),
        measurement,
        cleanup,
        limitations: [
          "Measures native event creation and app delivery from helper recognition; not a hardware-to-OS interrupt measurement",
          "The first physical modifier can pause input before the complete kill chord",
          "The host-stall mode blocks this test supervisor; the backend-freeze mode SIGSTOPs a real broker/IPC worker",
          "The worker uses scripted fixture consent and no model, credentials, renderer or real overlay",
          "No real overlay, signed packaging/TCC attribution, multi-profile/display or Windows certification",
          "No key contents, raw input traces or absolute uptime timestamps are saved; release gates remain closed",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    `Physical stop report: ${resolve(output)} (${measurement.state}; release gates unchanged).\n`,
  );
}
