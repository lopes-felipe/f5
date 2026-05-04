import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ChildProcessSpawner } from "effect/unstable/process";

import { CheckpointDiffQueryLive } from "./checkpointing/Layers/CheckpointDiffQuery";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore";
import { ServerConfig } from "./config";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore";
import { ProviderSessionRuntimeRepositoryLive } from "./persistence/Layers/ProviderSessionRuntime";
import { ProjectMcpConfigRepositoryLive } from "./persistence/Layers/ProjectMcpConfigs";
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
import { WorkflowServiceLive } from "./orchestration/Layers/WorkflowService";
import { ProviderUnsupportedError } from "./provider/Errors";
import { makeClaudeAdapterLive } from "./provider/Layers/ClaudeAdapter";
import { makeCodexAdapterLive } from "./provider/Layers/CodexAdapter";
import { ProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry";
import { HarnessValidationLive } from "./provider/Layers/HarnessValidation";
import { makeProviderServiceLive } from "./provider/Layers/ProviderService";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory";
import { HarnessValidation } from "./provider/Services/HarnessValidation";
import { ProviderService } from "./provider/Services/ProviderService";
import { makeEventNdjsonLogger } from "./provider/Layers/EventNdjsonLogger";
import { ProjectMcpConfigServiceLive } from "./mcp/ProjectMcpConfigService";
import { ProjectMcpConfigService } from "./mcp/ProjectMcpConfigService";
import { McpRuntimeService, McpRuntimeServiceLive } from "./mcp/McpRuntimeService";

import { TerminalManagerLive } from "./terminal/Layers/Manager";
import { KeybindingsLive } from "./keybindings";
import { GitManagerLive } from "./git/Layers/GitManager";
import { GitCoreLive } from "./git/Layers/GitCore";
import { GitHubCliLive } from "./git/Layers/GitHubCli";
import { CodexTextGenerationLive } from "./git/Layers/CodexTextGeneration";
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

type RuntimePtyAdapterLoader = {
  layer: Layer.Layer<PtyAdapter, never, FileSystem.FileSystem | Path.Path>;
};

const runtimePtyAdapterLoaders = {
  bun: async () => ({ layer: (await import("./terminal/Layers/BunPTY")).BunPtyAdapterLive }),
  node: async () => ({ layer: (await import("./terminal/Layers/NodePTY")).NodePtyAdapterLive }),
} satisfies Record<string, () => Promise<RuntimePtyAdapterLoader>>;

const makeRuntimePtyAdapterLayer = () =>
  Effect.gen(function* () {
    const runtime = process.versions.bun !== undefined ? "bun" : "node";
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
  | ProjectMcpConfigService,
  ProviderUnsupportedError,
  | SqlClient.SqlClient
  | ServerConfig
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
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
    const codexMcpEventBusLayer = CodexMcpEventBusLive;
    const codexControlClientRegistryLayer = CodexControlClientRegistryLive;
    const codexMcpSyncServiceLayer = CodexMcpSyncServiceLive.pipe(
      Layer.provide(codexControlClientRegistryLayer),
      Layer.provide(projectMcpConfigServiceLayer),
    );
    const codexAdapterLayer = makeCodexAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const claudeAdapterLayer = makeClaudeAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const adapterRegistryLayer = ProviderAdapterRegistryLive.pipe(
      Layer.provide(codexAdapterLayer),
      Layer.provide(claudeAdapterLayer),
      Layer.provideMerge(providerSessionDirectoryLayer),
    );
    const providerServiceLayer = makeProviderServiceLive(
      canonicalEventLogger ? { canonicalEventLogger } : undefined,
    ).pipe(
      Layer.provide(adapterRegistryLayer),
      Layer.provide(providerSessionDirectoryLayer),
      Layer.provide(projectMcpConfigServiceLayer),
    );
    const harnessValidationLayer = HarnessValidationLive.pipe(Layer.provide(adapterRegistryLayer));
    const codexOAuthManagerLayer = CodexOAuthManagerLive.pipe(
      Layer.provide(providerServiceLayer),
      Layer.provide(codexControlClientRegistryLayer),
      Layer.provide(codexMcpSyncServiceLayer),
      Layer.provide(codexMcpEventBusLayer),
      Layer.provide(projectMcpConfigServiceLayer),
    );
    const mcpRuntimeServiceLayer = McpRuntimeServiceLive.pipe(
      Layer.provide(providerServiceLayer),
      Layer.provide(codexControlClientRegistryLayer),
      Layer.provide(codexMcpSyncServiceLayer),
      Layer.provide(codexOAuthManagerLayer),
      Layer.provide(codexMcpEventBusLayer),
      Layer.provide(projectMcpConfigServiceLayer),
    );
    return Layer.mergeAll(
      providerServiceLayer,
      harnessValidationLayer,
      codexMcpEventBusLayer,
      codexControlClientRegistryLayer,
      codexMcpSyncServiceLayer,
      codexOAuthManagerLayer,
      mcpRuntimeServiceLayer,
      projectMcpConfigServiceLayer,
    );
  }).pipe(Layer.unwrap);
}

export function makeServerRuntimeServicesLayer() {
  const gitCoreLayer = GitCoreLive.pipe(Layer.provideMerge(GitServiceLive));
  const textGenerationLayer = CodexTextGenerationLive;

  const checkpointDiffQueryLayer = CheckpointDiffQueryLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
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
    Layer.provideMerge(GitHubCliLive),
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
    terminalLayer,
    KeybindingsLive,
    ObservabilityLive,
  ).pipe(Layer.provideMerge(NodeServices.layer));
}

export function makeServerOrchestrationRuntimeLayer() {
  const textGenerationLayer = CodexTextGenerationLive;
  const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
    Layer.provide(ProviderSessionRuntimeRepositoryLive),
  );
  const projectionSnapshotQueryLayer = OrchestrationProjectionSnapshotQueryLive;
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
  );
  const gitCoreLayer = GitCoreLive.pipe(Layer.provideMerge(GitServiceLive));
  const workflowServiceLayer = WorkflowServiceLive.pipe(
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
  const runtimeIngestionLayer = ProviderRuntimeIngestionLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const providerCommandReactorLayer = ProviderCommandReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(textGenerationLayer),
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
  );
  const projectSetupScriptRunnerLayer = ProjectSetupScriptRunnerLive.pipe(
    Layer.provideMerge(orchestrationLayer),
  );

  return Layer.mergeAll(
    orchestrationLayer,
    workflowServiceLayer,
    codeReviewWorkflowServiceLayer,
    orchestrationReactorLayer,
    projectSetupScriptRunnerLayer,
  ).pipe(Layer.provideMerge(NodeServices.layer));
}
