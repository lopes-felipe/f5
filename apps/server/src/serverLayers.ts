import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, Path, PlatformError } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ChildProcessSpawner } from "effect/unstable/process";

import { CheckpointDiffQueryLive } from "./checkpointing/Layers/CheckpointDiffQuery";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore";
import { ServerConfig } from "./config";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore";
import { ProviderSessionRuntimeRepositoryLive } from "./persistence/Layers/ProviderSessionRuntime";
import { ProjectMcpConfigRepositoryLive } from "./persistence/Layers/ProjectMcpConfigs";
import { ProjectionCheckpointRepositoryLive } from "./persistence/Layers/ProjectionCheckpoints";
import { ProjectionProjectRepositoryLive } from "./persistence/Layers/ProjectionProjects";
import { ProjectionThreadRepositoryLive } from "./persistence/Layers/ProjectionThreads";
import { ProjectionThreadSessionRepositoryLive } from "./persistence/Layers/ProjectionThreadSessions";
import { ProjectionTurnRepositoryLive } from "./persistence/Layers/ProjectionTurns";
import { OrchestrationEngineLive } from "./orchestration/Layers/OrchestrationEngine";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor";
import { CompactionServiceLive } from "./orchestration/Layers/CompactionService";
import { ProjectSkillSyncServiceLive } from "./orchestration/Layers/ProjectSkillSyncService";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor";
import { OrchestrationProjectionPipelineLive } from "./orchestration/Layers/ProjectionPipeline";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery";
import { SessionNotesServiceLive } from "./orchestration/Layers/SessionNotesService";
import { ThreadCommandExecutionQueryLive } from "./orchestration/Layers/ThreadCommandExecutionQuery";
import { ThreadFileChangeQueryLive } from "./orchestration/Layers/ThreadFileChangeQuery";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion";
import { RuntimeReceiptBusLive } from "./orchestration/Layers/RuntimeReceiptBus";
import { CodeReviewWorkflowServiceLive } from "./orchestration/Layers/CodeReviewWorkflowService";
import { InvestigationWorkflowServiceLive } from "./orchestration/Layers/InvestigationWorkflowService";
import { WorkflowServiceLive } from "./orchestration/Layers/WorkflowService";
import { ProviderUnsupportedError } from "./provider/Errors";
import { HarnessValidationLive } from "./provider/Layers/HarnessValidation";
import { ProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry";
import { ProviderEventLoggers } from "./provider/Layers/ProviderEventLoggers";
import { ProviderInstanceRegistryHydrationLive } from "./provider/Layers/ProviderInstanceRegistryHydration";
import { ProviderAdvisoryProjectionLive } from "./provider/Layers/ProviderAdvisoryProjectionLive";
import { ProviderRegistryLive } from "./provider/Layers/ProviderRegistry";
import { ProviderUpdateAdvisorLive } from "./provider/Layers/ProviderUpdateAdvisorLive";
import { makeProviderServiceLive } from "./provider/Layers/ProviderService";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory";
import { ProviderSessionReaperLive } from "./provider/Layers/ProviderSessionReaper";
import { HarnessValidation } from "./provider/Services/HarnessValidation";
import { ProviderService } from "./provider/Services/ProviderService";
import { ProviderAdapterRegistry } from "./provider/Services/ProviderAdapterRegistry";
import { ProviderAdvisoryProjection } from "./provider/Services/ProviderAdvisoryProjection";
import { ProviderInstanceRegistry } from "./provider/Services/ProviderInstanceRegistry";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry";
import { ProviderUpdateAdvisor } from "./provider/Services/ProviderUpdateAdvisor";
import { makeEventNdjsonLogger } from "./provider/Layers/EventNdjsonLogger";
import { OpenCodeRuntimeLive } from "./provider/opencodeRuntime";
import { ProjectMcpConfigServiceLive } from "./mcp/ProjectMcpConfigService";
import { ProjectMcpConfigService } from "./mcp/ProjectMcpConfigService";
import { McpRuntimeService, McpRuntimeServiceLive } from "./mcp/McpRuntimeService";
import { McpRuntimeDiagnosticsLive } from "./mcp/McpRuntimeDiagnostics";
import {
  PreviewAutomationBroker,
  PreviewAutomationBrokerLive,
} from "./mcp/PreviewAutomationBroker";
import {
  PreviewMcpHttpServer,
  PreviewMcpHttpServerError,
  PreviewMcpHttpServerLive,
} from "./mcp/PreviewMcpHttpServer";
import { StorageMaintenanceLive } from "./storage/StorageMaintenance";
import { PrHubAdvisoryServiceLive } from "./prHub/Layers/PrHubAdvisoryService";
import { PrHubServiceLive } from "./prHub/Layers/PrHubService";

import { TerminalManagerLive } from "./terminal/Layers/Manager";
import { KeybindingsLive } from "./keybindings";
import { GitManagerLive } from "./git/Layers/GitManager";
import { GitCoreLive } from "./git/Layers/GitCore";
import { GitHubCliLive } from "./git/Layers/GitHubCli";
import { TextGenerationLive } from "./git/Layers/TextGenerationLive";
import { GitServiceLive } from "./git/Layers/GitService";
import { ObservabilityLive } from "./observability/Layers/Observability";
import { ProjectSetupScriptRunnerLive } from "./project/Layers/ProjectSetupScriptRunner";
import { PtyAdapter } from "./terminal/Services/PTY";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService";
import { ProjectionThreadCommandExecutionRepositoryLive } from "./persistence/Layers/ProjectionThreadCommandExecutions";
import { ProjectionThreadFileChangeRepositoryLive } from "./persistence/Layers/ProjectionThreadFileChanges";
import { CodexControlClientRegistryLive } from "./codex/CodexControlClientRegistry";
import { CodexMcpEventBusLive } from "./codex/CodexMcpEventBus";
import { CodexMcpSyncServiceLive } from "./codex/CodexMcpSyncService";
import { CodexOAuthManagerLive } from "./codex/CodexOAuthManager";
import { CodexControlClientRegistry } from "./codex/CodexControlClientRegistry";
import { CodexMcpEventBus } from "./codex/CodexMcpEventBus";
import { CodexMcpSyncService } from "./codex/CodexMcpSyncService";
import { CodexOAuthManager } from "./codex/CodexOAuthManager";
import { ServerSettingsLive, ServerSettingsService } from "./serverSettings";
import { NextTurnQueueStoreLive } from "./nextTurnQueue/Layers/NextTurnQueueStore";
import { NextTurnQueueDispatcherLive } from "./nextTurnQueue/Layers/NextTurnQueueDispatcher";
import { ProviderTurnDeliveryRepositoryLive } from "./orchestration/Layers/ProviderTurnDeliveryRepository";
import { ProviderTurnDeliveryWorkerLive } from "./orchestration/Layers/ProviderTurnDeliveryWorker";
import { SecretStoreError } from "./auth/Services/ServerSecretStore";
import { HttpClient } from "effect/unstable/http";

type RuntimePtyAdapterLoader = {
  layer: Layer.Layer<PtyAdapter, never, FileSystem.FileSystem | Path.Path>;
};

const runtimePtyAdapterLoaders = {
  bun: async () => ({ layer: (await import("./terminal/Layers/BunPTY")).BunPtyAdapterLive }),
  node: async () => ({ layer: (await import("./terminal/Layers/NodePTY")).NodePtyAdapterLive }),
} satisfies Record<string, () => Promise<RuntimePtyAdapterLoader>>;

export function selectRuntimePtyAdapter(
  platform: NodeJS.Platform = process.platform,
  hasBunRuntime: boolean = process.versions.bun !== undefined,
): keyof typeof runtimePtyAdapterLoaders {
  return platform === "win32" || !hasBunRuntime ? "node" : "bun";
}

const makeRuntimePtyAdapterLayer = () =>
  Effect.gen(function* () {
    const runtime = selectRuntimePtyAdapter();
    const loader = runtimePtyAdapterLoaders[runtime];
    const ptyAdapterModule = yield* Effect.promise<RuntimePtyAdapterLoader>(loader);
    return ptyAdapterModule.layer;
  }).pipe(Layer.unwrap);

export function makeServerProviderLayer(): Layer.Layer<
  | ProviderService
  | HarnessValidation
  | CodexMcpEventBus
  | CodexControlClientRegistry
  | CodexMcpSyncService
  | CodexOAuthManager
  | McpRuntimeService
  | ProjectMcpConfigService
  | PreviewAutomationBroker
  | PreviewMcpHttpServer
  | ProviderRegistry
  | ProviderUpdateAdvisor
  | ProviderAdvisoryProjection
  | ProviderInstanceRegistry
  | ProviderAdapterRegistry
  | ServerSettingsService,
  | ProviderUnsupportedError
  | PlatformError.PlatformError
  | PreviewMcpHttpServerError
  | SecretStoreError,
  | SqlClient.SqlClient
  | ServerConfig
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient
  | AnalyticsService
> {
  return Effect.gen(function* () {
    const { providerEventLogPath } = yield* ServerConfig;
    const nativeEventLogger = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "native",
    });
    const canonicalEventLogger = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "canonical",
    });
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntimeRepositoryLive),
    );
    const projectMcpConfigRepositoryLayer = ProjectMcpConfigRepositoryLive;
    const projectMcpConfigServiceLayer = ProjectMcpConfigServiceLive.pipe(
      Layer.provide(projectMcpConfigRepositoryLayer),
    );
    const providerEventLoggersLayer = Layer.succeed(ProviderEventLoggers, {
      native: nativeEventLogger,
      canonical: canonicalEventLogger,
    });
    const serverSettingsLayer = ServerSettingsLive;
    const previewAutomationBrokerLayer = PreviewAutomationBrokerLive;
    const previewMcpHttpServerLayer = PreviewMcpHttpServerLive.pipe(
      Layer.provide(previewAutomationBrokerLayer),
    );
    const providerInstanceRegistryLayer = ProviderInstanceRegistryHydrationLive.pipe(
      Layer.provide(serverSettingsLayer),
      Layer.provide(providerEventLoggersLayer),
      Layer.provide(OpenCodeRuntimeLive),
      Layer.provide(previewMcpHttpServerLayer),
    );
    const adapterRegistryLayer = ProviderAdapterRegistryLive.pipe(
      Layer.provide(providerInstanceRegistryLayer),
    );
    const providerRegistryLayer = ProviderRegistryLive.pipe(
      Layer.provide(providerInstanceRegistryLayer),
    );
    const providerUpdateAdvisorLayer = ProviderUpdateAdvisorLive.pipe(
      Layer.provide(providerRegistryLayer),
      Layer.provide(serverSettingsLayer),
    );
    const providerAdvisoryProjectionLayer = ProviderAdvisoryProjectionLive.pipe(
      Layer.provide(providerRegistryLayer),
      Layer.provide(providerUpdateAdvisorLayer),
    );
    const codexMcpEventBusLayer = CodexMcpEventBusLive;
    const codexControlClientRegistryLayer = CodexControlClientRegistryLive;
    const codexMcpSyncServiceLayer = CodexMcpSyncServiceLive.pipe(
      Layer.provide(codexControlClientRegistryLayer),
      Layer.provide(projectMcpConfigServiceLayer),
    );
    const providerServiceLayer = makeProviderServiceLive(
      canonicalEventLogger ? { canonicalEventLogger } : undefined,
    ).pipe(
      Layer.provide(adapterRegistryLayer),
      Layer.provide(providerSessionDirectoryLayer),
      Layer.provide(projectMcpConfigServiceLayer),
    );
    const harnessValidationLayer = HarnessValidationLive.pipe(
      Layer.provide(adapterRegistryLayer),
      Layer.provide(serverSettingsLayer),
      Layer.provide(OpenCodeRuntimeLive),
    );
    const codexOAuthManagerLayer = CodexOAuthManagerLive.pipe(
      Layer.provide(providerServiceLayer),
      Layer.provide(codexControlClientRegistryLayer),
      Layer.provide(codexMcpSyncServiceLayer),
      Layer.provide(codexMcpEventBusLayer),
      Layer.provide(projectMcpConfigServiceLayer),
    );
    const mcpRuntimeServiceLayer = McpRuntimeServiceLive.pipe(
      Layer.provide(McpRuntimeDiagnosticsLive),
      Layer.provide(providerServiceLayer),
      Layer.provide(codexControlClientRegistryLayer),
      Layer.provide(codexMcpSyncServiceLayer),
      Layer.provide(codexOAuthManagerLayer),
      Layer.provide(codexMcpEventBusLayer),
      Layer.provide(projectMcpConfigServiceLayer),
    );
    return Layer.mergeAll(
      serverSettingsLayer,
      providerServiceLayer,
      harnessValidationLayer,
      providerInstanceRegistryLayer,
      adapterRegistryLayer,
      providerRegistryLayer,
      providerUpdateAdvisorLayer,
      providerAdvisoryProjectionLayer,
      codexMcpEventBusLayer,
      codexControlClientRegistryLayer,
      codexMcpSyncServiceLayer,
      codexOAuthManagerLayer,
      mcpRuntimeServiceLayer,
      projectMcpConfigServiceLayer,
      previewAutomationBrokerLayer,
      previewMcpHttpServerLayer,
    );
  }).pipe(Layer.unwrap);
}

