import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { release, tmpdir } from "node:os";
import { promisify } from "node:util";
import { createRehearsalFixture } from "./rehearsalFixture";
import { RehearsalChordObservation } from "./rehearsalChordObservation";

// Human-operated, passive observation only: no helper/provider, permissions
// request, lease, permit, OS input injection or process freeze.
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const output = outputIndex < 0 ? undefined : args[outputIndex + 1];
if (process.platform !== "darwin" || process.env.F5_CHORD_DIAGNOSTIC !== "1" || !output) {
  process.stderr.write(
    "Human coordination required: F5_CHORD_DIAGNOSTIC=1 bun apps/desktop/src/computer/rehearseChordMacos.ts --output <new report.json>\n",
  );
  process.exit(1);
}
await writeFile(resolve(output), "", { flag: "wx" });
const root = await mkdtemp(join(tmpdir(), "f5-passive-chord-"));
const exec = promisify(execFile);
const source = resolve(import.meta.dirname, "../../native/macos/Fixtures/StopLatencyFixture.swift");
const trace = new RehearsalChordObservation();
let fixture: Awaited<ReturnType<typeof createRehearsalFixture>> | undefined;
let stage = "preparation";
let failureStage: string | undefined;
let metadata: Record<string, unknown> = {};
let interrupted = false;
const interrupt = () => {
  interrupted = true;
  fixture?.child.kill();
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function waitFor(condition: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (
      interrupted ||
      trace.invalid ||
      !trace.monitorHealthy ||
      (fixture && (fixture.child.exitCode !== null || fixture.child.signalCode !== null)) ||
      Date.now() >= deadline
    )
      throw new Error("Passive chord check interrupted or timed out.");
    await delay(10);
  }
}
try {
  const repo = resolve(import.meta.dirname, "../../../..");
  metadata = {
    repositoryCommit: (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim(),
    workingTreeDirty: Boolean(
      (await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout.trim(),
    ),
    sourceHashes: Object.fromEntries(
      await Promise.all(
        [
          ["rehearsal", import.meta.filename],
          ["fixture", source],
          ["fixtureLauncher", join(import.meta.dirname, "rehearsalFixture.ts")],
          ["observation", join(import.meta.dirname, "rehearsalChordObservation.ts")],
        ].map(async ([name, file]) => [
          name!,
          createHash("sha256")
            .update(await readFile(file!))
            .digest("hex"),
        ]),
      ),
    ),
  };
  fixture = await createRehearsalFixture({
    root,
    appId: `org.example.passive-chord.${randomUUID()}`,
    sourceFile: source,
    observeChord: true,
    diagnoseChord: true,
    passiveChord: true,
  });
  fixture.child.stdin?.on("error", () => {
    trace.invalid = true;
  });
  let buffer = "";
  fixture.child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line === "FIXTURE_READY") continue;
      try {
        trace.receive(JSON.parse(line));
      } catch {
        trace.invalid = true;
      }
    }
    if (buffer.length > 4096) {
      trace.invalid = true;
      buffer = "";
    }
  });
  stage = "passive-chord-observation";
  process.stdout.write(
    "Wait for the observer window to turn RED, then press Control + Command + Escape once. No agent input is running.\n",
  );
  fixture.child.stdin?.write("COUNTDOWN\n");
  await waitFor(() => trace.chordObserved || trace.invalid || !trace.monitorHealthy, 15000);
  await delay(500);
  if (trace.invalid || !trace.monitorHealthy) throw new Error("Incomplete passive observation.");
  stage = "frontmost-receipt";
  fixture.child.stdin?.write("FINISH\n");
  await waitFor(() => trace.finished, 1000);
  if (!trace.summary().fixtureStillFrontmost) throw new Error("Fixture focus changed.");
  stage = "finished";
} catch {
  failureStage = stage;
} finally {
  // A missing chord still needs an independent focus receipt; otherwise the
  // diagnostic cannot distinguish absent input from a window losing focus.
  if (fixture && !interrupted && !trace.finished && fixture.child.exitCode === null) {
    fixture.child.stdin?.write("FINISH\n");
    try {
      await waitFor(() => trace.finished, 1000);
    } catch {
      /* Receipt stays explicitly unobserved. */
    }
  }
  fixture?.child.kill();
  await rm(root, { recursive: true, force: true });
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  const observation = trace.summary();
  const passed =
    !failureStage &&
    !interrupted &&
    observation.traceValid &&
    observation.monitorHealthy &&
    observation.chordObserved &&
    observation.candidates.some((candidate) => candidate.control && candidate.command) &&
    observation.fixtureStillFrontmost;
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
        scope: "unsigned-passive-fixed-chord-observation",
        signed: false,
        certified: false,
        state: passed ? "passed" : "failed",
        interrupted,
        fixtureStarted: Boolean(fixture),
        ...(failureStage ? { failureStage } : {}),
        observation,
        limitations: [
          "No helper, provider, consent, lease, permit, typing or process freeze",
          "Escape modifier booleans and relative timings only; no characters, key codes, app content or raw packets",
          "Does not establish stop latency, global-shortcut coexistence during a lease or any release certification",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  process.stdout.write(
    `Passive chord check finished. You can use your computer again. Report: ${resolve(output)} (${passed ? "passed" : "failed"}).\n`,
  );
  if (!passed) process.exitCode = 1;
}
