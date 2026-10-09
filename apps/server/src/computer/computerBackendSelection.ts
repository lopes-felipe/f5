import type {
  ComputerAutomationBackendStatus,
  ComputerBackendKind,
  ComputerBackendSelection,
} from "@t3tools/contracts";

/** Certification records are evidence, never a feature flag a project can set. */
export interface BuiltinComputerCertification {
  readonly provider: "claude" | "codex";
  readonly platform: "darwin" | "win32";
  readonly minVersion: string;
  readonly maxVersion: string;
  readonly manifestHash: string;
  readonly evidence: string;
  readonly consent: boolean;
  readonly preExecutionVeto: boolean;
  readonly stop: boolean;
  readonly observation: boolean;
  readonly f5Isolation: boolean;
  readonly profileIsolation: boolean;
}
export const BUILTIN_COMPUTER_CERTIFICATIONS: ReadonlyArray<BuiltinComputerCertification> = [];
export const CODEX_COMPUTER_USE_CERTIFIED = false;
function versionParts(version: string): number[] | undefined {
  if (!/^\d+(?:\.\d+){0,3}$/.test(version)) return undefined;
  return version.split(".").map(Number);
}
function compareVersion(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta) return delta;
  }
  return 0;
}
export function certifiedBuiltin(
  record: BuiltinComputerCertification | undefined,
  observed?: { version?: string; manifestHash?: string },
): boolean {
  const version = versionParts(observed?.version ?? "");
  const min = versionParts(record?.minVersion ?? "");
  const max = versionParts(record?.maxVersion ?? "");
  return (
    !!record &&
    !!version &&
    !!min &&
    !!max &&
    compareVersion(version, min) >= 0 &&
    compareVersion(version, max) <= 0 &&
    /^[a-f0-9]{64}$/.test(record.manifestHash) &&
    observed?.manifestHash === record.manifestHash &&
    !!record.evidence &&
    record.consent &&
    record.preExecutionVeto &&
    record.stop &&
    record.observation &&
    record.f5Isolation &&
    record.profileIsolation
  );
}
export type ComputerBackendDecision =
  | {
      readonly selection: ComputerBackendSelection;
      readonly status: ComputerAutomationBackendStatus;
    }
  | {
      readonly selection?: undefined;
      readonly status: ComputerAutomationBackendStatus;
      readonly builtinReason?: string;
    };
export function selectComputerBackend(input: {
  enabled: boolean;
  preference: "auto" | "f5";
  provider: "claude" | "codex";
  platform: string;
  nativeStatus: ComputerAutomationBackendStatus;
  builtin: {
    available: boolean;
    reason?: string;
    certification?: BuiltinComputerCertification;
    version?: string;
    manifestHash?: string;
  };
}): ComputerBackendDecision {
  if (!input.enabled) return { status: { available: false, reason: "disabled" } };
  const kind: ComputerBackendKind =
    input.provider === "claude" ? "claude-builtin" : "codex-builtin";
  const platformSupported =
    input.platform === "darwin" || (input.platform === "win32" && input.provider === "claude");
  const qualifies =
    platformSupported &&
    input.builtin.available &&
    input.builtin.certification?.provider === input.provider &&
    input.builtin.certification.platform === input.platform &&
    certifiedBuiltin(input.builtin.certification, input.builtin);
  if (input.preference === "auto" && qualifies)
    return { selection: { kind }, status: { available: true } };
  const reason = !platformSupported
    ? "unsupported-platform"
    : (input.builtin.reason ?? "not-certified");
  if (input.nativeStatus.available)
    return {
      selection: {
        kind: "native",
        ...(input.preference === "auto" ? { fallbackFrom: { kind, reason } } : {}),
      },
      status: input.nativeStatus,
    };
  return {
    status: input.nativeStatus,
    ...(input.preference === "auto" ? { builtinReason: reason } : {}),
  };
}
