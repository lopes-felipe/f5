import { assertExecutionDirectory } from "./executionDirectory";
import { Effect } from "effect";
import type { ProviderStartOptions } from "@t3tools/contracts";
import { ProviderAdapterValidationError, type ProviderAdapterError } from "../provider/Errors";
import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter";
import * as Path from "node:path";
import type { ServerConfigShape } from "../config";
import { isPathWithinRoot, safeLstat } from "../storage/storagePathSafety";
export const PROFILE_CERTIFIED_PROVIDERS = { codex: "0.144.3", claudeAgent: "0.3.261" } as const;
export async function validateManagedHome(config: ServerConfigShape, home: string): Promise<void> {
  if (config.profile?.isDefault !== false) return;
  const root = Path.join(config.stateDir, "provider-homes");
  const target = Path.resolve(home);
  if (!home || !isPathWithinRoot({ root, target }) || target === root)
    throw new Error(
      "unsupported-isolation: provider home must be inside this profile's provider-homes directory.",
    );
  let ancestor = target;
  while (isPathWithinRoot({ root, target: ancestor })) {
    if ((await safeLstat(ancestor))?.isSymbolicLink())
      throw new Error(
        "unsupported-isolation: managed provider homes cannot contain symbolic links or junctions.",
      );
    if (ancestor === root) break;
    ancestor = Path.dirname(ancestor);
  }
}

export async function certifyProvider(
  config: ServerConfigShape,
  driver: string,
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  if (config.profile?.isDefault !== false) return;
  if (driver === "claudeAgent") {
    const { isDefaultClaudeBinary } = await import("../provider/claudeSdkExecutable");
    const { dependencies } = await import("../../package.json", { with: { type: "json" } });
    if (
      !isDefaultClaudeBinary(binaryPath) ||
      dependencies["@anthropic-ai/claude-agent-sdk"] !== PROFILE_CERTIFIED_PROVIDERS.claudeAgent
    )
      throw new Error(
        "unsupported-isolation: Claude requires the bundled certified Agent SDK " +
          PROFILE_CERTIFIED_PROVIDERS.claudeAgent +
          ".",
      );
    return;
  }
  if (driver !== "codex")
    throw new Error(`unsupported-isolation: ${driver} is not certified for isolated profiles.`);
  const { resolveInvocation } = await import("../spawn/resolveCommand");
  const { runProcess } = await import("../processRunner");
  const command = resolveInvocation(binaryPath || "codex", ["--version"], environment);
  const result = await runProcess(command.file, command.args, {
    env: environment,
    timeoutMs: 15000,
    allowNonZeroExit: true,
  });
  const version = result.stdout.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
  if (result.code !== 0 || version !== PROFILE_CERTIFIED_PROVIDERS.codex)
    throw new Error(
      `unsupported-isolation: Codex ${version ?? "unknown"} is not certified. Install ${PROFILE_CERTIFIED_PROVIDERS.codex}.`,
    );
}

/** The instance owns executable and credential storage, including per-turn and one-off calls. */
export function protectProfileAdapter(
  adapter: ProviderAdapterShape<ProviderAdapterError>,
  server: ServerConfigShape,
  config: { binaryPath: string; homePath: string },
): ProviderAdapterShape<ProviderAdapterError> {
  if (!server.profile) return adapter;
  const protect = <
    T extends {
      readonly cwd?: string | undefined;
      readonly providerOptions?: ProviderStartOptions | undefined;
    },
  >(
    input: T,
  ): Effect.Effect<T, ProviderAdapterValidationError> =>
    Effect.tryPromise({
      try: async () => {
        if (input.cwd) await assertExecutionDirectory(input.cwd);
        if (server.profile?.isDefault !== false) return input;
        const requested =
          adapter.provider === "codex"
            ? input.providerOptions?.codex
            : input.providerOptions?.claudeAgent;
        if (requested?.binaryPath && requested.binaryPath !== config.binaryPath)
          throw new Error("A turn cannot change the instance's certified executable.");
        if (
          input.providerOptions?.codex?.homePath &&
          Path.resolve(input.providerOptions.codex.homePath) !== Path.resolve(config.homePath)
        )
          throw new Error("A turn cannot change its profile account home.");
        return {
          ...input,
          providerOptions: {
            ...input.providerOptions,
            ...(adapter.provider === "codex"
              ? {
                  codex: {
                    ...requested,
                    binaryPath: config.binaryPath,
                    homePath: config.homePath,
                  },
                }
              : { claudeAgent: { ...requested, binaryPath: config.binaryPath } }),
          },
        };
      },
      catch: (cause) =>
        new ProviderAdapterValidationError({
          provider: adapter.provider,
          operation: "profileIsolation",
          issue: String(cause),
        }),
    });
  return {
    ...adapter,
    startSession: (input) => protect(input).pipe(Effect.flatMap(adapter.startSession)),
    ...(adapter.runOneOffPrompt
      ? {
          runOneOffPrompt: (input) => protect(input).pipe(Effect.flatMap(adapter.runOneOffPrompt!)),
        }
      : {}),
    ...(adapter.compactConversation
      ? {
          compactConversation: (input) =>
            protect(input).pipe(Effect.flatMap(adapter.compactConversation!)),
        }
      : {}),
  };
}
