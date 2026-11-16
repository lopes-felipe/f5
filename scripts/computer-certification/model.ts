import { createHash } from "node:crypto";
import { ComputerDisplay } from "@t3tools/contracts";
import { Schema } from "effect";
import {
  inventory,
  NATIVE_REQUIREMENTS,
  type EvidenceKind,
  type Group,
  type Platform,
  type Provider,
  type ResultState,
  type ScenarioInstance,
} from "./catalog";

export interface Identity {
  readonly platform: Platform;
  readonly arch: string;
  readonly commit: string;
  readonly dirty: boolean;
  readonly target: "development" | "installed";
  readonly files: Readonly<Record<string, string>>;
}
export interface Manifest {
  readonly version: 1;
  readonly suiteId: string;
  readonly preparedAt: string;
  readonly identity: Identity;
  readonly providers: readonly Provider[];
  readonly prerequisites: Readonly<Record<string, boolean>>;
  readonly observations?: {
    readonly osVersion: string;
    readonly providerVersions: Readonly<Record<string, string>>;
    readonly displays: readonly ComputerDisplay[];
  };
}
export interface ScenarioResult {
  readonly version: 1;
  readonly suiteId: string;
  readonly scenario: string;
  readonly attempt: number;
  readonly identityHash: string;
  readonly state: ResultState;
  readonly evidenceKind: EvidenceKind;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly checks: Readonly<Record<string, boolean>>;
  readonly measurements: Readonly<Record<string, number>>;
  readonly cleanup: "confirmed" | "unconfirmed" | "not-needed";
  readonly reason?: string;
  readonly evidenceSha256?: string;
}

export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const sameIdentity = (a: Identity, b: Identity) => digest(a) === digest(b);
export const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const sha = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const timestamp = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const safeId = (value: unknown) =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,100}$/.test(value);
const booleans = (value: unknown): value is Record<string, boolean> =>
  record(value) &&
  Object.keys(value).length <= 256 &&
  Object.entries(value).every(([key, v]) => safeId(key) && typeof v === "boolean");

export function decodeManifest(value: unknown): Manifest {
  if (
    !record(value) ||
    value.version !== 1 ||
    !safeId(value.suiteId) ||
    !timestamp(value.preparedAt) ||
    !record(value.identity) ||
    !["darwin", "win32"].includes(String(value.identity.platform)) ||
    typeof value.identity.arch !== "string" ||
    !/^[a-z0-9_-]{1,16}$/.test(value.identity.arch) ||
    typeof value.identity.commit !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.identity.commit) ||
    typeof value.identity.dirty !== "boolean" ||
    !["development", "installed"].includes(String(value.identity.target)) ||
    !record(value.identity.files) ||
    Object.keys(value.identity.files).length === 0 ||
    !Object.entries(value.identity.files).every(([key, hash]) => safeId(key) && sha(hash)) ||
    !Array.isArray(value.providers) ||
    value.providers.length < 1 ||
    value.providers.length > 2 ||
    new Set(value.providers).size !== value.providers.length ||
    !value.providers.every((provider) => provider === "claude" || provider === "codex") ||
    !booleans(value.prerequisites)
  )
    throw new Error("Invalid certification manifest");
  // Explicit reconstruction discards account paths, raw packets and extra fields.
  let observations: Manifest["observations"];
  if (value.observations !== undefined) {
    if (
      !record(value.observations) ||
      typeof value.observations.osVersion !== "string" ||
      !/^[a-zA-Z0-9._-]{1,100}$/.test(value.observations.osVersion) ||
      !record(value.observations.providerVersions) ||
      !Object.entries(value.observations.providerVersions).every(
        ([key, version]) =>
          ["claude", "codex"].includes(key) &&
          typeof version === "string" &&
          /^\d+\.\d+\.\d+$/.test(version),
      ) ||
      !Array.isArray(value.observations.displays) ||
      value.observations.displays.length > 16
    )
      throw new Error("Invalid certification observations");
    observations = {
      osVersion: value.observations.osVersion,
      providerVersions: value.observations.providerVersions as Record<string, string>,
      displays: Schema.decodeUnknownSync(Schema.Array(ComputerDisplay))(
        value.observations.displays,
      ),
    };
  }
  return {
    version: 1,
    suiteId: value.suiteId as string,
    preparedAt: value.preparedAt as string,
    identity: {
      platform: value.identity.platform as Platform,
      arch: value.identity.arch,
      commit: value.identity.commit,
      dirty: value.identity.dirty,
      target: value.identity.target as Identity["target"],
      files: value.identity.files as Record<string, string>,
    },
    providers: value.providers as Provider[],
    prerequisites: value.prerequisites,
    ...(observations ? { observations } : {}),
  };
}
export function decodeResult(value: unknown, manifest: Manifest): ScenarioResult {
  if (
    !record(value) ||
    value.version !== 1 ||
    value.suiteId !== manifest.suiteId ||
    !inventory(manifest.identity.platform, manifest.providers).some(
      (s) => s.key === value.scenario,
    ) ||
    !Number.isInteger(value.attempt) ||
    Number(value.attempt) < 1 ||
    Number(value.attempt) > 999 ||
    !sha(value.identityHash) ||
    value.identityHash !== digest(manifest.identity) ||
    !["passed", "failed", "blocked", "not-run"].includes(String(value.state)) ||
    !["automated", "native-helper", "provider-desktop", "installed"].includes(
      String(value.evidenceKind),
    ) ||
    !timestamp(value.startedAt) ||
    !timestamp(value.finishedAt) ||
    Date.parse(String(value.finishedAt)) < Date.parse(String(value.startedAt)) ||
    !booleans(value.checks) ||
    !record(value.measurements) ||
    Object.keys(value.measurements).length > 64 ||
    !Object.entries(value.measurements).every(
      ([k, v]) => safeId(k) && typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e9,
    ) ||
    !["confirmed", "unconfirmed", "not-needed"].includes(String(value.cleanup)) ||
    (value.reason !== undefined && !safeId(value.reason)) ||
    (value.evidenceSha256 !== undefined && !sha(value.evidenceSha256))
  )
    throw new Error("Invalid certification result");
  const scenario = inventory(manifest.identity.platform, manifest.providers).find(
    (s) => s.key === value.scenario,
  )!;
  if (
    value.state === "passed" &&
    (Object.keys(value.checks).length === 0 ||
      !Object.values(value.checks).every(Boolean) ||
      scenario.expectedChecks.some(
        (key) => (value.checks as Record<string, unknown>)[key] !== true,
      ) ||
      value.cleanup === "unconfirmed" ||
      (scenario.operator && value.cleanup !== "confirmed") ||
      !sha(value.evidenceSha256) ||
      (manifest.identity.target === "development" && value.evidenceKind === "installed") ||
      (scenario.group === "automated" && value.evidenceKind !== "automated") ||
      (scenario.provider &&
        scenario.group !== "automated" &&
        !["provider-desktop", "installed"].includes(String(value.evidenceKind))))
  )
    throw new Error("Incomplete certification proof");
  return {
    version: 1,
    suiteId: manifest.suiteId,
    scenario: String(value.scenario),
    attempt: Number(value.attempt),
    identityHash: String(value.identityHash),
    state: value.state as ResultState,
    evidenceKind: value.evidenceKind as EvidenceKind,
    startedAt: String(value.startedAt),
    finishedAt: String(value.finishedAt),
    checks: value.checks,
    measurements: value.measurements as Record<string, number>,
    cleanup: value.cleanup as ScenarioResult["cleanup"],
    ...(value.reason ? { reason: String(value.reason) } : {}),
    ...(value.evidenceSha256 ? { evidenceSha256: String(value.evidenceSha256) } : {}),
  };
}

