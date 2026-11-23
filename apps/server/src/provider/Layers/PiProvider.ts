import { tmpdir } from "node:os";
import type { PiSettings, ServerProviderModel } from "@t3tools/contracts";
import { Effect, Option, Schema } from "effect";
import { runProcess } from "../../processRunner.ts";
import { compareCliVersions } from "../cliVersion.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { PI_CATALOG_PROBE_TIMEOUT_MS, probePiCatalog, type PiCatalog } from "../pi/PiMetadata.ts";
import { PiRpcError } from "../pi/PiRpc.ts";
import { EMPTY_PI_MODEL_CAPABILITIES } from "../pi/thinkingCapabilities.ts";
import { buildPiRpcLaunch, resolvePiLaunchArgs } from "../pi/launch.ts";

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

const runPiStatusCommand = (
  binaryPath: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
) =>
  runProcess(binaryPath || "pi", args, {
    cwd: tmpdir(),
    env: buildPiRpcLaunch({
      launchArgs: [],
      environment,
      extensionPath: undefined,
      mcpSession: undefined,
    }).env,
    timeoutMs: 10_000,
    maxBufferBytes: 4096,
    // Pi reports missing credentials as JSON with a nonzero exit code.
    allowNonZeroExit: true,
    signal,
  });

const decodeAuthCheck = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ reason: Schema.optional(Schema.String) })),
);

const describePiCatalogCredentials = (
  catalog: PiCatalog,
  settings: PiSettings,
  environment: NodeJS.ProcessEnv,
  version: string | null,
) =>
  Effect.gen(function* () {
    const model = catalog.unavailableActiveModel;
    if (!model) {
      return catalog.models.length === 0
        ? "Pi has no usable models. Run Pi in a terminal and use /login or configure an API key."
        : undefined;
    }
    const label = `Pi default (${model.provider}/${model.id})`;
    const unavailable = `${label} uses ${model.provider}, which has no available models in Pi. Choose another model or check that provider's setup and the Pi launch arguments.`;
    const launch = resolvePiLaunchArgs(settings.launchArgs);
    // This check cannot see extension providers or keys supplied at launch.
    if (
      version === null ||
      compareCliVersions(version, "0.84.1") < 0 ||
      !launch.ok ||
      launch.args.includes("--api-key")
    )
      return unavailable;
    const output = yield* Effect.tryPromise((signal) =>
      runPiStatusCommand(
        settings.binaryPath,
        ["auth", "check", "--provider", model.provider, "--json", "--no-refresh"],
        environment,
        signal,
      ),
    ).pipe(Effect.option);
    const missingCredentials = Option.exists(
      Option.flatMap(output, (result) =>
        result.timedOut || result.code === null ? Option.none() : decodeAuthCheck(result.stdout),
      ),
      (check) => check.reason === "credentials_not_configured",
    );
    return missingCredentials
      ? `${label} has no credentials configured for ${model.provider}. Choose another model or run Pi in a terminal and use /login or configure its API key.`
      : unavailable;
  });

export const buildPiCatalogSnapshot = (
  catalog: PiCatalog,
  settings: PiSettings,
  environment: NodeJS.ProcessEnv,
  version: string | null,
  fallbackMessage: string,
) =>
  Effect.gen(function* () {
    const message = yield* describePiCatalogCredentials(catalog, settings, environment, version);
    return buildServerProvider({
      presentation,
      enabled: settings.enabled,
      checkedAt: new Date().toISOString(),
      models: piModelsFromSettings(settings, catalog.models),
      slashCommands: catalog.slashCommands,
      skills: catalog.skills,
      probe: {
        installed: true,
        version,
        status: catalog.models.length > 0 ? "ready" : "warning",
        auth: { status: "unknown" },
        message: message ?? fallbackMessage,
      },
    });
  });

export const readPiVersion = (binaryPath: string, environment: NodeJS.ProcessEnv) =>
  Effect.tryPromise({
    try: (signal) => runPiStatusCommand(binaryPath, ["--version"], environment, signal),
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
      if (result._tag === "Success")
        return yield* buildPiCatalogSnapshot(
          result.success,
          settings,
          environment,
          version,
          "Pi is available. Authentication is managed by Pi; a model catalog does not prove credentials are valid.",
        );
      return buildServerProvider({
        presentation,
        enabled: true,
        checkedAt: new Date().toISOString(),
        models: piModelsFromSettings(settings),
        probe: {
          installed: true,
          version,
          status: "warning",
          auth: { status: "unknown" },
          message: `Pi RPC discovery failed or exceeded ${PI_CATALOG_PROBE_TIMEOUT_MS / 1000} seconds. Check its installation and terminal sign-in.`,
        },
      });
    }),
  );
