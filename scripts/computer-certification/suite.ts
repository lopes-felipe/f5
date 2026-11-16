import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { GROUPS, PROFILE_SCENARIO_IDS, type Group } from "./catalog";
import {
  coverage,
  decodeResult,
  digest,
  pending,
  sameIdentity,
  record,
  type Manifest,
  type ScenarioResult,
} from "./model";
import { commandsFor, type Launches } from "./commands";
import { identify, hashFile, type Target } from "./identity";
import { execute } from "./process";
import { preflight } from "./preflight";
import {
  attemptName,
  loadManifest,
  loadResults,
  lockSuite,
  readJson,
  saveResult,
  writeExclusive,
} from "./store";
import { summarizeEvidence } from "./evidence";
import { inventory } from "./catalog";

export async function suiteIdentity(target: Target, launches: Launches) {
  const base = await identify(target);
  const providers: Record<string, string> = {};
  for (const [name, launch] of Object.entries(launches))
    if (launch) providers["provider-" + name] = await hashFile(launch.binary);
  return { ...base, files: { ...base.files, ...providers } };
}
export async function recoverInterrupted(
  directory: string,
  manifest: Manifest,
  results: ScenarioResult[],
) {
  for (const name of (await readdir(directory)).filter((n) => n.endsWith(".started.json")).sort()) {
    const started = decodeResult(await readJson(join(directory, name)), manifest);
    if (results.some((r) => r.scenario === started.scenario && r.attempt === started.attempt))
      continue;
    const failed: ScenarioResult = {
      ...started,
      state: "failed",
      finishedAt: new Date().toISOString(),
      reason: "outcome-unknown",
      cleanup: "unconfirmed",
    };
    await saveResult(directory, manifest, failed);
    results.push(failed);
  }
}
export async function runSuite(options: {
  directory: string;
  target: Target;
  launches: Launches;
  group: Group;
  resume: boolean;
  retry?: string;
  scenario?: string;
  operatorReady: boolean;
}) {
  const { directory, target, launches, group } = options;
  if (!GROUPS.includes(group)) throw new Error("Unknown certification group");
  const manifest = await loadManifest(directory);
  const unlock = await lockSuite(directory, options.resume);
  try {
    if (!sameIdentity(manifest.identity, await suiteIdentity(target, launches)))
      throw new Error("Artifact/source identity changed; prepare a new suite");
    const results = await loadResults(directory, manifest);
    if (options.resume) await recoverInterrupted(directory, manifest, results);
    else if (
      (await readdir(directory)).some(
        (n) =>
          n.endsWith(".started.json") &&
          !results.some((r) => attemptName(r.scenario, r.attempt) + ".started.json" === n),
      )
    )
      throw new Error("Interrupted admission; use resume");
    const selected = pending(manifest, results, group, options.retry, options.scenario);
    if (options.retry && selected.length === 0)
      throw new Error("Retry must name an existing nonpassed scenario in this group");
    // No readiness question until current prerequisites are observed. All computer
    // mutation remains behind the real host/helper/provider authorization paths.
    const observed = group === "automated" ? undefined : await preflight(target, launches);
    let ready = options.operatorReady;
    const newlyRecorded = new Set<string>();
    for (const scenario of selected) {
      if (newlyRecorded.has(scenario.key)) continue;
      const attempt =
        Math.max(0, ...results.filter((r) => r.scenario === scenario.key).map((r) => r.attempt)) +
        1;
      const start = new Date().toISOString();
      const admissionId = randomUUID();
      const base: ScenarioResult = {
        version: 1,
        suiteId: manifest.suiteId,
        scenario: scenario.key,
        attempt,
        identityHash: digest(manifest.identity),
        state: "not-run",
        evidenceKind:
          scenario.group === "automated"
            ? "automated"
            : scenario.provider || PROFILE_SCENARIO_IDS.includes(scenario.id)
              ? "provider-desktop"
              : "native-helper",
        startedAt: start,
        finishedAt: start,
        checks: {},
        measurements: {},
        cleanup: "not-needed",
      };
      const output = join(directory, attemptName(scenario.key, attempt) + ".raw.json");
      const paired =
        target.platform === "darwin" && scenario.id === "fixture-workflow"
          ? inventory(manifest.identity.platform, manifest.providers).find(
              (s) =>
                s.id === "real-apps" &&
                s.selectedProvider === scenario.selectedProvider &&
                selected.some((candidate) => candidate.key === s.key) &&
                !results.some((r) => r.scenario === s.key),
            )
          : undefined;
      const commands = commandsFor(scenario, target, output, launches, process.platform, !!paired);
      let blocker = typeof commands === "string" ? commands : undefined;
      if (!blocker && group !== "automated") {
        if (!observed?.checks["platform"]) blocker = "interactive-platform-unavailable";
        else if (!observed.checks["helper-permissions"])
          blocker = "helper-prerequisites-unavailable";
        else if (
          (scenario.selectedProvider || PROFILE_SCENARIO_IDS.includes(scenario.id)) &&
          !observed.checks[(scenario.selectedProvider ?? "codex") + "-ready"]
        )
          blocker = "provider-authentication-unavailable";
        else if (manifest.identity.dirty) blocker = "dirty-build-identity";
        else if (!manifest.prerequisites["fixtures-ready"])
          blocker = "fixture-prerequisites-unavailable";
      }
      if (blocker) {
        if (blocker === "helper-prerequisites-unavailable" && observed) {
          const status = observed.helperStatus;
          process.stdout.write(
            "Helper readiness: " + (status.available ? "available" : status.reason) + "\n",
          );
        }
        const result: ScenarioResult = { ...base, state: "blocked", reason: blocker };
        await saveResult(directory, manifest, result);
        results.push(result);
        process.stdout.write(scenario.key + ": blocked (" + blocker + ")\n");
        continue;
      }
      if (scenario.operator && !ready) {
        if (!process.stdin.isTTY) throw new Error("Operator readiness required before input");
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const answer = await prompt.question(
            "Ready for " +
              group +
              "? Approve only named test apps, stay idle and follow persistent window cues. Type READY or stop: ",
          );
          ready = answer.trim() === "READY";
        } finally {
          prompt.close();
        }
        if (!ready) break;
      }
      // Reserve before spawn; a killed coordinator cannot silently rerun input.
      await writeExclusive(join(directory, attemptName(scenario.key, attempt) + ".started.json"), {
        ...base,
        admissionId,
      });
      const pairedBase: ScenarioResult | undefined = paired
        ? { ...base, scenario: paired.key, attempt: 1 }
        : undefined;
      if (pairedBase)
        await writeExclusive(
          join(directory, attemptName(pairedBase.scenario, pairedBase.attempt) + ".started.json"),
          pairedBase,
        );
      process.stdout.write("Running " + scenario.key + "\n");
      const checks: Record<string, boolean> = {};
      let executionFailed = false;
      let interrupted = false;
      for (const command of commands as Exclude<typeof commands, string>) {
        const result = await execute(
          {
            ...command,
            env: { ...command.env, F5_COMPUTER_CERTIFICATION_ADMISSION: admissionId },
          },
          target.repo,
        );
        if (command.check)
          checks[command.check] = result.code === 0 && !result.interrupted && !result.timedOut;
        if (result.code !== 0 || result.interrupted || result.timedOut) {
          executionFailed = true;
          interrupted = result.interrupted;
          break;
        }
      }
      let result: ScenarioResult;
      if (scenario.group === "automated") {
        result = {
          ...base,
          state: executionFailed ? "failed" : "passed",
          checks,
          finishedAt: new Date().toISOString(),
          evidenceSha256: digest(checks),
          ...(executionFailed ? { reason: "command-failed" } : {}),
        };
      } else {
        try {
          const summary = summarizeEvidence(scenario, manifest, await readJson(output), {
            id: admissionId,
            startedAt: start,
            finishedAt: new Date().toISOString(),
          });
          result = {
            ...base,
            ...summary,
            finishedAt: new Date().toISOString(),
            ...(executionFailed && (!paired || interrupted || summary.state !== "passed")
              ? {
                  state: "failed" as const,
                  reason: interrupted ? "outcome-unknown" : "command-failed",
                }
              : {}),
          };
        } catch {
          result = {
            ...base,
            state: "failed",
            finishedAt: new Date().toISOString(),
            cleanup: "unconfirmed",
            reason: interrupted ? "outcome-unknown" : "invalid-or-missing-receipt",
          };
        }
      }
      const currentIdentity = await suiteIdentity(target, launches);
      if (!sameIdentity(manifest.identity, currentIdentity)) {
        await writeExclusive(
          join(directory, attemptName(scenario.key, attempt) + ".identity-change.json"),
          { expected: manifest.identity, observed: currentIdentity },
        );
        result = {
          ...result,
          state: "failed",
          finishedAt: new Date().toISOString(),
          reason: "identity-changed",
          cleanup: scenario.operator ? "unconfirmed" : "not-needed",
        };
      }
      await saveResult(directory, manifest, result);
      results.push(result);
      if (paired && pairedBase) {
        let second: ScenarioResult;
        try {
          const raw = await readJson(output);
          if (!record(raw) || !record(raw.phaseEvidence) || !record(raw.phaseEvidence.realApps)) {
            second = {
              ...pairedBase,
              state: "not-run",
              finishedAt: new Date().toISOString(),
              reason: "prior-phase-incomplete",
            };
          } else {
            second = {
              ...pairedBase,
              ...summarizeEvidence(paired, manifest, raw, {
                id: admissionId,
                startedAt: start,
                finishedAt: new Date().toISOString(),
              }),
              finishedAt: new Date().toISOString(),
            };
            if (interrupted || result.reason === "identity-changed")
              second = {
                ...second,
                state: "failed",
                reason: "outcome-unknown",
                cleanup: "unconfirmed",
              };
          }
        } catch {
          second = {
            ...pairedBase,
            state: "failed",
            finishedAt: new Date().toISOString(),
            reason: "invalid-or-missing-receipt",
            cleanup: "unconfirmed",
          };
        }
        await saveResult(directory, manifest, second);
        results.push(second);
        newlyRecorded.add(paired.key);
        process.stdout.write(paired.key + ": " + second.state + "\n");
        if (second.state !== "passed") executionFailed = true;
      }
      process.stdout.write(scenario.key + ": " + result.state + "\n");
      // Stop the group on failures. No later phase may execute after uncertain input.
      if (result.state !== "passed" || executionFailed) break;
    }
    return coverage(manifest, results);
  } finally {
    await unlock();
  }
}
