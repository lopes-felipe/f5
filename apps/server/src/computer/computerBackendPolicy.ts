import { Effect, Option } from "effect";
import type { ComputerAutomationBackendStatus, ProviderKind } from "@t3tools/contracts";
import { ServerSettingsService } from "../serverSettings";
import { selectComputerBackend } from "./computerBackendSelection";
import { probeComputerBuiltin } from "./computerBuiltinAvailability";

/** Providers without computer tools have neither a probe nor a restart fingerprint. */
export function resolveProviderComputerBackendSelection(
  provider: ProviderKind | undefined,
  input: {
    enabled: boolean;
    nativeStatus: ComputerAutomationBackendStatus;
    fullAccess?: boolean;
  },
) {
  return provider === "claudeAgent" || provider === "codex"
    ? resolveComputerBackendSelection({
        ...input,
        provider: provider === "claudeAgent" ? "claude" : "codex",
      })
    : Effect.succeed(undefined);
}

/** A built-in backend is selected only with a certified record (`codex-computer`). */
export function resolveComputerBackendSelection(input: {
  provider: "claude" | "codex";
  enabled: boolean;
  nativeStatus: ComputerAutomationBackendStatus;
  /** Built-ins run unsandboxed, outside F5's approvals: Full access only. */
  fullAccess?: boolean;
}) {
  return Effect.gen(function* () {
    const service = yield* Effect.serviceOption(ServerSettingsService);
    // Background execution exists only in F5's helper: that mode forces the native backend.
    const preference = Option.isSome(service)
      ? yield* service.value.getSettings.pipe(
          Effect.map((settings) =>
            settings.computerUseExecutionMode === "background"
              ? ("f5" as const)
              : settings.computerUseBackend,
          ),
          Effect.catch(() => Effect.succeed("f5" as const)),
        )
      : "auto";
    const decision = selectComputerBackend({
      ...input,
      preference,
      platform: process.platform,
      arch: process.arch,
      builtin:
        input.enabled && preference === "auto"
          ? yield* Effect.promise(() =>
              probeComputerBuiltin({ provider: input.provider, platform: process.platform }),
            )
          : { available: false, reason: "Built-in computer control was not requested" },
    });
    const nativeCatalog =
      input.enabled &&
      (process.platform === "darwin" || process.platform === "win32") &&
      (input.nativeStatus.available ||
        !["no-host", "unsupported-platform", "os-too-old", "not-certified"].includes(
          input.nativeStatus.reason,
        ));
    const selection =
      decision.selection ??
      (nativeCatalog
        ? {
            kind: "native" as const,
            ...(preference === "auto"
              ? {
                  fallbackFrom: {
                    kind:
                      input.provider === "claude"
                        ? ("claude-builtin" as const)
                        : ("codex-builtin" as const),
                    reason: decision.builtinReason ?? "not-certified",
                  },
                }
              : {}),
          }
        : undefined);
    return {
      ...decision,
      ...(selection ? { selection } : {}),
      fingerprint: JSON.stringify({
        enabled: input.enabled,
        preference,
        // Health/handshake changes are reflected live, not by replacing a provider session.
        // An explicit built-in selection change still schedules next-turn fallback.
        builtin:
          selection?.kind === "claude-builtin" || selection?.kind === "codex-builtin"
            ? selection.kind
            : null,
        platform: process.platform,
      }),
    };
  });
}

/** Native-only reporting for ACP; deliberately has no session-restart fingerprint. */
export function resolveNativeOnlyComputerSelection(input: {
  enabled: boolean;
  nativeStatus: ComputerAutomationBackendStatus;
}) {
  return input.enabled
    ? {
        ...(input.nativeStatus.available ? { selection: { kind: "native" as const } } : {}),
        status: input.nativeStatus,
      }
    : { status: { available: false as const, reason: "disabled" as const } };
}
