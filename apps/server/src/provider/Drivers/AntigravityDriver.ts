import { Option } from "effect";
import { PreviewMcpHttpServer } from "../../mcp/PreviewMcpHttpServer";
import { mcpHubAdapterOption } from "../../mcp/hub/McpHub";
import { ComputerAutomationBroker } from "../../computer/ComputerAutomationBroker";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import {
  makeAntigravityLimits,
  runAntigravityUsageCommand,
  type AntigravityQuotaSignal,
} from "../../usage/antigravityCliUsage.ts";
import { AccountUsageReadError } from "../../usage/accountUsageErrors.ts";
import { acquireAccountAdmission } from "../../profiles/ProviderAccountGuard.ts";
import * as AcpErrors from "effect-acp/errors";
import { ProviderDriverError } from "../Errors.ts";
import {
  AntigravitySettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProviderModel,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import { customModelSlug } from "@t3tools/shared/customModels";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { PROVIDER_INSTANCE_SECRET_FIELDS } from "@t3tools/shared/serverSettings";
import { Cause, Duration, Effect, FileSystem, Path, Schema, Scope, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ServerConfig } from "../../config.ts";
import { makeGrokTextGeneration } from "../../git/Layers/GrokTextGeneration.ts";
import { makeAntigravityUsageHistory } from "../../usage/externalProviderHistory.ts";
import { makeGrokAdapter, type AntigravityCatalogObservation } from "../Layers/GrokAdapter.ts";
import {
  antigravityThinkingFromModel,
  buildAntigravityModels,
  checkAntigravityProviderStatus,
} from "../Layers/AntigravityProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { findModelConfigOption } from "../acp/AcpRuntimeModel.ts";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  antigravityAdvertisedModes,
  antigravityThinkingLevels,
  applyAntigravityTextGenerationSelection,
  antigravityDriverRuntimeInput,
  antigravityLaunchedVersion,
  makeAntigravityAcpRuntime,
  antigravityEnvironment,
  antigravityProfileDirectory,
  antigravityProfileKey,
  prepareAntigravityProfile,
  type AntigravityThinkingLevels,
} from "../acp/AntigravityAcpSupport.ts";
import type { GrokAcpRuntimeInput } from "../acp/GrokAcpSupport.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { discoverAntigravitySkills } from "./AntigravitySkills.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";
import { buildAccountExecutionEnvironment } from "../../providerProcessEnv.ts";
import { isProviderSecretUnavailable } from "../../serverSettingsSecrets.ts";
import {
  ANTIGRAVITY_STALE_AUTH_MESSAGE,
  antigravityAuthConfig,
  antigravityReadiness,
  isAntigravityAuthCurrent,
  readAntigravityAuthState,
  reconcileAntigravityAuthState,
  updateAntigravityAuthState,
} from "../antigravityAuthSupport.ts";
import { AntigravityInstallation } from "../AntigravityInstallation.ts";
import { antigravityPrivateFormatGate } from "../antigravityPrivateFormats.ts";

const driverKind = ProviderDriverKind.make("antigravity");
export type AntigravityDriverEnv =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | ServerConfig
  | ProviderEventLoggers;

/** Discovery caps: one disposable session, bounded in time and model changes. */
const DISCOVERY_TIMEOUT = Duration.seconds(90);
const DISCOVERY_MAX_MODEL_CHANGES = 24;
const DISCOVERY_FAILURE_BACKOFF_MS = 60_000;
/**
 * Cycling `setModel` would read every model's levels before the first thread, but a switch may
 * persist as the account default. Off until the R0 capture confirms a restored default holds in
 * a fresh process (`checks.defaultRestoredInFreshProcess`); until then discovery reads the
 * current model and thread sessions populate the rest as they select models.
 */
export const DISCOVERY_CYCLES_MODELS = false;

class AntigravityDiscoveryRestoreError extends Error {
  constructor() {
    super("Antigravity catalog discovery could not confirm the default model was restored.");
  }
}
/** Static runtime modes; native Auto is added per instance once a session advertised it. */
const STATIC_RUNTIME_MODES: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
];

interface AntigravityCatalog {
  readonly revision: number;
  readonly version: string | null;
  choices: ReadonlyArray<{ readonly value: string; readonly name: string }>;
  /** `undefined` for a model never observed; `null` for a model with no thinking control. */
  readonly thinking: Map<string, AntigravityThinkingLevels | null>;
  advertisedModes: ReadonlyArray<string> | undefined;
  lastSuccessAt: string | undefined;
  partial: boolean;
}

