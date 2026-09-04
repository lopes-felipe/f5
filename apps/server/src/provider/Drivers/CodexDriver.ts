import { createHash } from "node:crypto";

import {
  CodexSettings,
  MODEL_OPTIONS_BY_PROVIDER,
  ProviderDriverKind,
  type ModelCapabilities,
  type ProviderStartOptions,
  type ServerProvider,
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
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import type { ProviderDriver, ProviderInstance } from "../ProviderDriver.ts";
import { fingerprintableProviderEnvironment } from "../sensitiveFingerprint.ts";
import {
  codexContinuationIdentity,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "./CodexHomeLayout.ts";
import { parseLaunchArgv } from "@t3tools/shared/cliArgs";
import { createModelCapabilities } from "@t3tools/shared/model";
import { providerModelsFromSettings } from "../providerSnapshot.ts";

const DRIVER_KIND = ProviderDriverKind.make("codex");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

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

const toSnapshot = (input: {
  readonly instance: Pick<
    ProviderInstance,
    "instanceId" | "driverKind" | "displayName" | "accentColor"
  >;
  readonly settings: CodexSettings;
  readonly continuationKey?: string;
  readonly checkedAt?: string;
  readonly status?: ProviderPreflightStatus;
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
    models: codexModels(input.settings),
    slashCommands: [],
    skills: [],
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
      const homeLayout = yield* resolveCodexHomeLayout(config);
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
      const processEnvironment = mergeProviderInstanceEnvironment(environment);
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
        defaultProviderOptions,
        processEnvironment,
      });
      const textGeneration = yield* makeCodexTextGeneration(effectiveConfig, processEnvironment);
      const checkProvider = checkCodexProviderPreflight({
        providerOptions: defaultProviderOptions,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.map((status) =>
          toSnapshot({
            instance: instanceIdentity,
            settings: effectiveConfig,
            continuationKey: homeLayout.continuationKey,
            status,
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
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
