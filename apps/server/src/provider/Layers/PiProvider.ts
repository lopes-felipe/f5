import { tmpdir } from "node:os";
import type { PiSettings, ServerProviderModel } from "@t3tools/contracts";
import { Effect } from "effect";
import { runProcess } from "../../processRunner.ts";
import { compareCliVersions } from "../cliVersion.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { probePiCatalog } from "../pi/PiMetadata.ts";
import { PiRpcError } from "../pi/PiRpc.ts";
import { EMPTY_PI_MODEL_CAPABILITIES } from "../pi/thinkingCapabilities.ts";
import { buildPiRpcLaunch } from "../pi/launch.ts";

/** First published Pi package with both persisted tree reads and native settlement hooks. */
export const MINIMUM_PI_VERSION = "0.80.5";
export const piVersionSupportsF5 = (version: string) =>
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) &&
  compareCliVersions(version, MINIMUM_PI_VERSION) >= 0;
const presentation = { displayName: "Pi", showInteractionModeToggle: false } as const;
export const piModelsFromSettings = (
  settings: PiSettings,
  discovered: readonly ServerProviderModel[] = [],
) =>
  providerModelsFromSettings(
    [
      {
        slug: "default",
        name: "Pi default",
        isCustom: false,
        capabilities: EMPTY_PI_MODEL_CAPABILITIES,
      },
      ...discovered,
    ],
    "pi",
    settings.customModels,
    EMPTY_PI_MODEL_CAPABILITIES,
  );

export function buildInitialPiProviderSnapshot(settings: PiSettings): ServerProviderDraft {
  return buildServerProvider({
    presentation,
    enabled: settings.enabled,
    checkedAt: new Date().toISOString(),
    models: piModelsFromSettings(settings),
    probe: {
      installed: settings.enabled,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled ? "Checking Pi CLI availability…" : "Pi is disabled.",
    },
  });
}

export const readPiVersion = (binaryPath: string, environment: NodeJS.ProcessEnv) =>
  Effect.tryPromise({
    try: (signal) =>
      runProcess(binaryPath || "pi", ["--version"], {
        cwd: tmpdir(),
        env: buildPiRpcLaunch({
          launchArgs: [],
          environment,
          extensionPath: undefined,
          mcpSession: undefined,
        }).env,
        timeoutMs: 4000,
        maxBufferBytes: 4096,
        signal,
      }),
    catch: (cause) =>
      new PiRpcError({
        operation: isCommandMissingCause(cause) ? "version-missing" : "version",
        detail: "Pi version could not be read.",
      }),
  }).pipe(
    Effect.flatMap((result) => {
      const version = result.stdout.match(/\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)?.[1];
      return version && result.code === 0 && !result.timedOut
        ? Effect.succeed(version)
        : Effect.fail(
            new PiRpcError({ operation: "version", detail: "Pi returned no valid version." }),
          );
    }),
  );

export const checkPiProviderStatus = (
  settings: PiSettings,
  environment: NodeJS.ProcessEnv,
  beforeLaunch?: Effect.Effect<void, PiRpcError, import("effect").Scope.Scope>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (!settings.enabled) return buildInitialPiProviderSnapshot(settings);
      const versionResult = yield* Effect.gen(function* () {
        if (beforeLaunch) yield* beforeLaunch;
        return yield* readPiVersion(settings.binaryPath, environment);
      }).pipe(Effect.result);
      if (versionResult._tag === "Failure")
        return buildServerProvider({
          presentation,
          enabled: true,
          checkedAt: new Date().toISOString(),
          models: piModelsFromSettings(settings),
          probe: {
            installed: versionResult.failure.operation !== "version-missing",
            version: null,
            status: "error",
            auth: { status: "unknown" },
            message:
              "Pi CLI is unavailable. Install Pi and sign in in its terminal UI, then refresh.",
          },
        });
      const version = versionResult.success;
      if (!piVersionSupportsF5(version))
        return buildServerProvider({
          presentation,
          enabled: true,
          checkedAt: new Date().toISOString(),
          models: piModelsFromSettings(settings),
          probe: {
            installed: true,
            version,
            status: "error",
            auth: { status: "unknown" },
            message: `Pi ${MINIMUM_PI_VERSION} or newer is required. Run pi update --self in a terminal.`,
          },
        });
      const result = yield* probePiCatalog(settings, environment).pipe(Effect.result);
      return buildServerProvider({
        presentation,
        enabled: true,
        checkedAt: new Date().toISOString(),
        models: piModelsFromSettings(
          settings,
          result._tag === "Success" ? result.success.models : [],
        ),
        ...(result._tag === "Success"
          ? { slashCommands: result.success.slashCommands, skills: result.success.skills }
          : {}),
        probe: {
          installed: true,
          version,
          status: result._tag === "Success" ? "ready" : "warning",
          auth: { status: "unknown" },
          message:
            result._tag === "Success"
              ? "Pi is available. Authentication is managed by Pi; a model catalog does not prove credentials are valid."
              : "Pi RPC discovery failed or exceeded 15 seconds. Check its installation and terminal sign-in.",
        },
      });
    }),
  );
