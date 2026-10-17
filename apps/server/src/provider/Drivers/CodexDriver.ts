import { makeCodexCatalogCache } from "../codexCatalogCache";
import { ComputerAutomationBroker } from "../../computer/ComputerAutomationBroker";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { UsageConsumeResetCreditResult } from "@t3tools/contracts";
import { CodexControlClient } from "../../codex/CodexControlClient.ts";
import { makeCodexAccountUsage } from "../../usage/codexAccountUsage.ts";
import {
  codexIsolationCompatibility,
  validateManagedHome,
  validateProviderCompatibility,
  protectProfileAdapter,
} from "../../profiles/providerIsolation";

import {
  CodexSettings,
  MODEL_OPTIONS_BY_PROVIDER,
  ProviderDriverKind,
  type ModelCapabilities,
  type ProviderStartOptions,
  type ServerProvider,
  type ServerProviderSkill,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { Duration, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeCodexTextGeneration } from "../../git/Layers/CodexTextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import { PreviewMcpHttpServer } from "../../mcp/PreviewMcpHttpServer.ts";
import {
  checkCodexProviderPreflight,
  type ProviderPreflightStatus,
} from "../Layers/ProviderHealth.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCodexAdapter } from "../Layers/CodexAdapter.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { buildAccountExecutionEnvironment } from "../../providerProcessEnv";
import { makeInstanceInstallTargetResolver } from "../providerInstallChannel.ts";
import type { ProviderDriver, ProviderInstance } from "../ProviderDriver.ts";
import { fingerprintableProviderEnvironment } from "../sensitiveFingerprint.ts";
import {
  codexContinuationIdentity,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "./CodexHomeLayout.ts";
import { parseLaunchArgv } from "@t3tools/shared/cliArgs";
import { createModelCapabilities } from "@t3tools/shared/model";
import { mergeReportedProviderModels, providerModelsFromSettings } from "../providerSnapshot.ts";
import { type CodexInstanceCatalog, probeCodexInstanceCatalog } from "../codexModelCatalog.ts";
import { readCodexInventory } from "../codexInventory.ts";

const DRIVER_KIND = ProviderDriverKind.make("codex");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
export { CODEX_CATALOG_TTL_MS, decideCodexCatalogProbe } from "../codexCatalogCache";
export type CodexDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | PreviewMcpHttpServer
  | ServerConfig;

const CODEX_CUSTOM_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

export const codexModels = (settings: CodexSettings): ServerProvider["models"] =>
  providerModelsFromSettings(
    MODEL_OPTIONS_BY_PROVIDER.codex.map((model) => ({
      slug: model.slug,
      name: model.name,
      isCustom: false,
      capabilities: null,
    })),
    "codex",
    settings.customModels,
    CODEX_CUSTOM_MODEL_CAPABILITIES,
  );

export function providerOptionsFromCodexSettings(settings: CodexSettings): ProviderStartOptions {
  const launchArgs = parseLaunchArgv(settings.launchArgs);
  if (!launchArgs.ok) {
    throw new Error(`Invalid Codex launch arguments: ${launchArgs.error}`);
  }
  return {
    codex: {
      ...(settings.binaryPath.trim().length > 0 ? { binaryPath: settings.binaryPath } : {}),
      ...(settings.homePath.trim().length > 0 ? { homePath: settings.homePath } : {}),
      ...(launchArgs.argv.length > 0 ? { launchArgs: [...launchArgs.argv] } : {}),
    },
  };
}

export function withCodexIsolationCompatibility(
  status: ProviderPreflightStatus,
  isolated: boolean,
): ProviderPreflightStatus {
  if (!isolated || !status.available) return status;
  const compatibility = codexIsolationCompatibility(status.version);
  const compatibilityMessage = compatibility.supported
    ? compatibility.message
    : `unsupported-isolation: ${compatibility.message}`;
  const message = [status.message, compatibilityMessage].filter(Boolean).join(" ");
  return {
    ...status,
    ...(!compatibility.supported
      ? { available: false, status: "error" as const, failureReason: "unsupportedVersion" as const }
      : {}),
    ...(message ? { message } : {}),
  };
}

const toSnapshot = (input: {
  readonly instance: Pick<
    ProviderInstance,
    "instanceId" | "driverKind" | "displayName" | "accentColor"
  >;
  readonly settings: CodexSettings;
  readonly continuationKey?: string;
  readonly checkedAt?: string;
  readonly status?: ProviderPreflightStatus;
  readonly catalog?: CodexInstanceCatalog;
  readonly skills?: ReadonlyArray<ServerProviderSkill>;
}): ServerProvider => {
  const status = input.status;
  const enabled = input.settings.enabled;
  const displayName = input.instance.displayName ?? "Codex";
  const available = status?.available ?? false;
  return {
    instanceId: input.instance.instanceId,
    driver: input.instance.driverKind,
    displayName,
    ...(input.instance.accentColor ? { accentColor: input.instance.accentColor } : {}),
    continuation: {
      groupKey: input.continuationKey ?? `codex:instance:${input.instance.instanceId}`,
    },
    showInteractionModeToggle: true,
    enabled,
    installed: enabled ? available : false,
    version: status?.version ?? null,
    status: enabled ? (status?.status ?? "warning") : "disabled",
    auth: { status: status?.authStatus ?? "unknown" },
    checkedAt: status?.checkedAt ?? input.checkedAt ?? new Date().toISOString(),
    ...(status?.message ? { message: status.message } : {}),
    ...(!enabled || !available
      ? {
          availability: "unavailable" as const,
          unavailableReason: !enabled
            ? "Provider instance is disabled."
            : (status?.message ?? "Codex CLI is unavailable."),
        }
      : { availability: "available" as const }),
    models: mergeReportedProviderModels(
      codexModels(input.settings),
      input.catalog?.models,
      input.catalog,
    ),
    ...(status
      ? {
          modelCatalog: input.catalog
            ? {
                status: input.catalog.complete ? ("complete" as const) : ("partial" as const),
                ...(input.catalog.complete
                  ? { lastSuccessAt: input.catalog.fetchedAt }
                  : { firstPartialAt: input.catalog.fetchedAt }),
              }
            : { status: "failed" as const },
        }
      : {}),
    slashCommands: [],
    // Instance-private skills (CODEX_HOME, system, admin); repo skills are project-shared.
    skills: input.skills ?? input.catalog?.skills ?? [],
  };
};

export const CodexDriver: ProviderDriver<CodexSettings, CodexDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Codex",
    supportsMultipleInstances: true,
  },
  configSchema: CodexSettings,
  defaultConfig: (): CodexSettings => Schema.decodeSync(CodexSettings)({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const eventLoggers = yield* ProviderEventLoggers;
      const previewMcpHttpServer = yield* PreviewMcpHttpServer;
      const computerAutomationBroker = yield* Effect.serviceOption(ComputerAutomationBroker);
      const serverConfig = yield* ServerConfig;
      yield* Effect.tryPromise({
        try: () => validateManagedHome(serverConfig, config.homePath),
        catch: (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: String(cause),
            cause,
          }),
      });
      const homeLayout = yield* resolveCodexHomeLayout(
        config,
        serverConfig.profile?.isDefault === false,
      );
      yield* materializeCodexShadowHome(homeLayout).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: cause.message,
              cause,
            }),
        ),
      );

      const effectiveConfig = {
        ...config,
        enabled,
        homePath: homeLayout.effectiveHomePath ?? config.homePath,
      } satisfies CodexSettings;
      const processEnvironment = buildAccountExecutionEnvironment({
        purpose: "provider",
        profile: serverConfig.profile,
        stateDir: serverConfig.stateDir,
        baseEnv: process.env,
        instance: environment,
      });
      yield* Effect.tryPromise({
        try: () =>
          validateProviderCompatibility(
            serverConfig,
            DRIVER_KIND,
            config.binaryPath,
            processEnvironment,
          ),
        catch: (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: String(cause),
            cause,
          }),
      });
      const defaultProviderOptions = yield* Effect.try({
        try: () => providerOptionsFromCodexSettings(effectiveConfig),
        catch: (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
      const launchIdentity = createHash("sha256")
        .update(
          JSON.stringify({
            version: 1,
            providerOptions: defaultProviderOptions.codex ?? {},
            environment: fingerprintableProviderEnvironment(environment),
          }),
        )
        .digest("hex");
      const instanceIdentity = {
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
      } satisfies Pick<
        ProviderInstance,
        "instanceId" | "driverKind" | "displayName" | "accentColor"
      >;

      let effectiveModels: ReadonlyArray<ServerProviderModel> = [];
      const adapter = yield* makeCodexAdapter({
        getEffectiveModelCapabilities: () =>
          new Map(
            effectiveModels.flatMap((model) =>
              model.capabilities ? [[model.slug, model.capabilities] as const] : [],
            ),
          ),
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        previewMcpHttpServer,
        ...(computerAutomationBroker._tag === "Some"
          ? { computerAutomationBroker: computerAutomationBroker.value }
          : {}),
        defaultProviderOptions,
        processEnvironment,
        instanceId,
      });
      const consumeResetCredit = (idempotencyKey: string) =>
        Effect.gen(function* () {
          const client = yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: (signal) =>
                CodexControlClient.create(
                  {
                    binaryPath: effectiveConfig.binaryPath,
                    homePath: effectiveConfig.homePath,
                    ...(defaultProviderOptions.codex?.launchArgs
                      ? { launchArgs: defaultProviderOptions.codex.launchArgs }
                      : {}),
                    cwd: process.cwd(),
                    processEnvironment,
                  },
                  signal,
                ),
              catch: (cause) =>
                new ProviderDriverError({
                  driver: DRIVER_KIND,
                  instanceId,
                  detail: "Could not open the Codex account connection.",
                  cause,
                }),
            }),
            (client) => Effect.sync(() => client.close()),
          );
          return yield* Effect.tryPromise({
            try: () => client.consumeResetCredit(idempotencyKey),
            catch: (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: "Could not redeem a Codex reset credit.",
                cause,
              }),
          }).pipe(
            Effect.flatMap((value) =>
              Schema.decodeUnknownEffect(UsageConsumeResetCreditResult)(value),
            ),
            Effect.mapError(
              (cause) =>
                new ProviderDriverError({
                  driver: DRIVER_KIND,
                  instanceId,
                  detail: "Invalid reset-credit response.",
                  cause,
                }),
            ),
          );
        }).pipe(Effect.scoped);
      // Shared by reset-credit idempotency and persisted account history.
      const resetCreditIdentity = `codex-home:${createHash("sha256")
        .update(
          (() => {
            const home =
              effectiveConfig.homePath.trim() ||
              processEnvironment.CODEX_HOME ||
              homeLayout.sharedHomePath;
            try {
              return realpathSync(home);
            } catch {
              return home;
            }
          })(),
        )
        .digest("hex")}`;
      const accountUsage = yield* makeCodexAccountUsage(
        { instanceId, displayName: displayName ?? "Codex", enabled, identity: resetCreditIdentity },
        {
          cwd: serverConfig.cwd,
          processEnvironment,
          ...(defaultProviderOptions.codex?.binaryPath
            ? { binaryPath: defaultProviderOptions.codex.binaryPath }
            : {}),
          ...(defaultProviderOptions.codex?.homePath
            ? { homePath: defaultProviderOptions.codex.homePath }
            : {}),
          ...(defaultProviderOptions.codex?.launchArgs
            ? { launchArgs: defaultProviderOptions.codex.launchArgs }
            : {}),
        },
      );
      const textGeneration = yield* makeCodexTextGeneration(
        effectiveConfig,
        processEnvironment,
        (model) =>
          Effect.sync(() => effectiveModels.find((row) => row.slug === model)?.capabilities),
      );
      const catalogCache = yield* makeCodexCatalogCache(() =>
        Effect.tryPromise({
          try: (signal) =>
            probeCodexInstanceCatalog(
              {
                binaryPath: effectiveConfig.binaryPath,
                homePath: effectiveConfig.homePath,
                ...(defaultProviderOptions.codex?.launchArgs
                  ? { launchArgs: defaultProviderOptions.codex.launchArgs }
                  : {}),
                cwd: serverConfig.cwd,
                processEnvironment,
              },
              undefined,
              signal,
            ),
          catch: (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        }).pipe(
          Effect.tap((catalog) =>
            catalog.anomaly
              ? Effect.logWarning("codex model catalog is partial", {
                  instanceId,
                  anomaly: catalog.anomaly,
                })
              : Effect.void,
          ),
          Effect.tapError((error) =>
            Effect.logWarning("codex catalog probe failed", { instanceId, cause: error.detail }),
          ),
        ),
      );
      const checkProvider = checkCodexProviderPreflight({
        providerOptions: defaultProviderOptions,
        processEnvironment,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.flatMap((rawStatus) =>
          Effect.gen(function* () {
            const status = withCodexIsolationCompatibility(
              rawStatus,
              serverConfig.profile?.isDefault === false,
            );
            const catalog =
              enabled && status.available && status.version
                ? yield* catalogCache.read(status.version)
                : undefined;
            const skills = yield* catalogCache.readSkills(status.version);
            return toSnapshot({
              instance: instanceIdentity,
              settings: effectiveConfig,
              continuationKey: homeLayout.continuationKey,
              status,
              ...(catalog ? { catalog } : {}),
              skills,
            });
          }),
        ),
      );

      const snapshot = yield* makeManagedServerProvider<CodexSettings>({
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) =>
          toSnapshot({
            instance: instanceIdentity,
            settings,
            continuationKey: homeLayout.continuationKey,
          }),
        checkProvider,
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Codex snapshot: ${cause.message}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        resolveInstallTarget: makeInstanceInstallTargetResolver({
          driver: DRIVER_KIND,
          binaryPath: effectiveConfig.binaryPath,
          resolutionEnvironment: processEnvironment,
          instanceEnvironment: environment,
          instanceId,
        }),
        continuationIdentity: codexContinuationIdentity(homeLayout),
        launchIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter: protectProfileAdapter(adapter, serverConfig, effectiveConfig),
        textGeneration,
        updateModelCatalog: (models) =>
          Effect.sync(() => {
            effectiveModels = models;
          }),
        invalidateModelCatalog: catalogCache.invalidate,
        resetCreditIdentity,
        consumeResetCredit,
        accountUsage,
        inventory: ({ projectRoot }) =>
          Effect.tryPromise({
            try: () =>
              readCodexInventory(
                {
                  binaryPath: effectiveConfig.binaryPath,
                  homePath: effectiveConfig.homePath,
                  ...(defaultProviderOptions.codex?.launchArgs
                    ? { launchArgs: defaultProviderOptions.codex.launchArgs }
                    : {}),
                  cwd: serverConfig.cwd,
                  processEnvironment,
                },
                { projectRoot },
              ),
            catch: (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail:
                  cause instanceof Error ? cause.message : "Could not read the Codex inventory.",
                cause,
              }),
          }).pipe(Effect.map((inventory) => ({ ...inventory, agents: [] }))),
      } satisfies ProviderInstance;
    }),
};
