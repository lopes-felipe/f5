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
} from "@t3tools/contracts";
import { Duration, Effect, FileSystem, Path, Ref, Schema, Semaphore, Stream } from "effect";
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
const CODEX_CATALOG_FAILURE_BACKOFF_MS = 30 * 60 * 1000;

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
    models: mergeReportedProviderModels(codexModels(input.settings), input.catalog?.models),
    slashCommands: [],
    // Instance-private skills (CODEX_HOME, system, admin); repo skills are project-shared.
    skills: input.catalog?.skills ?? [],
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

      const adapter = yield* makeCodexAdapter({
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        previewMcpHttpServer,
        ...(computerAutomationBroker._tag === "Some"
          ? { computerAutomationBroker: computerAutomationBroker.value }
          : {}),
        defaultProviderOptions,
        processEnvironment,
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
      const accountUsage = yield* makeCodexAccountUsage(
        { instanceId, displayName: displayName ?? "Codex", enabled },
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
      const textGeneration = yield* makeCodexTextGeneration(effectiveConfig, processEnvironment);
      // One catalog probe per instance and CLI version: models change with the
      // executable, not with the five-minute status refresh.
      const instanceCatalog = yield* Ref.make<{
        readonly version: string;
        readonly catalog: CodexInstanceCatalog;
      } | null>(null);
      // A failed probe is not retried for the same CLI version until the
      // backoff elapses, so refreshes do not respawn the app-server each time.
      const catalogFailure = yield* Ref.make<{
        readonly version: string;
        readonly failedAt: number;
      } | null>(null);
      // Concurrent refreshes share one probe instead of spawning several.
      const catalogProbeLock = yield* Semaphore.make(1);
      const catalogFor = (status: ProviderPreflightStatus) =>
        Effect.gen(function* () {
          if (!enabled || !status.available || !status.version) return undefined;
          const cached = yield* Ref.get(instanceCatalog);
          if (cached?.version === status.version) return cached.catalog;
          const failure = yield* Ref.get(catalogFailure);
          if (
            failure?.version === status.version &&
            Date.now() - failure.failedAt < CODEX_CATALOG_FAILURE_BACKOFF_MS
          )
            return cached?.catalog;
          const probed = yield* Effect.tryPromise({
            try: () =>
              probeCodexInstanceCatalog({
                binaryPath: effectiveConfig.binaryPath,
                homePath: effectiveConfig.homePath,
                ...(defaultProviderOptions.codex?.launchArgs
                  ? { launchArgs: defaultProviderOptions.codex.launchArgs }
                  : {}),
                cwd: serverConfig.cwd,
                processEnvironment,
              }),
            catch: (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          }).pipe(
            Effect.tapError((error) =>
              Effect.logWarning("codex catalog probe failed; using built-in models", {
                instanceId,
                cause: error.detail,
              }),
            ),
            Effect.option,
          );
          if (probed._tag === "None") {
            yield* Ref.set(catalogFailure, { version: status.version, failedAt: Date.now() });
            return cached?.catalog;
          }
          yield* Ref.set(catalogFailure, null);
          yield* Ref.set(instanceCatalog, { version: status.version, catalog: probed.value });
          return probed.value;
        }).pipe(catalogProbeLock.withPermits(1));
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
            const catalog = yield* catalogFor(status);
            return toSnapshot({
              instance: instanceIdentity,
              settings: effectiveConfig,
              continuationKey: homeLayout.continuationKey,
              status,
              ...(catalog ? { catalog } : {}),
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
        continuationIdentity: codexContinuationIdentity(homeLayout),
        launchIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter: protectProfileAdapter(adapter, serverConfig, effectiveConfig),
        textGeneration,
        resetCreditIdentity: `codex-home:${createHash("sha256")
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
          .digest("hex")}`,
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
