import { type EditorId, type ServerRuntimeReadiness, WS_METHODS } from "@t3tools/contracts";
import { isDoNotTrackSet } from "@t3tools/shared/doNotTrack";
import { publicOtlpConfiguration, resolveOtlpConfiguration } from "@t3tools/shared/observability";
import { Effect, Option, Struct } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type { ComputerAutomationBroker } from "../../computer/ComputerAutomationBroker.ts";
import { computerPolicyChange } from "../../computer/computerPolicyChange.ts";
import type { ServerConfig } from "../../config.ts";
import {
  buildSqliteInspectionSnapshot,
  runDoctorDiagnostics,
  type SqliteInspectionResult,
} from "../../diagnostics/doctor.ts";
import type { Keybindings } from "../../keybindings.ts";
import type { makeClientDiagnosticsReporter } from "../../observability/clientDiagnostics.ts";
import { readServerHealth } from "../../observability/serverHealth.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectSkillSyncServiceShape } from "../../orchestration/Services/ProjectSkillSyncService.ts";
import type { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { readProjectSettings } from "../../project/projectSettings.ts";
import { cursorSdkHarnessHostAvailability } from "../../provider/cursor/cursorHarnessDescriptor.ts";
import type { HarnessValidation } from "../../provider/Services/HarnessValidation.ts";
import type { ProviderAdvisoryProjection } from "../../provider/Services/ProviderAdvisoryProjection.ts";
import type { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import type { ProviderUpdateAdvisor } from "../../provider/Services/ProviderUpdateAdvisor.ts";
import { redactServerSettingsForClient, type ServerSettingsService } from "../../serverSettings.ts";
import { RouteRequestError } from "../../turnSubmissionErrors.ts";
import { canonicalManagedWorktreesDirectories } from "../../worktreesDirectoryPaths.ts";
import type { RouteTable } from "./routeTable.ts";

type ServerMetaMethod =
  | typeof WS_METHODS.serverReportClientDiagnostics
  | typeof WS_METHODS.serverProbe
  | typeof WS_METHODS.serverGetHealth
  | typeof WS_METHODS.serverGetDoctorReport
  | typeof WS_METHODS.serverGetConfig
  | typeof WS_METHODS.serverGetProjectSettings
  | typeof WS_METHODS.serverMigrateClientSetting
  | typeof WS_METHODS.serverUpdateSettings
  | typeof WS_METHODS.serverRefreshProviders
  | typeof WS_METHODS.serverCheckProviderUpdates
  | typeof WS_METHODS.serverRunProviderUpdate
  | typeof WS_METHODS.serverCodexConfiguration
  | typeof WS_METHODS.serverSaveProviderFeedback
  | typeof WS_METHODS.serverGetProviderInventory
  | typeof WS_METHODS.serverTrustProviderHooks
  | typeof WS_METHODS.serverValidateHarnesses
  | typeof WS_METHODS.serverUpsertKeybinding
  | typeof WS_METHODS.serverAddKeybinding
  | typeof WS_METHODS.serverUpdateKeybinding
  | typeof WS_METHODS.serverRemoveKeybinding
  | typeof WS_METHODS.serverResetKeybindings;

export interface ServerMetaRouteDependencies {
  readonly serverConfig: typeof ServerConfig.Service;
  readonly cwd: string;
  readonly keybindingsConfigPath: string;
  readonly availableEditors: ReadonlyArray<EditorId>;
  readonly sql: SqlClient.SqlClient;
  readonly clientDiagnosticsReporter: ReturnType<typeof makeClientDiagnosticsReporter>;
  readonly currentRuntimeReadiness: () => ServerRuntimeReadiness;
  readonly keybindingsManager: typeof Keybindings.Service;
  readonly providerAdvisoryProjection: typeof ProviderAdvisoryProjection.Service;
  readonly providerInstanceRegistry: typeof ProviderInstanceRegistry.Service;
  readonly providerRegistry: typeof ProviderRegistry.Service;
  readonly providerUpdateAdvisor: typeof ProviderUpdateAdvisor.Service;
  readonly harnessValidation: typeof HarnessValidation.Service;
  readonly serverSettings: typeof ServerSettingsService.Service;
  readonly projectionProjects: typeof ProjectionProjectRepository.Service;
  readonly computerAutomationBroker: Option.Option<typeof ComputerAutomationBroker.Service>;
  readonly getProjectSkillSyncServiceIfReady: Effect.Effect<
    Option.Option<ProjectSkillSyncServiceShape>
  >;
  readonly runtime: Effect.Effect<
    { readonly orchestrationEngine: Pick<OrchestrationEngineShape, "getReadModel"> },
    RouteRequestError
  >;
}

const withoutTag = <Body extends { readonly _tag: string }>(body: Body) =>
  Struct.omit(body, ["_tag"]);

/**
 * Server metadata, health/doctor diagnostics, settings, keybindings, provider
 * refresh/update/inventory, and harness validation routes.
 */
export const serverMetaRoutes = ({
  serverConfig,
  cwd,
  keybindingsConfigPath,
  availableEditors,
  sql,
  clientDiagnosticsReporter,
  currentRuntimeReadiness,
  keybindingsManager,
  providerAdvisoryProjection,
  providerInstanceRegistry,
  providerRegistry,
  providerUpdateAdvisor,
  harnessValidation,
  serverSettings,
  projectionProjects,
  computerAutomationBroker,
  getProjectSkillSyncServiceIfReady,
  runtime,
}: ServerMetaRouteDependencies): RouteTable<ServerMetaMethod, never, Error> => {
  /** Provider inventory routes: map a project id to its workspace root; paths never come from the browser. */
  const resolveProviderInventoryProjectRoot = (projectId: string | undefined) =>
    Effect.gen(function* () {
      if (!projectId) return undefined;
      const { orchestrationEngine } = yield* runtime;
      const model = yield* orchestrationEngine.getReadModel();
      const project = model.projects.find((p) => p.id === projectId && p.deletedAt === null);
      if (!project) return yield* new RouteRequestError({ message: "Project not found." });
      return project.workspaceRoot;
    });

  return {
    [WS_METHODS.serverReportClientDiagnostics]: (request) =>
      clientDiagnosticsReporter.report(withoutTag(request)).pipe(Effect.as(undefined)),

    [WS_METHODS.serverProbe]: () =>
      // Lets a client holding requests notice readiness even if a push is lost.
      Effect.sync(() => ({ runtime: currentRuntimeReadiness() })),

    [WS_METHODS.serverGetHealth]: () => Effect.sync(() => readServerHealth()),

    [WS_METHODS.serverGetDoctorReport]: () =>
      Effect.gen(function* () {
        const providers = yield* providerAdvisoryProjection.getProviders;
        // Run only O(1) PRAGMAs on the live SQLite connection so checking Doctor
        // in Settings never blocks the main server event loop with a full-DB scan.
        const [
          pageSizeRows,
          pageCountRows,
          freelistRows,
          autoVacuumRows,
          journalRows,
          migrationRows,
          managedWorktreesDirs,
        ] = yield* Effect.all([
          sql<{ readonly page_size?: number }>`PRAGMA page_size`.pipe(
            Effect.catch(() =>
              Effect.succeed([] as ReadonlyArray<{ readonly page_size?: number }>),
            ),
          ),
          sql<{ readonly page_count?: number }>`PRAGMA page_count`.pipe(
            Effect.catch(() =>
              Effect.succeed([] as ReadonlyArray<{ readonly page_count?: number }>),
            ),
          ),
          sql<{ readonly freelist_count?: number }>`PRAGMA freelist_count`.pipe(
            Effect.catch(() =>
              Effect.succeed([] as ReadonlyArray<{ readonly freelist_count?: number }>),
            ),
          ),
          sql<{ readonly auto_vacuum?: number }>`PRAGMA auto_vacuum`.pipe(
            Effect.catch(() =>
              Effect.succeed([] as ReadonlyArray<{ readonly auto_vacuum?: number }>),
            ),
          ),
          sql<{ readonly journal_mode?: string }>`PRAGMA journal_mode`.pipe(
            Effect.catch(() =>
              Effect.succeed([] as ReadonlyArray<{ readonly journal_mode?: string }>),
            ),
          ),
          sql<{
            readonly count?: number;
            readonly latest?: number | null;
          }>`SELECT COUNT(*) AS count, MAX(migration_id) AS latest FROM effect_sql_migrations`.pipe(
            Effect.catch(() =>
              Effect.succeed(
                [] as ReadonlyArray<{ readonly count?: number; readonly latest?: number | null }>,
              ),
            ),
          ),
          serverSettings.getSettings.pipe(
            Effect.flatMap((settings) =>
              canonicalManagedWorktreesDirectories(settings, serverConfig.worktreesDir),
            ),
            Effect.orElseSucceed(() => [serverConfig.worktreesDir]),
          ),
        ]);
        const sqliteResult: SqliteInspectionResult =
          pageSizeRows.length > 0 || pageCountRows.length > 0
            ? {
                kind: "ok",
                snapshot: buildSqliteInspectionSnapshot({
                  quickRows: null,
                  pageSizeRow: pageSizeRows[0],
                  pageCountRow: pageCountRows[0],
                  freelistRow: freelistRows[0],
                  autoVacuumRow: autoVacuumRows[0],
                  journalRow: journalRows[0],
                  migrationRow: migrationRows[0],
                }),
              }
            : {
                kind: "unavailable",
                detail: "Live SQLite metadata PRAGMAs returned no rows.",
              };
        return yield* Effect.promise(() =>
          runDoctorDiagnostics({
            mode: serverConfig.mode,
            stateDir: serverConfig.stateDir,
            dbPath: serverConfig.dbPath,
            worktreesDir: serverConfig.worktreesDir,
            worktreesDirs: managedWorktreesDirs,
            logsDir: serverConfig.logsDir,
            attachmentsDir: serverConfig.attachmentsDir,
            ...(serverConfig.profilesRoot ? { profilesRoot: serverConfig.profilesRoot } : {}),
            ...(serverConfig.profile
              ? {
                  profileSlug: serverConfig.profile.slug,
                  profileName: serverConfig.profile.name,
                  isDefaultProfile: serverConfig.profile.isDefault,
                }
              : {}),
            ...(serverConfig.host !== undefined ? { host: serverConfig.host } : {}),
            port: serverConfig.port,
            authEnabled: Boolean(serverConfig.authToken),
            trustedProxyCount: serverConfig.trustedProxies?.length ?? 0,
            liveProviders: providers,
            inspectSqlite: async () => sqliteResult,
          }),
        );
      }),

    [WS_METHODS.serverGetConfig]: () =>
      Effect.gen(function* () {
        const keybindingsConfig = yield* keybindingsManager.loadConfigState;
        const providers = yield* providerAdvisoryProjection.getProviders;
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.map(redactServerSettingsForClient),
        );
        return {
          cwd,
          keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          customKeybindings: keybindingsConfig.customKeybindings,
          issues: keybindingsConfig.issues,
          providers,
          availableEditors,
          settings,
          diagnostics: publicOtlpConfiguration(
            resolveOtlpConfiguration(settings.observability, process.env),
          ),
          cursorSdkHarness: cursorSdkHarnessHostAvailability(serverConfig),
          privacy: { doNotTrack: isDoNotTrackSet(process.env) },
        };
      }),

    [WS_METHODS.serverGetProjectSettings]: (request) =>
      Effect.gen(function* () {
        const { projectId } = withoutTag(request);
        const projected = yield* projectionProjects.getById({ projectId });
        if (Option.isNone(projected) || projected.value.deletedAt !== null) {
          return yield* new RouteRequestError({ message: "Project not found." });
        }
        const project = { ...projected.value, id: projected.value.projectId };
        const global = yield* serverSettings.getSettings.pipe(
          Effect.map(redactServerSettingsForClient),
        );
        const projectSkillSyncService = yield* getProjectSkillSyncServiceIfReady;
        return {
          ...(yield* readProjectSettings(global, project)),
          skillScanWarnings: Option.isSome(projectSkillSyncService)
            ? yield* projectSkillSyncService.value.getWarnings(projectId)
            : [],
        };
      }),

    [WS_METHODS.serverMigrateClientSetting]: (request) =>
      serverSettings.migrateClientSetting(request),

    [WS_METHODS.serverUpdateSettings]: (request) =>
      Effect.gen(function* () {
        const body = withoutTag(request);
        if (body.mobileAccess !== undefined) {
          return yield* new RouteRequestError({
            message: "Update Phone access through its dedicated settings controls.",
          });
        }
        if (body.projectSettingsOverrides) {
          const { orchestrationEngine } = yield* runtime;
          const model = yield* orchestrationEngine.getReadModel();
          for (const [id, value] of Object.entries(body.projectSettingsOverrides)) {
            if (value !== null && !model.projects.some((p) => p.id === id && !p.deletedAt)) {
              return yield* new RouteRequestError({
                message: "Cannot override settings for a missing project.",
              });
            }
          }
        }
        const update = serverSettings.updateSettings(body);
        // Computer policy changes go through the broker's admission barrier before they persist:
        // admissions close, revisions bump, host scopes drain, then the change applies. On a
        // persistence failure the barrier reloads policies and reopens under a fresh revision.
        // Only patches that change effective computer policy pass the barrier, and a project
        // override change interrupts only that project's threads.
        const change = Option.isSome(computerAutomationBroker)
          ? computerPolicyChange(yield* serverSettings.getSettings, body)
          : null;
        const guarded =
          change && Option.isSome(computerAutomationBroker)
            ? Effect.promise(() =>
                computerAutomationBroker.value.policyTransition(
                  () => Effect.runPromise(Effect.exit(update)),
                  change.global
                    ? undefined
                    : (projectId) => projectId !== undefined && change.projects.has(projectId),
                ),
              ).pipe(Effect.flatMap((exit) => exit))
            : update;
        return yield* guarded.pipe(
          Effect.map(redactServerSettingsForClient),
          Effect.mapError((error) => new RouteRequestError({ message: error.message })),
        );
      }),

    [WS_METHODS.serverRefreshProviders]: (request) =>
      Effect.gen(function* () {
        const { instanceId, discoverModels } = withoutTag(request);
        // Only the Settings refresh asks for it: drivers with an expensive catalog discovery
        // (Antigravity) run it then, never for health checks, session restarts, startup or
        // periodic refreshes.
        if (discoverModels === true) {
          for (const instance of yield* providerInstanceRegistry.listInstances) {
            if (instanceId === undefined || instance.instanceId === instanceId) {
              yield* instance.requestModelDiscovery ?? Effect.void;
            }
          }
        }
        if (instanceId) yield* providerRegistry.refreshInstance(instanceId);
        else yield* providerRegistry.refresh();
        const providers = yield* providerAdvisoryProjection.getProviders;
        return { providers };
      }),

    [WS_METHODS.serverCheckProviderUpdates]: (request) =>
      Effect.gen(function* () {
        yield* providerUpdateAdvisor.refreshAdvisories({
          mode: "explicit",
          ...withoutTag(request),
        });
        return { providers: yield* providerAdvisoryProjection.getProviders };
      }),

    [WS_METHODS.serverRunProviderUpdate]: (request) =>
      Effect.gen(function* () {
        const result = yield* providerUpdateAdvisor
          .runUpdate(request.instanceId)
          .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message })));
        return { ...result, providers: yield* providerAdvisoryProjection.getProviders };
      }),

    [WS_METHODS.serverCodexConfiguration]: (request) =>
      Effect.gen(function* () {
        const body = withoutTag(request);
        const instance = yield* providerInstanceRegistry.getInstance(body.instanceId);
        if (!instance?.codexConfiguration) {
          return yield* new RouteRequestError({ message: "Select a configured Codex provider." });
        }
        return yield* instance.codexConfiguration(body.action).pipe(
          Effect.ensuring(
            body.action.type === "write" || body.action.type === "setDefault"
              ? (instance.invalidateModelCatalog ?? Effect.void)
              : Effect.void,
          ),
          Effect.mapError(
            (error) => new RouteRequestError({ message: error.detail ?? error.message }),
          ),
        );
      }),

    [WS_METHODS.serverSaveProviderFeedback]: (request) =>
      Effect.gen(function* () {
        const instance = yield* providerInstanceRegistry.getInstance(request.instanceId);
        if (!instance || instance.driverKind !== "codex" || !instance.saveFeedback) {
          return yield* new RouteRequestError({
            message: "Feedback bundles are only available for a configured Codex provider.",
          });
        }
        return yield* instance
          .saveFeedback()
          .pipe(
            Effect.mapError(
              (error) => new RouteRequestError({ message: error.detail ?? error.message }),
            ),
          );
      }),

    [WS_METHODS.serverGetProviderInventory]: (request) =>
      Effect.gen(function* () {
        const body = withoutTag(request);
        const instance = yield* providerInstanceRegistry.getInstance(body.instanceId);
        if (!instance) {
          return yield* new RouteRequestError({ message: "Provider instance not found." });
        }
        const projectRoot = yield* resolveProviderInventoryProjectRoot(body.projectId);
        const entries = instance.inventory
          ? yield* instance
              .inventory({ projectRoot })
              .pipe(
                Effect.mapError(
                  (error) => new RouteRequestError({ message: error.detail ?? error.message }),
                ),
              )
          : {
              hooks: [],
              plugins: [],
              connectors: [],
              agents: [],
              warnings: ["This provider does not report an inventory."],
            };
        return {
          instanceId: instance.instanceId,
          driver: instance.driverKind,
          generatedAt: new Date().toISOString(),
          ...(body.projectId ? { projectId: body.projectId } : {}),
          ...entries,
        };
      }),

    [WS_METHODS.serverTrustProviderHooks]: (request) =>
      Effect.gen(function* () {
        const body = withoutTag(request);
        const instance = yield* providerInstanceRegistry.getInstance(body.instanceId);
        if (!instance || instance.driverKind !== "codex" || !instance.trustHooks) {
          return yield* new RouteRequestError({
            message: "Hook approval is only available for a configured Codex provider.",
          });
        }
        const projectRoot = yield* resolveProviderInventoryProjectRoot(body.projectId);
        return yield* instance
          .trustHooks({ projectRoot, hooks: body.hooks })
          .pipe(
            Effect.mapError(
              (error) => new RouteRequestError({ message: error.detail ?? error.message }),
            ),
          );
      }),

    [WS_METHODS.serverValidateHarnesses]: (request) =>
      Effect.gen(function* () {
        const body = withoutTag(request);
        const results = yield* harnessValidation
          .validate(
            body.providerOptions !== undefined
              ? { providerOptions: body.providerOptions }
              : undefined,
          )
          .pipe(
            Effect.mapError((error) =>
              error._tag === "ProviderValidationBusyError"
                ? new RouteRequestError({ message: error.message })
                : new RouteRequestError({ message: "Harness validation failed." }),
            ),
          );
        return { results };
      }),

    [WS_METHODS.serverUpsertKeybinding]: (request) =>
      keybindingsManager.upsertKeybindingRule(withoutTag(request)),

    [WS_METHODS.serverAddKeybinding]: (request) =>
      keybindingsManager
        .addKeybindingRule(request.rule)
        .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message }))),

    [WS_METHODS.serverUpdateKeybinding]: (request) =>
      keybindingsManager
        .updateKeybindingRule(withoutTag(request))
        .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message }))),

    [WS_METHODS.serverRemoveKeybinding]: (request) =>
      keybindingsManager
        .removeKeybindingRule(withoutTag(request))
        .pipe(Effect.mapError((error) => new RouteRequestError({ message: error.message }))),

    [WS_METHODS.serverResetKeybindings]: () =>
      keybindingsManager.resetKeybindingRules.pipe(
        Effect.mapError((error) => new RouteRequestError({ message: error.message })),
      ),
  };
};