export function makeServerRuntimeServicesLayer() {
  const gitCoreLayer = GitCoreLive.pipe(Layer.provideMerge(GitServiceLive));
  const githubCliLayer = GitHubCliLive;
  const textGenerationLayer = TextGenerationLive;

  const checkpointDiffQueryLayer = CheckpointDiffQueryLive.pipe(
    Layer.provideMerge(ProjectionThreadRepositoryLive),
    Layer.provideMerge(ProjectionProjectRepositoryLive),
    Layer.provideMerge(ProjectionCheckpointRepositoryLive),
    Layer.provideMerge(CheckpointStoreLive),
  );
  const threadCommandExecutionQueryLayer = ThreadCommandExecutionQueryLive.pipe(
    Layer.provideMerge(ProjectionThreadCommandExecutionRepositoryLive),
  );
  const threadFileChangeQueryLayer = ThreadFileChangeQueryLive.pipe(
    Layer.provideMerge(ProjectionThreadFileChangeRepositoryLive),
  );

  const terminalLayer = TerminalManagerLive.pipe(Layer.provide(makeRuntimePtyAdapterLayer()));

  const gitManagerLayer = GitManagerLive.pipe(
    Layer.provideMerge(gitCoreLayer),
    Layer.provideMerge(githubCliLayer),
    Layer.provideMerge(textGenerationLayer),
  );
  const prHubLayer = PrHubServiceLive.pipe(
    Layer.provideMerge(gitCoreLayer),
    Layer.provideMerge(githubCliLayer),
    Layer.provideMerge(ProjectionProjectRepositoryLive),
  );
  const prHubAdvisoryLayer = PrHubAdvisoryServiceLive.pipe(
    Layer.provideMerge(prHubLayer),
    Layer.provideMerge(githubCliLayer),
    Layer.provideMerge(textGenerationLayer),
  );

  return Layer.mergeAll(
    OrchestrationProjectionSnapshotQueryLive,
    threadCommandExecutionQueryLayer,
    threadFileChangeQueryLayer,
    CheckpointStoreLive,
    checkpointDiffQueryLayer,
    gitCoreLayer,
    gitManagerLayer,
    prHubLayer,
    prHubAdvisoryLayer,
    terminalLayer,
    KeybindingsLive,
    ObservabilityLive,
    NextTurnQueueStoreLive,
  ).pipe(Layer.provideMerge(NodeServices.layer));
}

