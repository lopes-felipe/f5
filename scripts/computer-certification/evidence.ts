import { record, digest } from "./model";
import type { Manifest, ScenarioResult } from "./model";
import { PROFILE_SCENARIO_IDS, type ScenarioInstance } from "./catalog";
import { windowlessChecks } from "./windowlessEvidence";
import { grantMemoryReceiptsComplete } from "./grantMemory";
import { sessionActionsReceiptsComplete } from "./sessionActions";
import {
  profileIsolationChecks,
  profileReadinessChecks,
  profileInspectionDiagnosticChecks,
} from "./profileIsolationEvidence";

const safeKey = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,100}$/;
const STOP_CHECKS = [
  "traceComplete",
  "clocksValid",
  "syntheticInputObserved",
  "physicalInputRecognized",
  "chordRecognized",
  "promptedBeforeInterruption",
  "typingActiveAtTrigger",
  "physicalStopUnder100Ms",
  "chordStopUnder100Ms",
  "appDeliveryStoppedUnder100Ms",
  "quietTailObserved",
  "inFlightMutationInterrupted",
  "pausedMutationRefused",
  "leaseReleased",
  "fixtureStillFrontmost",
];
function checksOf(raw: unknown): Record<string, boolean> {
  if (!record(raw) || Object.keys(raw).length > 256) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(([key, v]) => safeKey.test(key) && typeof v === "boolean"),
  ) as Record<string, boolean>;
}
/** Whitelist summaries; raw tool IO, titles, text, error strings and images never enter the suite. */
export function summarizeEvidence(
  scenario: ScenarioInstance,
  manifest: Manifest,
  raw: unknown,
  admission?: { id: string; startedAt: string; finishedAt: string },
) {
  if (
    !record(raw) ||
    raw.reportVersion !== 1 ||
    raw.platform !== manifest.identity.platform ||
    raw.helperSha256 !== manifest.identity.files.helper
  )
    throw new Error("Evidence identity mismatch");
  if (admission) {
    const recordedAt = typeof raw.recordedAt === "string" ? Date.parse(raw.recordedAt) : NaN;
    const start = Date.parse(admission.startedAt);
    const finish = Date.parse(admission.finishedAt);
    if (
      raw.admissionId !== admission.id ||
      !Number.isFinite(recordedAt) ||
      !Number.isFinite(start) ||
      !Number.isFinite(finish) ||
      finish < start ||
      recordedAt < start ||
      recordedAt > finish ||
      raw.arch !== manifest.identity.arch ||
      (scenario.selectedProvider && raw.provider !== scenario.selectedProvider)
    )
      throw new Error("Evidence admission mismatch");
  }
  let checks: Record<string, boolean> = {};
  const phase = record(raw.phaseEvidence)
    ? raw.phaseEvidence[scenario.id === "real-apps" ? "realApps" : "fixture"]
    : undefined;
  const assertions = record(phase) ? phase.checks : raw.checks;
  let passed =
    (scenario.id === "backend-stop" || (record(phase) ? phase.state : raw.state) === "passed") &&
    (!raw.failure || record(phase)) &&
    (!raw.failureStage || record(phase)) &&
    !raw.interrupted &&
    !raw.physicalInterruption;
  if (Array.isArray(raw.checks)) {
    if (raw.checks.length > 64 || !raw.checks.every(record))
      throw new Error("Invalid native check list");
    checks = Object.fromEntries(
      raw.checks.map((c, i) => ["native-" + (i + 1), c.state === "passed"]),
    );
    // Pin known complete scenarios. A single passing marker cannot stand in for the matrix.
    const expectedCount =
      scenario.id === "protected-apps" ? 13 : scenario.id === "capture" ? 7 : undefined;
    passed =
      !raw.failure &&
      !raw.failureStage &&
      !raw.physicalInterruption &&
      expectedCount !== undefined &&
      raw.checks.length === expectedCount &&
      Object.values(checks).every(Boolean);
  } else {
    checks = checksOf(assertions);
    // Don't silently discard malformed assertion values.
    if (
      scenario.id !== "backend-stop" &&
      (!record(assertions) || Object.keys(checks).length !== Object.keys(assertions).length)
    )
      passed = false;
    passed &&= scenario.expectedChecks.every((key) => checks[key] === true);
  }
  if (scenario.id === "windows-closed") {
    const receipts = windowlessChecks(raw);
    for (const [key, value] of Object.entries(receipts)) checks["receipt." + key] = value;
    passed &&=
      Object.values(receipts).every(Boolean) &&
      raw.scope === `unsigned-real-electron-${scenario.selectedProvider}-all-app-windows-closed` &&
      manifest.identity.target === "development";
  }
  if (scenario.id === "grant-memory") {
    checks.grantMemoryReceiptsComplete = grantMemoryReceiptsComplete(raw);
    passed &&=
      checks.grantMemoryReceiptsComplete &&
      manifest.identity.target === "development" &&
      raw.scope === `unsigned-real-electron-${scenario.selectedProvider}-grant-memory`;
  }
  if (scenario.id === "session-actions") {
    checks.sessionActionsReceiptsComplete = sessionActionsReceiptsComplete(raw);
    passed &&=
      checks.sessionActionsReceiptsComplete &&
      manifest.identity.target === "development" &&
      raw.scope === `unsigned-real-electron-${scenario.selectedProvider}-session-actions`;
  }
  if (PROFILE_SCENARIO_IDS.includes(scenario.id)) {
    const receipts = (
      scenario.id === "profile-inspection-diagnostic"
        ? profileInspectionDiagnosticChecks
        : scenario.id === "profile-readiness"
          ? profileReadinessChecks
          : profileIsolationChecks
    )(raw);
    for (const [key, value] of Object.entries(receipts)) checks["receipt." + key] = value;
    passed &&=
      Object.values(receipts).every(Boolean) &&
      raw.scope ===
        (scenario.id === "profile-inspection-diagnostic"
          ? "unsigned-real-electron-codex-profile-inspection-diagnostic"
          : scenario.id === "profile-readiness"
            ? "unsigned-real-electron-codex-profile-readiness"
            : "unsigned-real-electron-codex-profile-isolation") &&
      raw.provider === "codex" &&
      manifest.providers.includes("codex") &&
      manifest.identity.target === "development";
  }
  const stop = record(raw.stopMeasurement)
    ? raw.stopMeasurement
    : record(raw.measurement)
      ? raw.measurement
      : undefined;
  const measurements: Record<string, number> = {};
  if (stop) {
    const stopChecks = checksOf(stop.checks);
    for (const [key, value] of Object.entries(stopChecks)) checks["stop." + key] = value;
    passed &&=
      stop.state === "passed" &&
      STOP_CHECKS.every((key) => stopChecks[key] === true) &&
      Object.values(stopChecks).every(Boolean) &&
      !raw.failure &&
      !raw.interrupted;
    for (const key of [
      "physicalInputTailMs",
      "killChordTailMs",
      "appDeliveryTailMs",
      "hostStallDurationMs",
      "rendererFreezeDurationMs",
      "clockUncertaintyMs",
      "injectedKeyDowns",
    ]) {
      if (typeof stop[key] === "number" && Number.isFinite(stop[key]) && stop[key] >= 0)
        measurements[key] = stop[key];
    }
    for (const key of ["physicalInputTailMs", "killChordTailMs", "appDeliveryTailMs"])
      passed &&= typeof measurements[key] === "number" && measurements[key]! < 100;
    if (scenario.id === "main-stop")
      passed &&=
        stopChecks.stallClockCalibrated === true &&
        stopChecks.physicalAndChordDuringHostStall === true &&
        typeof measurements.clockUncertaintyMs === "number" &&
        measurements.clockUncertaintyMs <= 25 &&
        typeof measurements.hostStallDurationMs === "number" &&
        measurements.hostStallDurationMs > 0;
    if (scenario.id === "renderer-stop")
      passed &&=
        stopChecks.rendererClockCalibrated === true &&
        stopChecks.physicalAndChordDuringRendererFreeze === true &&
        typeof measurements.rendererFreezeDurationMs === "number" &&
        measurements.rendererFreezeDurationMs > 0;
    if (scenario.id === "backend-stop") {
      passed &&= stopChecks.backendFrozenAtStop === true;
      if (manifest.identity.platform === "win32")
        passed &&=
          stopChecks.backendClockCalibrated === true &&
          stopChecks.physicalAndChordDuringBackendFreeze === true;
    }
  } else if (["main-stop", "renderer-stop", "backend-stop"].includes(scenario.id)) {
    passed = false;
  }
  const cleanup =
    record(raw.cleanup) && raw.cleanup.confirmed === true ? "confirmed" : "unconfirmed";
  passed &&=
    cleanup === "confirmed" &&
    Object.keys(checks).length > 0 &&
    Object.values(checks).every(Boolean);
  return {
    state: passed ? ("passed" as const) : ("failed" as const),
    checks,
    measurements,
    cleanup,
    evidenceKind:
      scenario.provider || PROFILE_SCENARIO_IDS.includes(scenario.id)
        ? ("provider-desktop" as const)
        : ("native-helper" as const),
    evidenceSha256: digest(raw),
    ...(passed
      ? {}
      : { reason: cleanup !== "confirmed" ? "cleanup-unconfirmed" : "assertion-incomplete" }),
  } satisfies Pick<
    ScenarioResult,
    "state" | "checks" | "measurements" | "cleanup" | "evidenceKind" | "evidenceSha256" | "reason"
  >;
}
