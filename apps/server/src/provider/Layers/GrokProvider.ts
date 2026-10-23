import type { CustomModelSetting } from "@t3tools/contracts";
import type { GrokSettings, ModelCapabilities, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { Effect, Option, Result } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveInvocationEffect } from "../../spawn/resolveCommand.ts";

import { resolveGrokAcpBaseModelId } from "../acp/GrokAcpSupport.ts";
import { compareCliVersions } from "../cliVersion.ts";
import {
  buildServerProvider,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// Older Grok CLIs do not work with F5's ACP integration.
const MINIMUM_GROK_VERSION = "1.0.13";
const GROK_MODELS_TIMEOUT_MS = 8_000;

const GROK_PRESENTATION = {
  displayName: "Grok",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const GROK_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "grok-build",
    name: "Grok Build",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialGrokProviderSnapshot(grokSettings: GrokSettings): ServerProviderDraft {
  const checkedAt = new Date().toISOString();
  const models = grokModelsFromSettings(grokSettings.customModels);

  if (!grokSettings.enabled) {
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Grok is disabled in T3 Code settings.",
      },
    });
  }

  return buildServerProvider({
    presentation: GROK_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking Grok CLI availability...",
    },
  });
}

function grokModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = GROK_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, "grok", customModels ?? [], EMPTY_CAPABILITIES);
}

/** Health checks must not authenticate ACP or start workspace MCP servers. */
export function parseGrokModelsCliOutput(output: string) {
  const authenticated = /not authenticated|not logged in/i.test(output)
    ? false
    : /you are logged in/i.test(output)
      ? true
      : null;
  const models = new Map<string, ServerProviderModel>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*[*-]\s+(grok-[a-z0-9._-]+)(?:\s|$)/i.exec(line);
    if (!match?.[1]) continue;
    const slug = resolveGrokAcpBaseModelId(match[1]);
    if (!models.has(slug))
      models.set(slug, { slug, name: slug, isCustom: false, capabilities: EMPTY_CAPABILITIES });
  }
  return { authenticated, models: [...models.values()] };
}

/**
 * Grok checks for a newer CLI when it launches. Health and skill probes run in
 * the background, so an update they start is invisible, and on Windows it
 * opens a console window for npm. `GROK_DISABLE_AUTOUPDATER=1` suppresses it
 * for one process. Sessions and text generation keep the caller's environment.
 */
export function grokProbeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...environment, GROK_DISABLE_AUTOUPDATER: "1" };
}

const runGrokCliCommand = (
  grokSettings: GrokSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = grokSettings.binaryPath || "grok";
    const probeEnvironment = grokProbeEnvironment(environment);
    const invocation = yield* resolveInvocationEffect(command, args, probeEnvironment);
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(invocation.file, [...invocation.args], {
        env: probeEnvironment,
      }),
    );
  });

export const checkGrokProviderStatus = Effect.fn("checkGrokProviderStatus")(function* (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = new Date().toISOString();
  const fallbackModels = grokModelsFromSettings(grokSettings.customModels);

  if (!grokSettings.enabled) {
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Grok is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runGrokCliCommand(grokSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error =
      versionResult.failure instanceof Error
        ? versionResult.failure
        : new Error(String(versionResult.failure));
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Grok CLI (`grok`) is not installed or not on PATH."
          : `Failed to execute Grok CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Grok CLI is installed but timed out while running `grok --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    const detail = detailFromResult(versionOutput);
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: detail
          ? `Grok CLI is installed but failed to run. ${detail}`
          : "Grok CLI is installed but failed to run.",
      },
    });
  }
  if (version && compareCliVersions(version, MINIMUM_GROK_VERSION) < 0) {
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Grok CLI v${version} is too old. Upgrade to v${MINIMUM_GROK_VERSION} or newer.`,
      },
    });
  }

  const modelsResult = yield* runGrokCliCommand(grokSettings, ["models"], environment).pipe(
    Effect.timeoutOption(GROK_MODELS_TIMEOUT_MS),
    Effect.result,
  );
  const result =
    Result.isSuccess(modelsResult) && Option.isSome(modelsResult.success)
      ? modelsResult.success.value
      : undefined;
  const parsed =
    result?.code === 0 ? parseGrokModelsCliOutput(`${result.stdout}\n${result.stderr}`) : undefined;
  const authenticated = environment.XAI_API_KEY?.trim() ? true : parsed?.authenticated;
  return buildServerProvider({
    presentation: GROK_PRESENTATION,
    enabled: true,
    checkedAt,
    models: parsed?.models.length
      ? grokModelsFromSettings(grokSettings.customModels, parsed.models)
      : fallbackModels,
    probe: {
      installed: true,
      version,
      status: authenticated === true && parsed ? "ready" : "warning",
      auth: {
        status:
          authenticated === true
            ? "authenticated"
            : authenticated === false
              ? "unauthenticated"
              : "unknown",
      },
      ...(authenticated === false
        ? { message: "Grok is not logged in. Run `grok login` in a terminal." }
        : !parsed
          ? {
              message:
                "Grok is installed, but the model and login check did not complete. Refresh to retry.",
            }
          : {}),
    },
  });
});