export function makeServerOrchestrationRuntimeLayer() {
  const textGenerationLayer = TextGenerationLive;
  const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
    Layer.provide(ProviderSessionRuntimeRepositoryLive),
  );
  const projectionSnapshotQueryLayer = OrchestrationProjectionSnapshotQueryLive;
  const gitCoreLayer = GitCoreLive.pipe(Layer.provideMerge(GitServiceLive));
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(projectionSnapshotQueryLayer),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  );
  const runtimeServicesLayer = Layer.mergeAll(
    orchestrationLayer,
    projectionSnapshotQueryLayer,
    providerSessionDirectoryLayer,
    RuntimeReceiptBusLive,
    ProviderTurnDeliveryRepositoryLive,
    ProjectionTurnRepositoryLive,
    StorageMaintenanceLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(gitCoreLayer),
      Layer.provideMerge(OrchestrationEventStoreLive),
    ),
  );
  const nextTurnQueueDispatcherLayer = NextTurnQueueDispatcherLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(ProjectionThreadRepositoryLive),
    Layer.provideMerge(ProjectionThreadSessionRepositoryLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
  );
  const workflowServiceBaseLayer = WorkflowServiceLive.pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(projectionSnapshotQueryLayer),
    Layer.provideMerge(textGenerationLayer),
    Layer.provideMerge(gitCoreLayer),
  );
  const codeReviewWorkflowServiceLayer = CodeReviewWorkflowServiceLive.pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(projectionSnapshotQueryLayer),
    Layer.provideMerge(textGenerationLayer),
  );
  const investigationWorkflowServiceLayer = InvestigationWorkflowServiceLive.pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(projectionSnapshotQueryLayer),
    Layer.provideMerge(textGenerationLayer),
  );
  const runtimeIngestionLayer = ProviderRuntimeIngestionLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const providerCommandReactorLayer = ProviderCommandReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(textGenerationLayer),
  );
  const providerTurnDeliveryWorkerLayer = ProviderTurnDeliveryWorkerLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(providerCommandReactorLayer),
  );
  const workflowServiceLayer = workflowServiceBaseLayer.pipe(
    Layer.provideMerge(providerTurnDeliveryWorkerLayer),
  );
  const checkpointReactorLayer = CheckpointReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const compactionServiceLayer = CompactionServiceLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const projectSkillSyncServiceLayer = ProjectSkillSyncServiceLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const sessionNotesServiceLayer = SessionNotesServiceLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const orchestrationReactorLayer = OrchestrationReactorLive.pipe(
    Layer.provideMerge(runtimeIngestionLayer),
    Layer.provideMerge(providerCommandReactorLayer),
    Layer.provideMerge(checkpointReactorLayer),
    Layer.provideMerge(compactionServiceLayer),
    Layer.provideMerge(projectSkillSyncServiceLayer),
    Layer.provideMerge(sessionNotesServiceLayer),
    Layer.provideMerge(workflowServiceLayer),
    Layer.provideMerge(codeReviewWorkflowServiceLayer),
    Layer.provideMerge(investigationWorkflowServiceLayer),
    Layer.provideMerge(nextTurnQueueDispatcherLayer),
    Layer.provideMerge(providerTurnDeliveryWorkerLayer),
  );
  const providerSessionReaperLayer = ProviderSessionReaperLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const projectSetupScriptRunnerLayer = ProjectSetupScriptRunnerLive.pipe(
    Layer.provideMerge(orchestrationLayer),
  );

  return Layer.mergeAll(
    orchestrationLayer,
    workflowServiceLayer,
    codeReviewWorkflowServiceLayer,
    investigationWorkflowServiceLayer,
    orchestrationReactorLayer,
    providerSessionReaperLayer,
    projectSetupScriptRunnerLayer,
    nextTurnQueueDispatcherLayer,
    providerTurnDeliveryWorkerLayer,
  ).pipe(Layer.provideMerge(NodeServices.layer));
}
