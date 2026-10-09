import { Effect, Option } from "effect";
import type { ComputerAutomationBackendStatus } from "@t3tools/contracts";
import { ServerSettingsService } from "../serverSettings";
import { selectComputerBackend } from "./computerBackendSelection";
import { probeComputerBuiltin } from "./computerBuiltinAvailability";

/** Built-in enablement remains unavailable until a supported, certified mechanism is recorded. */
export function resolveComputerBackendSelection(input: {
  provider: "claude" | "codex";
  enabled: boolean;
  nativeStatus: ComputerAutomationBackendStatus;
}) {
  return Effect.gen(function* () {
    const service = yield* Effect.serviceOption(ServerSettingsService);
    const preference = Option.isSome(service)
      ? yield* service.value.getSettings.pipe(
          Effect.map((settings) => settings.computerUseBackend),
          Effect.catch(() => Effect.succeed("f5" as const)),
        )
      : "auto";
    const decision = selectComputerBackend({
      ...input,
      preference,
      platform: process.platform,
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
        kind: selection?.kind,
        toolsInstalled: selection?.kind === "native",
      }),
    };
  });
}
