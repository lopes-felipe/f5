import {
  AcpSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { buildServerProvider, providerModelsFromSettings } from "../providerSnapshot.ts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { Duration, Effect, FileSystem, Option, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as AcpErrors from "effect-acp/errors";
import { ServerConfig } from "../../config.ts";
import { buildAccountExecutionEnvironment } from "../../providerProcessEnv.ts";
import { acquireAccountAdmission } from "../../profiles/ProviderAccountGuard.ts";
import { makeGrokTextGeneration } from "../../git/Layers/GrokTextGeneration.ts";
import { PreviewMcpHttpServer } from "../../mcp/PreviewMcpHttpServer";
import { ProviderDriverError } from "../Errors.ts";
import { makeGrokAdapter } from "../Layers/GrokAdapter.ts";
import { checkCustomAcpProvider } from "../Layers/CustomAcpProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { customAcpModels, makeCustomAcpRuntime } from "../acp/CustomAcpSupport.ts";
import type { GrokAcpRuntimeInput } from "../acp/GrokAcpSupport.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";

const driverKind = ProviderDriverKind.make("acp");
export type AcpDriverEnv =
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | ServerConfig
  | ProviderEventLoggers;
export const AcpDriver: ProviderDriver<AcpSettings, AcpDriverEnv> = {
  driverKind,
  metadata: { displayName: "Custom ACP agent", supportsMultipleInstances: true },
  configSchema: AcpSettings,
  defaultConfig: () => ({ command: "", args: [], env: {}, customModels: [] }),
  create: ({ instanceId, displayName, accentColor, enabled, config, environment }) =>
    Effect.gen(function* () {
      const server = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = buildAccountExecutionEnvironment({
        purpose: "provider",
        profile: server.profile,
        stateDir: server.stateDir,
        baseEnv: process.env,
        instance: [
          ...Object.entries(config.env).map(([name, value]) => ({ name, value, sensitive: false })),
          ...environment,
        ],
      });
      const continuationIdentity = defaultProviderContinuationIdentity({ driverKind, instanceId });
      const normalizeModel = (model: string | null | undefined) => model?.trim() || "acp-default";
      const makeRuntime = (input: GrokAcpRuntimeInput) =>
        makeCustomAcpRuntime(config, { ...input, environment: processEnv });
      let models: ReadonlyArray<ServerProviderModel> = [
        {
          slug: "acp-default",
          name: "Agent default",
          isCustom: false,
          capabilities: createModelCapabilities({ optionDescriptors: [] }),
        },
      ];
      let refreshSnapshot: Effect.Effect<void> = Effect.void;
      const preview = Option.getOrUndefined(yield* Effect.serviceOption(PreviewMcpHttpServer));
      const adapterSettings = {
        enabled,
        binaryPath: config.command,
        customModels: config.customModels,
      };
      const adapter = yield* makeGrokAdapter(adapterSettings, {
        provider: "acp",
        instanceId,
        environment: processEnv,
        makeRuntime,
        normalizeModel,
        ...(preview ? { previewMcpHttpServer: preview } : {}),
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        onRuntimeReady: (runtime) =>
          Effect.gen(function* () {
            const discovered = customAcpModels(yield* runtime.getConfigOptions);
            if (discovered.length) {
              models = discovered;
              yield* refreshSnapshot;
            }
          }),
      });
      const textGeneration = yield* makeGrokTextGeneration(adapterSettings, processEnv, {
        makeRuntime: (input) =>
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.try({
                try: () => acquireAccountAdmission(server.stateDir, instanceId),
                catch: (cause) =>
                  new AcpErrors.AcpTransportError({
                    cause,
                    detail:
                      "Account change in progress. Retry metadata generation after setup finishes.",
                  }),
              }),
              (release) => Effect.sync(release),
            );
            const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "f5-acp-metadata-" }).pipe(
              Effect.mapError(
                (cause) =>
                  new AcpErrors.AcpTransportError({
                    cause,
                    detail: "Could not create metadata workspace.",
                  }),
              ),
            );
            return yield* makeRuntime({ ...input, cwd });
          }),
        normalizeModel,
        useAccountDefaultModel: true,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make(instanceId),
          model: "acp-default",
        },
      });
      const stamp = (base: ReturnType<typeof buildServerProvider>) => ({
        ...base,
        models: providerModelsFromSettings(
          models,
          "acp",
          config.customModels,
          createModelCapabilities({ optionDescriptors: [] }),
        ),
        instanceId,
        driver: driverKind,
        ...(displayName ? { displayName } : {}),
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
      });
      const check = Effect.suspend(() =>
        checkCustomAcpProvider(config, processEnv, enabled, models).pipe(
          Effect.map(stamp),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      );
      const initial = stamp(
        buildServerProvider({
          presentation: { displayName: "Custom ACP agent", showInteractionModeToggle: true },
          enabled,
          checkedAt: new Date().toISOString(),
          models,
          probe: {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: enabled ? "Checking ACP initialization…" : "Custom ACP agent is disabled.",
          },
        }),
      );
      const snapshot = yield* makeManagedServerProvider<AcpSettings>({
        getSettings: Effect.succeed(config),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: () => initial,
        checkProvider: check,
        enrichSnapshot: ({ getSnapshot, publishSnapshot }) =>
          Effect.sync(() => {
            refreshSnapshot = Effect.gen(function* () {
              yield* publishSnapshot(stamp(yield* getSnapshot));
            });
          }),
        refreshInterval: Duration.minutes(5),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: driverKind,
              instanceId,
              detail: "Could not initialize custom ACP status.",
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        adapter,
        textGeneration,
        snapshot,
      };
    }),
};
