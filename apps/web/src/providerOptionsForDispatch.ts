import type { ProviderKind, ProviderStartOptions } from "@t3tools/contracts";
import { parseClaudeLaunchArgs } from "@t3tools/shared/cliArgs";

import { getClaudeProjectSettings, type AppSettings } from "./appSettings";
import { resolveClaudeSubagentModel } from "./components/ChatView.logic";

type ProviderDispatchSettings = Pick<
  AppSettings,
  | "claudeBinaryPath"
  | "claudeLaunchArgs"
  | "claudeProjectSettings"
  | "codexBinaryPath"
  | "codexHomePath"
>;

export function resolveProviderOptionsForDispatch(input: {
  readonly settings: ProviderDispatchSettings;
  readonly provider: ProviderKind;
  readonly projectId: string | null | undefined;
  readonly availableModels: ReadonlyArray<{ readonly slug: string }>;
}): ProviderStartOptions | undefined {
  if (input.provider === "codex") {
    if (!input.settings.codexBinaryPath && !input.settings.codexHomePath) {
      return undefined;
    }
    return {
      codex: {
        ...(input.settings.codexBinaryPath ? { binaryPath: input.settings.codexBinaryPath } : {}),
        ...(input.settings.codexHomePath ? { homePath: input.settings.codexHomePath } : {}),
      },
    };
  }

  if (input.provider !== "claudeAgent" || !input.projectId) {
    return undefined;
  }

  const projectSettings = getClaudeProjectSettings(input.settings, input.projectId);
  const parsedLaunchArgs = parseClaudeLaunchArgs(input.settings.claudeLaunchArgs);
  if (!parsedLaunchArgs.ok) {
    console.warn(
      "[providerOptionsForDispatch] Ignoring invalid claudeLaunchArgs — open Settings to fix:",
      parsedLaunchArgs.error,
    );
  }
  const launchArgs =
    parsedLaunchArgs.ok && Object.keys(parsedLaunchArgs.args).length > 0
      ? parsedLaunchArgs.args
      : undefined;

  return {
    claudeAgent: {
      ...(input.settings.claudeBinaryPath ? { binaryPath: input.settings.claudeBinaryPath } : {}),
      subagentsEnabled: projectSettings.subagentsEnabled,
      subagentModel: resolveClaudeSubagentModel(
        projectSettings.subagentModel,
        input.availableModels,
      ),
      ...(launchArgs ? { launchArgs } : {}),
    },
  };
}