/**
 * A redacted class for a failed discovery. Never the message, which can carry paths or
 * account detail.
 */
export function antigravityDiscoveryFailureClass(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (Cause.isTimeoutError(error)) return "Timed out";
  if (error instanceof AntigravityDiscoveryRestoreError) return "Default model not restored";
  const record = typeof error === "object" && error !== null ? (error as object) : {};
  const tag = "_tag" in record ? String(record._tag) : "";
  const detail = "detail" in record ? String(record.detail) : "";
  if (detail === ANTIGRAVITY_STALE_AUTH_MESSAGE) return "Sign-in settings changed";
  if (detail.startsWith("Account change in progress")) return "Account change in progress";
  if (tag.startsWith("Acp")) return "Agent error";
  return "Unexpected error";
}

/** Catalog freshness and the last discovery failure, for the provider card. */
function catalogHealthDetails(
  entry: AntigravityCatalog | undefined,
  lastFailure: { readonly failureClass: string; readonly at: string } | undefined,
): Array<{ label: string; value: string; at?: string }> {
  const catalog =
    !entry || entry.choices.length === 0
      ? "Not discovered yet. Connect or refresh provider status to list models."
      : entry.partial
        ? "Partial: some models have not been read yet"
        : entry.lastSuccessAt
          ? "Complete"
          : "Restored from the last discovery";
  return [
    {
      label: "Model catalog",
      value: catalog,
      ...(entry?.choices.length && entry.lastSuccessAt ? { at: entry.lastSuccessAt } : {}),
    },
    ...(lastFailure
      ? [{ label: "Last discovery failure", value: lastFailure.failureClass, at: lastFailure.at }]
      : []),
  ];
}

/** Discovery priority: the current model, Neon and Orchestrator, then the rest. */
function discoveryOrder(
  choices: ReadonlyArray<{ readonly value: string }>,
  current: string | undefined,
): string[] {
  const rank = (value: string) =>
    value === current
      ? 0
      : value.toLowerCase().includes("neon")
        ? 1
        : value.toLowerCase().includes("orchestrator")
          ? 2
          : 3;
  return choices
    .map((choice, index) => ({ value: choice.value, index }))
    .toSorted((left, right) => rank(left.value) - rank(right.value) || left.index - right.index)
    .map((entry) => entry.value);
}

