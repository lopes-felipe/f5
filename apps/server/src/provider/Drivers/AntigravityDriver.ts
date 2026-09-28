import { acquireAccountAdmission } from "../../profiles/ProviderAccountGuard.ts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as AcpErrors from "effect-acp/errors";
import { ProviderDriverError } from "../Errors.ts";
import {
  AntigravitySettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { Duration, Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ServerConfig } from "../../config.ts";
import { makeGrokTextGeneration } from "../../git/Layers/GrokTextGeneration.ts";
import { makeGrokAdapter } from "../Layers/GrokAdapter.ts";
import { checkAntigravityProviderStatus } from "../Layers/AntigravityProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeAntigravityAcpRuntime } from "../acp/AntigravityAcpSupport.ts";
import type { GrokAcpRuntimeInput } from "../acp/GrokAcpSupport.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";

const driverKind = ProviderDriverKind.make("antigravity");
export type AntigravityDriverEnv =
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | ServerConfig
  | ProviderEventLoggers;

export const AntigravityDriver: ProviderDriver<AntigravitySettings, AntigravityDriverEnv> = {
  driverKind,
  metadata: { displayName: "Antigravity", supportsMultipleInstances: true },
  configSchema: AntigravitySettings,
  defaultConfig: () => Schema.decodeSync(AntigravitySettings)({}),
  create: ({ instanceId, displayName, accentColor, enabled, config, environment }) =>
    Effect.gen(function* () {
      const server = yield* ServerConfig;
      const eventLoggers = yield* ProviderEventLoggers;
      const fileSystem = yield* FileSystem.FileSystem;
      const effectiveConfig = { ...config, enabled };
      const processEnv = mergeProviderInstanceEnvironment(environment, process.env);
      const continuationIdentity = defaultProviderContinuationIdentity({ driverKind, instanceId });
      const makeRuntime = (input: GrokAcpRuntimeInput) =>
        makeAntigravityAcpRuntime({
          ...input,
          stateDir: server.stateDir,
          instanceId,
          environment: processEnv,
        });
      const normalizeModel = (model: string | null | undefined) =>
        model?.trim() || "antigravity-default";
      let models: ReadonlyArray<ServerProviderModel> | undefined;
      let refreshSnapshot: Effect.Effect<void> = Effect.void;
      let readModelChoices: Effect.Effect<void> = Effect.void;
      const adapter = yield* makeGrokAdapter(
        { enabled, binaryPath: "", customModels: config.customModels },
        {
          provider: "antigravity",
          nativeCompaction: config.nativeCompaction,
          onRuntimeReady: (runtime) =>
            Effect.gen(function* () {
              readModelChoices = Effect.gen(function* () {
                const configOptions = yield* runtime.getConfigOptions;
                const model = configOptions.find(
                  (option) => option.id === "model" || option.category === "model",
                );
                if (model?.type === "select") {
                  const choices = model.options.flatMap((option) =>
                    "value" in option ? [option] : option.options,
                  );
                  models = choices
                    .filter((choice) => choice.value.trim())
                    .map((choice) => ({
                      slug: choice.value,
                      name: choice.name,
                      isCustom: false,
                      capabilities: createModelCapabilities({ optionDescriptors: [] }),
                    }));
                }
              });
              yield* refreshSnapshot;
            }),
          instanceId,
          environment: processEnv,
          makeRuntime,
          normalizeModel,
          configureRuntime: (runtime, mode) =>
            runtime.setMode(mode === "full-access" ? "yolo" : "default").pipe(Effect.asVoid),
          ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        },
      );
      const textGeneration = yield* makeGrokTextGeneration(
        { enabled, binaryPath: "", customModels: config.customModels },
        processEnv,
        {
          makeRuntime: (input) =>
            Effect.gen(function* () {
              yield* Effect.acquireRelease(
                Effect.try({
                  try: () => acquireAccountAdmission(server.stateDir, instanceId),
                  catch: (cause) =>
                    new AcpErrors.AcpTransportError({
                      detail:
                        "Account change in progress. Retry metadata generation after setup finishes.",
                      cause,
                    }),
                }),
                (release) => Effect.sync(release),
              );
              const cwd = yield* fileSystem
                .makeTempDirectoryScoped({ prefix: "f5-antigravity-metadata-" })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new AcpErrors.AcpTransportError({
                        detail: "Could not create metadata workspace.",
                        cause,
                      }),
                  ),
                );
              return yield* makeRuntime({ ...input, cwd });
            }),
          normalizeModel,
          useAccountDefaultModel: true,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make(instanceId),
            model: "antigravity-default",
          },
        },
      );
      const checkProvider = Effect.gen(function* () {
        if (enabled) yield* readModelChoices;
        return yield* checkAntigravityProviderStatus(
          effectiveConfig,
          server.stateDir,
          instanceId,
          models,
        );
      }).pipe(
        Effect.map((snapshot) => ({
          ...snapshot,
          instanceId,
          driver: driverKind,
          ...(displayName ? { displayName } : {}),
          ...(accentColor ? { accentColor } : {}),
          continuation: { groupKey: continuationIdentity.continuationKey },
        })),
      );
      const initial = yield* checkProvider;
      const snapshot = yield* makeManagedServerProvider<AntigravitySettings>({
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: () => initial,
        checkProvider,
        refreshInterval: Duration.minutes(5),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: driverKind,
              instanceId,
              detail: "Could not initialize Antigravity status.",
              cause,
            }),
        ),
      );
      refreshSnapshot = snapshot.refresh.pipe(Effect.asVoid);
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