export function coverage(manifest: Manifest, results: readonly ScenarioResult[]) {
  const scenarios = inventory(manifest.identity.platform, manifest.providers);
  const latest = new Map<string, ScenarioResult>();
  const attempts = new Set<string>();
  for (const result of results) {
    const valid = decodeResult(result, manifest);
    const attemptKey = valid.scenario + "." + valid.attempt;
    if (attempts.has(attemptKey)) throw new Error("Duplicate certification attempt");
    attempts.add(attemptKey);
    const prior = latest.get(valid.scenario);
    if (!prior || prior.attempt < valid.attempt) latest.set(valid.scenario, valid);
  }
  const rows = scenarios.map((scenario) => ({
    scenario: scenario.key,
    group: scenario.group,
    title: scenario.title,
    requirements: scenario.requirements,
    state: latest.get(scenario.key)?.state ?? "not-run",
    evidenceKind: latest.get(scenario.key)?.evidenceKind,
    reason: latest.get(scenario.key)?.reason,
    attempts: results.filter((r) => r.scenario === scenario.key).length,
  }));
  const requirements = [
    ...NATIVE_REQUIREMENTS,
    ...(manifest.identity.platform === "darwin" ? ["windowless"] : []),
    "builtin",
    "chrome",
  ].map((requirement) => {
    const required = rows.filter((row) => row.requirements.includes(requirement));
    return {
      requirement,
      state: required.length && required.every((r) => r.state === "passed") ? "passed" : "pending",
      scenarios: required.map((r) => r.scenario),
    };
  });
  const native = rows.filter((r) => r.group !== "builtin" && r.group !== "chrome");
  const signed =
    manifest.prerequisites["app-signature"] === true &&
    manifest.prerequisites["helper-signature"] === true;
  const installedProof = native
    .filter((r) => r.group !== "automated")
    .every((r) => r.evidenceKind === "installed");
  return {
    version: 1,
    suiteId: manifest.suiteId,
    platform: manifest.identity.platform,
    identityHash: digest(manifest.identity),
    developmentOnly: manifest.identity.target === "development",
    rows,
    requirements,
    nativeReleaseReady:
      manifest.identity.target === "installed" &&
      !manifest.identity.dirty &&
      manifest.providers.length === 2 &&
      signed &&
      installedProof &&
      native.every((r) => r.state === "passed") &&
      manifest.prerequisites["security-review"] === true &&
      manifest.prerequisites["remote-ci"] === true,
    gatesChanged: false,
  };
}

export function pending(
  manifest: Manifest,
  results: readonly ScenarioResult[],
  group: Group,
  retry: string | undefined,
  selectedScenario?: string,
): ScenarioInstance[] {
  if (selectedScenario && retry)
    throw new Error("Invalid combination of scenario selection and retry");
  if (
    selectedScenario &&
    !inventory(manifest.identity.platform, manifest.providers).some(
      (scenario) => scenario.group === group && scenario.key === selectedScenario,
    )
  )
    throw new Error("Unknown scenario in this group");
  const latest = coverage(manifest, results).rows;
  return inventory(manifest.identity.platform, manifest.providers).filter((scenario) => {
    if (scenario.group !== group) return false;
    if (selectedScenario && scenario.key !== selectedScenario) return false;
    const row = latest.find((r) => r.scenario === scenario.key)!;
    if (retry) return scenario.key === retry && row.state !== "passed";
    // Never repeat completed, failed, blocked or ambiguously interrupted work automatically.
    return row.attempts === 0;
  });
}