export const AntigravityDriver: ProviderDriver<AntigravitySettings, AntigravityDriverEnv> = {
  driverKind,
  metadata: { displayName: "Antigravity", supportsMultipleInstances: true },
  configSchema: AntigravitySettings,
  defaultConfig: () => Schema.decodeSync(AntigravitySettings)({}),
  create: ({ instanceId, displayName, accentColor, enabled, config, environment }) =>
    Effect.gen(function* () {
      const server = yield* ServerConfig;
      const instanceScope = yield* Scope.Scope;
      const eventLoggers = yield* ProviderEventLoggers;
      const fileSystem = yield* FileSystem.FileSystem;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const effectiveConfig = { ...config, enabled };
      const auth = antigravityAuthConfig(config);
      const keyUnavailable = isProviderSecretUnavailable(
        PROVIDER_INSTANCE_SECRET_FIELDS.antigravity,
        config,
      );
      const profileDirectory = antigravityProfileDirectory(server.stateDir, instanceId);
      const processEnv = buildAccountExecutionEnvironment({
        purpose: "provider",
        profile: server.profile,
        stateDir: server.stateDir,
        baseEnv: process.env,
        instance: environment,
      });
      const continuationIdentity = defaultProviderContinuationIdentity({ driverKind, instanceId });
      const usageHistory = yield* makeAntigravityUsageHistory(
        processEnv,
        profileDirectory,
        enabled,
      );
      // A method or key change since the last build advances the account revision, so sessions
      // and cached catalogs from the previous account are not reused.
      const before = yield* Effect.promise(() => readAntigravityAuthState(profileDirectory));
      // An unreadable state file refuses writes; the instance still builds and reports the
      // state it could read, and nothing reuses a revision.
      const reconcile = () =>
        reconcileAntigravityAuthState(profileDirectory, auth).catch(() =>
          readAntigravityAuthState(profileDirectory),
        );
      const reconciled = enabled ? yield* Effect.promise(reconcile) : before;
      const accountRevision = Effect.promise(() => reconcile().then((state) => state.revision));
      const staleAccount = Effect.sync(() =>
        isAntigravityAuthCurrent(server.stateDir, instanceId, auth)
          ? undefined
          : ANTIGRAVITY_STALE_AUTH_MESSAGE,
      );
      // Every launch (threads, metadata, discovery) refuses once newer sign-in settings exist.
      const refuseStale = Effect.flatMap(staleAccount, (reason) =>
        reason
          ? Effect.fail(new AcpErrors.AcpTransportError({ detail: reason, cause: undefined }))
          : Effect.void,
      );
      const makeRuntime = (input: GrokAcpRuntimeInput) =>
        refuseStale.pipe(
          Effect.andThen(
            makeAntigravityAcpRuntime(
              antigravityDriverRuntimeInput(input, {
                stateDir: server.stateDir,
                instanceId,
                environment: processEnv,
                auth,
              }),
            ),
          ),
        );
      const normalizeModel = (model: string | null | undefined) =>
        model?.trim() || ANTIGRAVITY_DEFAULT_MODEL;

      // ── Catalog cache (keyed by account revision and runtime version) ──────────────
      let catalog: AntigravityCatalog | undefined;
      let hydratable = reconciled.revision === before.revision;
      let discoveryRequested = false;
      let discoveryInFlight = false;
      let lastDiscoveryFailureAt = 0;
      let lastDiscoveryFailure: { failureClass: string; at: string } | undefined;
      let refreshSnapshot: Effect.Effect<void> = Effect.void;
      const runtimeVersion = () =>
        new AntigravityInstallation(server.stateDir)
          .resolve()
          .then((executable) => executable.version ?? null)
          .catch(() => null);
      /** Private-format readers run only on runtimes at or above the supported floor. */
      const nativeReadersCertified = () =>
        runtimeVersion().then((version) => antigravityPrivateFormatGate(version).enabled);
      /** The persisted catalog identity, when it matches this revision and runtime version. */
      const rememberedCatalog = (
        state: Awaited<ReturnType<typeof readAntigravityAuthState>>,
        version: string | null,
      ) =>
        state.catalog &&
        state.catalog.revision === state.revision &&
        state.catalog.version === version
          ? state.catalog
          : undefined;
      const currentCatalog = async () => {
        const state = await readAntigravityAuthState(profileDirectory);
        const version = await runtimeVersion();
        if (!catalog || catalog.revision !== state.revision || catalog.version !== version) {
          // Native Auto stays offered across restarts and reconnects while the runtime version
          // and sign-in method that advertised it are unchanged, so saved Auto threads and
          // scheduled tasks keep starting; a session that no longer offers it falls back to
          // Supervised with one warning.
          const autoCarried =
            state.catalog?.autoAdvertised === true &&
            state.catalog.version === version &&
            state.catalog.method !== undefined &&
            state.catalog.method === state.method;
          catalog = {
            revision: state.revision,
            version,
            choices: [],
            thinking: new Map(),
            advertisedModes: autoCarried ? ["auto"] : undefined,
            lastSuccessAt: undefined,
            partial: false,
          };
        }
        return catalog;
      };
      /** Record which revision and runtime the published catalog belongs to. */
      const persistCatalogIdentity = (entry: AntigravityCatalog) =>
        updateAntigravityAuthState(profileDirectory, (state) =>
          state.revision === entry.revision
            ? {
                ...state,
                catalog: {
                  revision: entry.revision,
                  version: entry.version,
                  autoAdvertised: entry.advertisedModes?.includes("auto") ?? false,
                  ...(state.method ? { method: state.method } : {}),
                },
              }
            : state,
        ).catch(() => undefined);
      const observe = (entry: AntigravityCatalog, observation: AntigravityCatalogObservation) => {
        const before = JSON.stringify([entry.choices, [...entry.thinking], entry.advertisedModes]);
        if (observation.modelChoices.length > 0) entry.choices = observation.modelChoices;
        if (observation.model) entry.thinking.set(observation.model, observation.thinking);
        if (observation.advertisedModes.length > 0)
          entry.advertisedModes = observation.advertisedModes;
        return (
          before !== JSON.stringify([entry.choices, [...entry.thinking], entry.advertisedModes])
        );
      };
      const observeCatalog = (observation: AntigravityCatalogObservation) =>
        Effect.promise(async () => {
          const entry = await currentCatalog();
          // A session from an older account revision can still report after the account
          // advanced; its choices belong to the previous account.
          if (
            observation.accountRevision !== undefined &&
            observation.accountRevision !== entry.revision
          )
            return false;
          // The saved catalog stays eligible until real replacement choices arrive.
          if (observation.modelChoices.length > 0) hydratable = false;
          const changed = observe(entry, observation);
          // The same completeness rule as discovery: every advertised model's levels read.
          const partial = entry.choices.some((choice) => !entry.thinking.has(choice.value));
          const partialChanged = partial !== entry.partial;
          entry.partial = partial;
          if (changed) await persistCatalogIdentity(entry);
          return changed || partialChanged;
        }).pipe(Effect.flatMap((changed) => (changed ? refreshSnapshot : Effect.void)));

      /**
       * Disposable discovery: a temp directory with no project MCP, never a thread session.
       * Records the default model, cycles `setModel` to read levels, then restores and confirms
       * the original. A partial run publishes what it verified.
       */
      const discover = Effect.gen(function* () {
        const entry = yield* Effect.promise(currentCatalog);
        // Admission covers the launch only, so a sign-out or settings change is never refused
        // while discovery runs. Results are published only for the revision discovery started
        // under, and a settings change rebuilds the instance, which interrupts it.
        const releaseAdmission = yield* Effect.try({
          try: () => acquireAccountAdmission(server.stateDir, instanceId),
          catch: (cause) =>
            new AcpErrors.AcpTransportError({ detail: "Account change in progress.", cause }),
        });
        yield* Effect.addFinalizer(() => Effect.sync(releaseAdmission));
        const cwd = yield* fileSystem
          .makeTempDirectoryScoped({ prefix: "f5-antigravity-catalog-" })
          .pipe(
            Effect.mapError(
              (cause) =>
                new AcpErrors.AcpTransportError({
                  detail: "Could not create catalog workspace.",
                  cause,
                }),
            ),
          );
        yield* refuseStale;
        const runtime = yield* makeAntigravityAcpRuntime({
          stateDir: server.stateDir,
          instanceId,
          environment: processEnv,
          auth,
          childProcessSpawner,
          cwd,
        });
        yield* runtime.handleRequestPermission(() =>
          Effect.succeed({ outcome: { outcome: "cancelled" as const } }),
        );
        yield* runtime.start();
        releaseAdmission();
        entry.partial = true;
        const read = Effect.gen(function* () {
          const configOptions = yield* runtime.getConfigOptions;
          const modelOption = findModelConfigOption(configOptions);
          return {
            configOptions,
            current: modelOption?.currentValue || undefined,
            choices: (modelOption?.options ?? []).flatMap((option) =>
              "value" in option ? [option] : option.options,
            ),
          };
        });
        const initial = yield* read;
        observe(entry, {
          model: initial.current,
          thinking: antigravityThinkingLevels(initial.configOptions),
          modelChoices: initial.choices,
          advertisedModes: antigravityAdvertisedModes(
            yield* runtime.getModeState,
            initial.configOptions,
          ).modes,
        });
        if (DISCOVERY_CYCLES_MODELS && initial.current) {
          const original = initial.current;
          let switched = false;
          let restored = true;
          // Restore the account default after any switch, on success, failure or timeout.
          // Finalizers run before the runtime's scope closes; the restore is bounded, and only
          // a read-back of the original counts as restored.
          const restore = Effect.gen(function* () {
            yield* runtime.setModel(original);
            restored = (yield* read).current === original;
          }).pipe(
            Effect.timeout(Duration.seconds(10)),
            Effect.catchCause(() =>
              Effect.sync(() => {
                restored = false;
              }),
            ),
          );
          yield* Effect.gen(function* () {
            let changes = 0;
            for (const model of discoveryOrder(initial.choices, original)) {
              if (model === original || entry.thinking.has(model)) continue;
              if (changes >= DISCOVERY_MAX_MODEL_CHANGES - 1) break;
              changes++;
              switched = true;
              yield* runtime.setModel(model);
              const after = yield* runtime.getConfigOptions;
              entry.thinking.set(model, antigravityThinkingLevels(after));
            }
          }).pipe(Effect.ensuring(Effect.suspend(() => (switched ? restore : Effect.void))));
          // Observations stay published as partial; a later explicit refresh retries.
          if (!restored) return yield* Effect.fail(new AntigravityDiscoveryRestoreError());
        }
        // Complete only when every advertised model's levels were read (`null`, no control,
        // counts as read).
        entry.partial = entry.choices.some((choice) => !entry.thinking.has(choice.value));
        entry.lastSuccessAt = new Date().toISOString();
        yield* Effect.promise(() => persistCatalogIdentity(entry));
      }).pipe(Effect.scoped, Effect.timeout(DISCOVERY_TIMEOUT));

      /**
       * Discovery runs only after an explicit trigger: a successful connect (a marker in the
       * auth state) or "Refresh provider status" (`requestModelDiscovery`). Never at startup
       * or on periodic checks. Single-flight with failure backoff, in the background: the
       * status check returns at once and the snapshot refreshes when discovery finishes.
       */
      const startDiscoveryIfRequested = Effect.gen(function* () {
        if (!enabled) return;
        const state = yield* Effect.promise(() => readAntigravityAuthState(profileDirectory));
        const persisted = state.discoveryRequested === true;
        if (!(discoveryRequested || persisted) || discoveryInFlight) return;
        const readiness = yield* Effect.promise(() =>
          antigravityReadiness({ profileDirectory, auth, keyUnavailable }),
        );
        if (!readiness.ready) return;
        if (Date.now() - lastDiscoveryFailureAt < DISCOVERY_FAILURE_BACKOFF_MS) return;
        // The saved request is cleared only now that discovery really starts: an instance
        // rebuilt before this point still finds it.
        discoveryRequested = false;
        if (persisted)
          yield* Effect.promise(() =>
            updateAntigravityAuthState(
              profileDirectory,
              ({ discoveryRequested: _, ...rest }) => rest,
            ).catch(() => undefined),
          );
        discoveryInFlight = true;
        // Forked in the instance scope: replacing or disabling the instance interrupts it.
        yield* discover.pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.tap(() =>
            Effect.sync(() => {
              lastDiscoveryFailure = undefined;
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              lastDiscoveryFailureAt = Date.now();
              lastDiscoveryFailure = {
                failureClass: antigravityDiscoveryFailureClass(cause),
                at: new Date(lastDiscoveryFailureAt).toISOString(),
              };
            }).pipe(
              Effect.andThen(
                Effect.logWarning("Antigravity catalog discovery failed.", {
                  failureClass: lastDiscoveryFailure?.failureClass,
                }),
              ),
            ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              discoveryInFlight = false;
            }),
          ),
          Effect.andThen(Effect.suspend(() => refreshSnapshot)),
          Effect.forkIn(instanceScope),
        );
      });

      // The last quota stop a turn reported. In memory only: it is evidence from a turn, not a
      // quota reading, so it never enters history and expires at its reset.
      let quotaSignal: AntigravityQuotaSignal | undefined;
      const onQuotaExhausted = (resetsAt: string | null) =>
        Effect.sync(() => {
          quotaSignal = { observedAt: new Date().toISOString(), resetsAt };
        });
      /**
       * One `/usage` run with the instance's own sign-in. Gated like catalog discovery: current
       * sign-in settings, a ready sign-in and account admission while the profile is prepared.
       * A run that straddles an account change is discarded.
       */
      const runUsage = async (signal: AbortSignal) => {
        if (!isAntigravityAuthCurrent(server.stateDir, instanceId, auth))
          throw new AccountUsageReadError("temporary-failure");
        const readiness = await antigravityReadiness({ profileDirectory, auth, keyUnavailable });
        if (!readiness.ready) throw new AccountUsageReadError("authentication-required");
        const before = await readAntigravityAuthState(profileDirectory);
        let release: () => void;
        try {
          release = acquireAccountAdmission(server.stateDir, instanceId);
        } catch {
          throw new AccountUsageReadError("temporary-failure");
        }
        let prepared: Awaited<ReturnType<typeof prepareAntigravityProfile>>;
        try {
          prepared = await prepareAntigravityProfile({
            stateDir: server.stateDir,
            instanceId,
            environment: processEnv,
            auth,
          });
        } catch {
          throw new AccountUsageReadError("process-unavailable");
        } finally {
          release();
        }
        const result = await runAntigravityUsageCommand({
          executablePath: prepared.executable.executablePath,
          profileDirectory: prepared.home,
          environment: antigravityEnvironment(
            processEnv,
            prepared.home,
            prepared.executable.harnessPath,
            prepared.browser,
            auth,
          ),
          signal,
        }).catch(() => {
          throw new AccountUsageReadError("process-unavailable");
        });
        const after = await readAntigravityAuthState(profileDirectory);
        if (after.revision !== before.revision)
          throw new AccountUsageReadError("temporary-failure");
        return result;
      };

      const previewMcp = Option.getOrUndefined(yield* Effect.serviceOption(PreviewMcpHttpServer));
      const computerBroker = Option.getOrUndefined(
        yield* Effect.serviceOption(ComputerAutomationBroker),
      );
      const adapter = yield* makeGrokAdapter(
        { enabled, binaryPath: "", customModels: config.customModels },
        {
          provider: "antigravity",
          antigravityProfileDirectory: profileDirectory,
          ...(previewMcp ? { previewMcpHttpServer: previewMcp } : {}),
          ...(yield* mcpHubAdapterOption),
          ...(computerBroker ? { computerAutomationBroker: computerBroker } : {}),
          nativeCompaction: config.nativeCompaction,
          instanceId,
          environment: processEnv,
          makeRuntime,
          normalizeModel,
          antigravity: {
            accountRevision,
            observeCatalog,
            staleAccount,
            onQuotaExhausted,
            // The version the session's runtime was spawned from, not whatever is active now.
            nativeReaders: (runtime) => {
              const launched = antigravityLaunchedVersion(runtime);
              return launched === undefined
                ? Effect.promise(nativeReadersCertified)
                : Effect.succeed(antigravityPrivateFormatGate(launched).enabled);
            },
            ...(auth.authMethod === "gemini-api-key" && auth.apiKey
              ? { credentials: [auth.apiKey] }
              : {}),
          },
          // Project and user skills join the session command catalog.
          discoverSkillCommands: (cwd: string) =>
            Effect.tryPromise(() =>
              discoverAntigravitySkills({
                cwd,
                userHome: processEnv.HOME?.trim() || NodeOS.homedir(),
                profileDirectory,
              }),
            ).pipe(
              Effect.map((skills) =>
                skills.map((skill) => ({ name: skill.name, description: skill.description ?? "" })),
              ),
              Effect.orElseSucceed(() => []),
            ),
          ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        },
      );
      const accountUsage = yield* makeAntigravityLimits({
        instanceId,
        displayName: displayName || "Antigravity",
        enabled,
        profileKey: antigravityProfileKey(instanceId),
        billedPerToken: auth.authMethod === "gemini-api-key",
        readLimitsWithCli: config.readLimitsWithCli,
        quotaSignal: () => quotaSignal,
        runUsage,
        runtimeVersion,
        refusedVersion: () =>
          readAntigravityAuthState(profileDirectory).then(
            (state) => state.usageCommandRefusedVersion,
          ),
        refuseVersion: (version) =>
          updateAntigravityAuthState(profileDirectory, (state) => ({
            ...state,
            usageCommandRefusedVersion: version,
          })).then(
            () => undefined,
            () => undefined,
          ),
      });
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
            model: ANTIGRAVITY_DEFAULT_MODEL,
          },
          applyModelSelection: (runtime, modelSelection) =>
            applyAntigravityTextGenerationSelection({
              runtime,
              model: normalizeModel(modelSelection.model),
              thinking: getModelSelectionStringOptionValue(modelSelection, "thinking"),
              customModels: config.customModels.map(customModelSlug),
            }),
        },
      );
      const path = yield* Path.Path;
      const homeDir = processEnv.HOME?.trim() || NodeOS.homedir();
      // The Antigravity CLI publishes no skill catalog, so user skills come from this
      // instance's own home and profile (plugins), never the server's.
      const scanHomeSkills = Effect.tryPromise(() =>
        discoverAntigravitySkills({ userHome: homeDir, profileDirectory }),
      ).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Antigravity skill discovery failed.", { cause: String(cause) }),
        ),
        Effect.orElseSucceed((): ReadonlyArray<ServerProviderSkill> => []),
      );
      // Rescan home skills only when one of their roots changed.
      const skillRoots = [
        path.join(homeDir, ".gemini", "config", "skills"),
        path.join(homeDir, ".gemini", "antigravity-cli", "skills"),
        path.join(homeDir, ".gemini", "config", "skills.json"),
        path.join(profileDirectory, "config", "plugins"),
        path.join(profileDirectory, "config", "config.json"),
      ];
      // Root stats catch added and removed skills; an edit inside an existing SKILL.md does not
      // touch them, so the cache also expires after a few minutes.
      const SKILL_CACHE_TTL_MS = 5 * 60_000;
      let skillCache:
        | { signature: string; at: number; skills: ReadonlyArray<ServerProviderSkill> }
        | undefined;
      const homeSkills = Effect.gen(function* () {
        const signature = JSON.stringify(
          yield* Effect.promise(() =>
            Promise.all(
              skillRoots.map((root) =>
                NodeFSP.stat(root).then(
                  (stat) => [stat.mtimeMs, stat.size],
                  () => null,
                ),
              ),
            ),
          ),
        );
        if (skillCache?.signature === signature && Date.now() - skillCache.at < SKILL_CACHE_TTL_MS)
          return skillCache.skills;
        const skills = yield* scanHomeSkills;
        skillCache = { signature, at: Date.now(), skills };
        return skills;
      });
      const checkProvider = Effect.gen(function* () {
        yield* startDiscoveryIfRequested;
        const entry = enabled ? yield* Effect.promise(currentCatalog) : undefined;
        const models =
          entry && entry.choices.length > 0
            ? buildAntigravityModels(entry.choices, entry.thinking)
            : undefined;
        const availableRuntimeModes: ReadonlyArray<RuntimeMode> = entry?.advertisedModes?.includes(
          "auto",
        )
          ? [...STATIC_RUNTIME_MODES, "auto"]
          : STATIC_RUNTIME_MODES;
        const [snapshot, skills] = yield* Effect.all([
          checkAntigravityProviderStatus(effectiveConfig, server.stateDir, instanceId, models, {
            keyUnavailable,
            availableRuntimeModes,
            healthDetails: catalogHealthDetails(entry, lastDiscoveryFailure),
            ...(entry && entry.choices.length > 0
              ? {
                  modelCatalog: {
                    status: entry.partial ? ("partial" as const) : ("complete" as const),
                    ...(entry.lastSuccessAt ? { lastSuccessAt: entry.lastSuccessAt } : {}),
                  },
                }
              : lastDiscoveryFailure
                ? { modelCatalog: { status: "failed" as const } }
                : {}),
          }),
          homeSkills,
        ]);
        return { ...snapshot, skills };
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
        accountUsage,
        usageHistory,
        textGeneration,
        snapshot,
        // No `invalidateModelCatalog`: the registry calls it on every refresh, including startup.
        // The catalog is keyed by account revision and runtime version, so sign-in, sign-out
        // and method changes already invalidate it. Only an explicit "Refresh provider status"
        // requests discovery.
        // An explicit refresh also rescans home skills, so an edited `SKILL.md` shows up.
        requestModelDiscovery: Effect.sync(() => {
          discoveryRequested = true;
          skillCache = undefined;
        }),
        // Restores the cached catalog before the first live probe (at startup, or when the
        // instance is rebuilt), only for the revision and runtime version it was recorded under.
        hydrateModelCatalog: (models: ReadonlyArray<ServerProviderModel>) =>
          Effect.promise(async () => {
            if (!hydratable) return;
            const entry = await currentCatalog();
            if (entry.choices.length > 0) return;
            const state = await readAntigravityAuthState(profileDirectory);
            if (!rememberedCatalog(state, entry.version) || state.revision !== entry.revision)
              return;
            const native = models.filter(
              (model) => !model.isCustom && model.slug !== ANTIGRAVITY_DEFAULT_MODEL,
            );
            if (native.length === 0) return;
            hydratable = false;
            entry.choices = native.map((model) => ({ value: model.slug, name: model.name }));
            for (const model of native) {
              const thinking = antigravityThinkingFromModel(model);
              if (thinking) entry.thinking.set(model.slug, thinking);
            }
            // A cached model without levels can't be told apart from an unread one: partial.
            entry.partial = entry.choices.some((choice) => !entry.thinking.has(choice.value));
          }),
      };
    }),
};
