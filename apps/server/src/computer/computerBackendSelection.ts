import type {
  ComputerAutomationBackendStatus,
  ComputerBackendKind,
  ComputerBackendSelection,
} from "@t3tools/contracts";
import { isIntegrationCertified } from "@t3tools/shared/providerIntegrationCertification";

/**
 * The shared certification records are the only gate. Claude's built-in computer use has
 * no integration (the CLI starts it only in interactive terminals), so it never qualifies.
 */
export function certifiedBuiltin(
  provider: "claude" | "codex",
  platform: string,
  arch: string = process.arch,
): boolean {
  return provider === "codex" && isIntegrationCertified("codex-computer", platform, arch);
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
/**
 * One catalog per session. `auto` with a certified, installed built-in selects it; F5-only,
 * background execution (folded into `f5` by the caller) and anything but Full access
 * select F5's native control.
 */
export function selectComputerBackend(input: {
  enabled: boolean;
  preference: "auto" | "f5";
  provider: "claude" | "codex";
  platform: string;
  arch?: string;
  fullAccess?: boolean;
  nativeStatus: ComputerAutomationBackendStatus;
  builtin: {
    available: boolean;
    reason?: string;
    version?: string;
  };
}): ComputerBackendDecision {
  if (!input.enabled) return { status: { available: false, reason: "disabled" } };
  const kind: ComputerBackendKind =
    input.provider === "claude" ? "claude-builtin" : "codex-builtin";
  const platformSupported =
    input.platform === "darwin" || (input.platform === "win32" && input.provider === "claude");
  const certified = certifiedBuiltin(input.provider, input.platform, input.arch);
  const qualifies =
    platformSupported && input.builtin.available && certified && input.fullAccess === true;
  if (input.preference === "auto" && qualifies)
    return { selection: { kind }, status: { available: true } };
  const reason = !platformSupported
    ? "unsupported-platform"
    : input.builtin.available && certified && input.fullAccess !== true
      ? "needs-full-access"
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
