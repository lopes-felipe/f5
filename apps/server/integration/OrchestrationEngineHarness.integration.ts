import { ProviderSessionDirectory } from "../src/provider/Services/ProviderSessionDirectory.ts";
import type { ProviderAdapterShape } from "../src/provider/Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../src/provider/Errors.ts";
import { GitServiceLive } from "../src/git/Layers/GitService.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  CommandId,
  ThreadId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  type OrchestrationEvent,
  type OrchestrationCommand,
  type OrchestrationThread,
} from "@t3tools/contracts";
import {
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  Ref,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";

import { CheckpointStoreLiveWithoutCredentials } from "../src/checkpointing/Layers/CheckpointStore.ts";
import { CheckpointStore } from "../src/checkpointing/Services/CheckpointStore.ts";
import { makeFakeGitCore } from "../src/git/testDoubles.ts";
import { GitCore, type GitCoreShape } from "../src/git/Services/GitCore.ts";
import { TextGeneration, type TextGenerationShape } from "../src/git/Services/TextGeneration.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionCheckpointRepositoryLive } from "../src/persistence/Layers/ProjectionCheckpoints.ts";
import { ProjectionTurnRepositoryLive } from "../src/persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadCommandExecutionRepositoryLive } from "../src/persistence/Layers/ProjectionThreadCommandExecutions.ts";
import { ThreadCommandExecutionQueryLive } from "../src/orchestration/Layers/ThreadCommandExecutionQuery.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../src/persistence/Layers/ProjectionPendingApprovals.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../src/persistence/Layers/ProviderSessionRuntime.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { PersistenceSqlError } from "../src/persistence/Errors.ts";
import { ProjectionCheckpointRepository } from "../src/persistence/Services/ProjectionCheckpoints.ts";
import { ProjectionPendingApprovalRepository } from "../src/persistence/Services/ProjectionPendingApprovals.ts";
import { ProviderAdapterRegistry } from "../src/provider/Services/ProviderAdapterRegistry.ts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "../src/provider/Layers/ProviderService.ts";
import { makeCodexAdapterLive } from "../src/provider/Layers/CodexAdapter.ts";
import { CodexAdapter } from "../src/provider/Services/CodexAdapter.ts";
import { ProviderService } from "../src/provider/Services/ProviderService.ts";
import { AnalyticsService } from "../src/telemetry/Services/AnalyticsService.ts";
import { CodexMcpSyncService } from "../src/codex/CodexMcpSyncService.ts";
import { ProjectMcpConfigService } from "../src/mcp/ProjectMcpConfigService.ts";
import { CheckpointReactorLive } from "../src/orchestration/Layers/CheckpointReactor.ts";
import { CompactionServiceLive } from "../src/orchestration/Layers/CompactionService.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBusLive } from "../src/orchestration/Layers/RuntimeReceiptBus.ts";
import { OrchestrationReactorLive } from "../src/orchestration/Layers/OrchestrationReactor.ts";
import { NativeSessionCleanupReactor } from "../src/orchestration/Services/NativeSessionCleanupReactor.ts";
import { ProviderCommandReactorLive } from "../src/orchestration/Layers/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionLive } from "../src/orchestration/Layers/ProviderRuntimeIngestion.ts";
import { ThreadBackgroundWorkLive } from "../src/orchestration/Layers/ThreadBackgroundWork.ts";
import { ProviderTurnDeliveryRepositoryLive } from "../src/orchestration/Layers/ProviderTurnDeliveryRepository.ts";
import { ProviderTurnDeliveryWorkerLive } from "../src/orchestration/Layers/ProviderTurnDeliveryWorker.ts";
import { ProjectSkillSyncServiceLive } from "../src/orchestration/Layers/ProjectSkillSyncService.ts";
import { SessionNotesServiceLive } from "../src/orchestration/Layers/SessionNotesService.ts";
import { CodeReviewWorkflowServiceLive } from "../src/orchestration/Layers/CodeReviewWorkflowService.ts";
import { InvestigationWorkflowServiceLive } from "../src/orchestration/Layers/InvestigationWorkflowService.ts";
import { WorkflowServiceLive } from "../src/orchestration/Layers/WorkflowService.ts";
import { makeAdapterRegistryMock } from "../src/provider/testUtils/providerAdapterRegistryMock.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../src/orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationReactor } from "../src/orchestration/Services/OrchestrationReactor.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  RuntimeReceiptBus,
  type OrchestrationRuntimeReceipt,
} from "../src/orchestration/Services/RuntimeReceiptBus.ts";

import {
  makeTestProviderAdapterHarness,
  type TestProviderAdapterHarness,
} from "./TestProviderAdapter.integration.ts";
import { ServerConfig } from "../src/config.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";
import { NextTurnQueueDispatcher } from "../src/nextTurnQueue/Services/NextTurnQueueDispatcher.ts";

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function initializeGitWorkspace(cwd: string) {
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(cwd, "README.md"), "v1\n", "utf8");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
}

export function gitRefExists(cwd: string, ref: string): boolean {
  try {
    runGit(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

export function gitShowFileAtRef(cwd: string, ref: string, filePath: string): string {
  return runGit(cwd, ["show", `${ref}:${filePath}`]);
}

class WaitForTimeoutError extends Schema.TaggedErrorClass<WaitForTimeoutError>()(
  "WaitForTimeoutError",
  {
    description: Schema.String,
  },
) {}

function waitFor<A, E>(
  read: Effect.Effect<A, E>,
  predicate: (value: A) => boolean,
  description: string,
  timeoutMs?: number,
): Effect.Effect<A, never>;
function waitFor<A, B extends A, E>(
  read: Effect.Effect<A, E>,
  predicate: (value: A) => value is B,
  description: string,
  timeoutMs?: number,
): Effect.Effect<B, never>;
function waitFor<A, E>(
  read: Effect.Effect<A, E>,
  predicate: (value: A) => boolean,
  description: string,
  timeoutMs = 10_000,
): Effect.Effect<A, never> {
  const RETRY_SIGNAL = "wait_for_retry";
  const retryIntervalMs = 10;
  const maxRetries = Math.max(0, Math.floor(timeoutMs / retryIntervalMs));
  const retrySchedule = Schedule.spaced(`${retryIntervalMs} millis`);

  return read.pipe(
    Effect.filterOrFail(predicate, () => RETRY_SIGNAL),
    Effect.retry({
      schedule: retrySchedule,
      times: maxRetries,
      while: (error) => error === RETRY_SIGNAL,
    }),
    Effect.mapError((error) =>
      error === RETRY_SIGNAL ? new WaitForTimeoutError({ description }) : error,
    ),
    Effect.orDie,
  );
}

class OrchestrationHarnessRuntimeError extends Schema.TaggedErrorClass<OrchestrationHarnessRuntimeError>()(
  "OrchestrationHarnessRuntimeError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

const tryRuntimePromise = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new OrchestrationHarnessRuntimeError({ operation, cause }),
  });

export interface OrchestrationIntegrationHarness {
  readonly rootDir: string;
  readonly workspaceDir: string;
  readonly dbPath: string;
  readonly adapterHarness: TestProviderAdapterHarness | null;
  readonly engine: OrchestrationEngineShape;
  readonly snapshotQuery: ProjectionSnapshotQuery["Service"];
  readonly providerService: ProviderService["Service"];
  readonly providerSessionDirectory: ProviderSessionDirectory["Service"];
  readonly checkpointStore: CheckpointStore["Service"];
  readonly checkpointRepository: ProjectionCheckpointRepository["Service"];
  readonly pendingApprovalRepository: ProjectionPendingApprovalRepository["Service"];
  readonly waitForThread: (
    threadId: string,
    predicate: (thread: OrchestrationThread) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<OrchestrationThread, never>;
  readonly waitForDomainEvent: (
    predicate: (event: OrchestrationEvent) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<ReadonlyArray<OrchestrationEvent>, never>;
  readonly waitForPendingApproval: (
    requestId: string,
    predicate: (row: {
      readonly status: "pending" | "resolved";
      readonly decision:
        | "accept"
        | "acceptForSession"
        | "acceptAlways"
        | "decline"
        | "cancel"
        | null;
      readonly resolvedAt: string | null;
    }) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<
    {
      readonly status: "pending" | "resolved";
      readonly decision:
        | "accept"
        | "acceptForSession"
        | "acceptAlways"
        | "decline"
        | "cancel"
        | null;
      readonly resolvedAt: string | null;
    },
    never
  >;
  readonly waitForReceipt: {
    (
      predicate: (receipt: OrchestrationRuntimeReceipt) => boolean,
      timeoutMs?: number,
    ): Effect.Effect<OrchestrationRuntimeReceipt, never>;
    <Receipt extends OrchestrationRuntimeReceipt>(
      predicate: (receipt: OrchestrationRuntimeReceipt) => receipt is Receipt,
      timeoutMs?: number,
    ): Effect.Effect<Receipt, never>;
  };
  readonly dispose: Effect.Effect<void, never>;
}

interface MakeOrchestrationIntegrationHarnessOptions {
  readonly adapter?: ProviderAdapterShape<ProviderAdapterError>;
  /** Caller-owned directory supports crash/restart scenarios without fixture deletion. */
  readonly rootDir?: string;
  readonly startReactors?: boolean;
  readonly beforeEngineDispatch?: (command: OrchestrationCommand) => Effect.Effect<void>;
  readonly prepareAdapter?: (adapter: TestProviderAdapterHarness) => Effect.Effect<void>;
  readonly provider?: "codex";
  readonly realCodex?: boolean;
}

export const makeOrchestrationIntegrationHarness = (
  options?: MakeOrchestrationIntegrationHarnessOptions,
) =>
  Effect.gen(function* () {
    const sleep = (ms: number) => Effect.sleep(ms);
    const provider = options?.provider ?? "codex";
    const useRealCodex = options?.adapter === undefined && options?.realCodex === true;
    const adapterHarness =
      useRealCodex || options?.adapter
        ? null
        : yield* makeTestProviderAdapterHarness({
            provider,
          });
    const fakeRegistry = options?.adapter
      ? Layer.succeed(
          ProviderAdapterRegistry,
          makeAdapterRegistryMock({ [options.adapter.provider]: options.adapter }),
        )
      : adapterHarness
        ? Layer.succeed(ProviderAdapterRegistry, {
            ...makeAdapterRegistryMock({ [adapterHarness.provider]: adapterHarness.adapter }),
          })
        : null;
    if (adapterHarness && options?.prepareAdapter) yield* options.prepareAdapter(adapterHarness);
    const rootDir =
      options?.rootDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "t3-orchestration-integration-"));
    const workspaceDir = path.join(rootDir, "workspace");
    const stateDir = path.join(rootDir, "state");
    const dbPath = path.join(stateDir, "state.sqlite");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    if (!fs.existsSync(path.join(workspaceDir, ".git"))) initializeGitWorkspace(workspaceDir);

    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const baseOrchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    );
    const beforeDispatch = options?.beforeEngineDispatch;
    const orchestrationLayer = beforeDispatch
      ? Layer.effect(
          OrchestrationEngineService,
          Effect.map(OrchestrationEngineService.asEffect(), (engine) => ({
            ...engine,
            dispatch: (command: OrchestrationCommand) =>
              beforeDispatch(command).pipe(Effect.andThen(engine.dispatch(command))),
          })),
        ).pipe(Layer.provide(baseOrchestrationLayer))
      : baseOrchestrationLayer;
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntimeRepositoryLive),
    );
    const codexMcpSyncServiceLayer = Layer.succeed(CodexMcpSyncService, {
      getStatus: ({ projectId }) =>
        Effect.succeed({
          projectId,
          support: "supported" as const,
        }),
    });
    const projectMcpConfigServiceLayer = Layer.succeed(ProjectMcpConfigService, {
      readCommonStoredConfig: () =>
        Effect.succeed({
          scope: "common" as const,
          version: "mcp-version-test",
          servers: {},
        }),
      readProjectStoredConfig: (projectId: ProjectId) =>
        Effect.succeed({
          scope: "project" as const,
          projectId,
          version: "mcp-version-test",
          servers: {},
        }),
      readEffectiveStoredConfig: (projectId: ProjectId) =>
        Effect.succeed({
          projectId,
          commonVersion: "mcp-version-test",
          projectVersion: "mcp-version-test",
          effectiveVersion: "mcp-version-test",
          servers: {},
        }),
      readEffectiveRuntimeConfig: (projectId: ProjectId) =>
        Effect.succeed({
          projectId,
          commonVersion: "mcp-version-test",
          projectVersion: "mcp-version-test",
          effectiveVersion: "mcp-version-test",
          servers: {},
        }),
      readCommonConfig: () =>
        Effect.succeed({
          version: "mcp-version-test",
          servers: {},
        }),
      replaceCommonConfig: (_input) =>
        Effect.succeed({
          version: "mcp-version-test",
          servers: {},
        }),
      readProjectConfig: (projectId) =>
        Effect.succeed({
          projectId,
          version: "mcp-version-test",
          servers: {},
        }),
      readEffectiveConfig: (projectId: ProjectId) =>
        Effect.succeed({
          projectId,
          commonVersion: "mcp-version-test",
          projectVersion: "mcp-version-test",
          effectiveVersion: "mcp-version-test",
          servers: {},
        }),
      replaceProjectConfig: (input) =>
        Effect.succeed({
          projectId: input.projectId,
          version: "mcp-version-test",
          servers: {},
        }),
      readCodexServers: (projectId) =>
        Effect.succeed({
          projectId,
          effectiveVersion: "mcp-version-test",
          servers: {},
        }),
    });
    const realCodexRegistry = Layer.effect(
      ProviderAdapterRegistry,
      Effect.gen(function* () {
        const codexAdapter = yield* CodexAdapter;
        return makeAdapterRegistryMock({ codex: codexAdapter });
      }),
    ).pipe(
      Layer.provide(makeCodexAdapterLive()),
      Layer.provideMerge(ServerConfig.layerTest(workspaceDir, stateDir)),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(providerSessionDirectoryLayer),
      Layer.provideMerge(codexMcpSyncServiceLayer),
      Layer.provideMerge(projectMcpConfigServiceLayer),
    );
    const providerLayer = useRealCodex
      ? makeProviderServiceLive().pipe(
          Layer.provide(providerSessionDirectoryLayer),
          Layer.provide(realCodexRegistry),
          Layer.provide(AnalyticsService.layerTest),
        )
      : makeProviderServiceLive().pipe(
          Layer.provide(providerSessionDirectoryLayer),
          Layer.provide(fakeRegistry!),
          Layer.provide(AnalyticsService.layerTest),
        );

    const runtimeServicesLayer = Layer.mergeAll(
      orchestrationLayer,
      OrchestrationProjectionSnapshotQueryLive,
      ProjectionCheckpointRepositoryLive,
      ProjectionPendingApprovalRepositoryLive,
      CheckpointStoreLiveWithoutCredentials,
      providerSessionDirectoryLayer,
      ThreadBackgroundWorkLive.pipe(Layer.provideMerge(providerSessionDirectoryLayer)),
      providerLayer,
      RuntimeReceiptBusLive,
      ProviderTurnDeliveryRepositoryLive,
      ProjectionTurnRepositoryLive,
      ThreadCommandExecutionQueryLive.pipe(
        Layer.provideMerge(ProjectionThreadCommandExecutionRepositoryLive),
      ),
    );
    const runtimeIngestionLayer = ProviderRuntimeIngestionLive.pipe(
      Layer.provideMerge(runtimeServicesLayer),
    );
    const gitCoreLayer = Layer.succeed(
      GitCore,
      makeFakeGitCore({
        renameBranch: (input: Parameters<GitCoreShape["renameBranch"]>[0]) =>
          Effect.succeed({ branch: input.newBranch }),
      }).service,
    );
    const textGenerationLayer = Layer.succeed(TextGeneration, {
      generateBranchName: () => Effect.succeed({ branch: null }),
    } as unknown as TextGenerationShape);
    const providerCommandReactorLayer = ProviderCommandReactorLive.pipe(
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(gitCoreLayer),
      Layer.provideMerge(textGenerationLayer),
    );
    const checkpointReactorLayer = CheckpointReactorLive.pipe(
      Layer.provide(GitServiceLive),
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
    const workflowServiceLayer = WorkflowServiceLive.pipe(
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(textGenerationLayer),
      Layer.provideMerge(gitCoreLayer),
    );
    const codeReviewWorkflowServiceLayer = CodeReviewWorkflowServiceLive.pipe(
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(textGenerationLayer),
    );
    const investigationWorkflowServiceLayer = InvestigationWorkflowServiceLive.pipe(
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(textGenerationLayer),
    );
    const nextTurnQueueDispatcherLayer = Layer.succeed(NextTurnQueueDispatcher, {
      start: Effect.void,
      notify: () => Effect.void,
      drain: Effect.void,
      submitAndSettle: () => Effect.die("unsupported in orchestration harness"),
      getSnapshot: () => Effect.die("unsupported in orchestration harness"),
      getSummary: Effect.die("unsupported in orchestration harness"),
      promote: () => Effect.die("unsupported in orchestration harness"),
      refreshGate: () => Effect.die("unsupported in orchestration harness"),
      scheduleUsageLimitResume: () => Effect.die("unsupported"),
      cancelUsageLimitResume: () => Effect.die("unsupported"),
      refreshUsageLimitResume: () => Effect.die("unsupported"),
      getBlockingDelivery: () => Effect.succeed(null),
      reconcileDeliveryPause: () => Effect.void,
      handleDeliveryOutcome: () => Effect.void,
      changes: Stream.empty,
      summaryChanges: Stream.empty,
    });
    const providerTurnDeliveryWorkerLayer = ProviderTurnDeliveryWorkerLive.pipe(
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(providerCommandReactorLayer),
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
      // The harness has no provider instances, so there is nothing to clean up.
      Layer.provideMerge(
        Layer.succeed(NativeSessionCleanupReactor, { start: Effect.void, drain: Effect.void }),
      ),
    );
    const layer = orchestrationReactorLayer.pipe(
      Layer.provide(persistenceLayer),
      Layer.provide(projectMcpConfigServiceLayer),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(ServerConfig.layerTest(workspaceDir, stateDir)),
      Layer.provideMerge(NodeServices.layer),
    );

    const runtime = ManagedRuntime.make(layer);
    const engine = yield* tryRuntimePromise("load OrchestrationEngine service", () =>
      runtime.runPromise(Effect.service(OrchestrationEngineService)),
    ).pipe(Effect.orDie);
    const reactor = yield* tryRuntimePromise("load OrchestrationReactor service", () =>
      runtime.runPromise(Effect.service(OrchestrationReactor)),
    ).pipe(Effect.orDie);
    const snapshotQuery = yield* tryRuntimePromise("load ProjectionSnapshotQuery service", () =>
      runtime.runPromise(Effect.service(ProjectionSnapshotQuery)),
    ).pipe(Effect.orDie);
    const providerService = yield* tryRuntimePromise("load ProviderService service", () =>
      runtime.runPromise(Effect.service(ProviderService)),
    ).pipe(Effect.orDie);
    const providerSessionDirectory = yield* tryRuntimePromise(
      "load ProviderSessionDirectory service",
      () => runtime.runPromise(Effect.service(ProviderSessionDirectory)),
    ).pipe(Effect.orDie);
    const checkpointStore = yield* tryRuntimePromise("load CheckpointStore service", () =>
      runtime.runPromise(Effect.service(CheckpointStore)),
    ).pipe(Effect.orDie);
    const checkpointRepository = yield* tryRuntimePromise(
      "load ProjectionCheckpointRepository service",
      () => runtime.runPromise(Effect.service(ProjectionCheckpointRepository)),
    ).pipe(Effect.orDie);
    const pendingApprovalRepository = yield* tryRuntimePromise(
      "load ProjectionPendingApprovalRepository service",
      () => runtime.runPromise(Effect.service(ProjectionPendingApprovalRepository)),
    ).pipe(Effect.orDie);
    const runtimeReceiptBus = yield* tryRuntimePromise("load RuntimeReceiptBus service", () =>
      runtime.runPromise(Effect.service(RuntimeReceiptBus)),
    ).pipe(Effect.orDie);

    const scope = yield* Scope.make("sequential");
    if (options?.startReactors !== false)
      yield* tryRuntimePromise("start OrchestrationReactor", () =>
        runtime.runPromise(reactor.start.pipe(Scope.provide(scope))),
      ).pipe(Effect.orDie);
    const receiptHistory = yield* Ref.make<ReadonlyArray<OrchestrationRuntimeReceipt>>([]);
    yield* Stream.runForEach(runtimeReceiptBus.stream, (receipt) =>
      Ref.update(receiptHistory, (history) => [...history, receipt]).pipe(Effect.asVoid),
    ).pipe(Effect.forkIn(scope));
    yield* sleep(10);

    const waitForThread: OrchestrationIntegrationHarness["waitForThread"] = (
      threadId,
      predicate,
      timeoutMs,
    ) =>
      waitFor(
        snapshotQuery.getSnapshot().pipe(
          // An expired read has rolled back and is explicitly retryable.
          // Retry only this read, never the command or provider side effect.
          Effect.retry({
            times: 2,
            schedule: Schedule.spaced("10 millis"),
            while: (error) => Schema.is(PersistenceSqlError)(error) && error.retryable === true,
          }),
          Effect.map(
            (snapshot) => snapshot.threads.find((thread) => thread.id === threadId) ?? null,
          ),
        ),
        (thread): thread is OrchestrationThread => thread !== null && predicate(thread),
        `projected thread '${threadId}'`,
        timeoutMs,
      ) as Effect.Effect<OrchestrationThread, never>;

    const waitForDomainEvent: OrchestrationIntegrationHarness["waitForDomainEvent"] = (
      predicate,
      timeoutMs,
    ) =>
      waitFor(
        Stream.runCollect(engine.readEvents(0)).pipe(
          Effect.map((chunk): ReadonlyArray<OrchestrationEvent> => Array.from(chunk)),
        ),
        (events) => events.some(predicate),
        "domain event",
        timeoutMs,
      );

    const waitForPendingApproval: OrchestrationIntegrationHarness["waitForPendingApproval"] = (
      requestId,
      predicate,
      timeoutMs,
    ) =>
      waitFor(
        pendingApprovalRepository
          .getByRequestId({ requestId: ApprovalRequestId.makeUnsafe(requestId) })
          .pipe(
            Effect.map((row) =>
              Option.match(row, {
                onNone: () => null,
                onSome: (value) => ({
                  status: value.status,
                  decision: value.decision,
                  resolvedAt: value.resolvedAt,
                }),
              }),
            ),
          ),
        (
          row,
        ): row is {
          readonly status: "pending" | "resolved";
          readonly decision:
            | "accept"
            | "acceptForSession"
            | "acceptAlways"
            | "decline"
            | "cancel"
            | null;
          readonly resolvedAt: string | null;
        } => row !== null && predicate(row),
        `pending approval '${requestId}'`,
        timeoutMs,
      ) as Effect.Effect<
        {
          readonly status: "pending" | "resolved";
          readonly decision:
            | "accept"
            | "acceptForSession"
            | "acceptAlways"
            | "decline"
            | "cancel"
            | null;
          readonly resolvedAt: string | null;
        },
        never
      >;

    function waitForReceipt(
      predicate: (receipt: OrchestrationRuntimeReceipt) => boolean,
      timeoutMs?: number,
    ): Effect.Effect<OrchestrationRuntimeReceipt, never>;
    function waitForReceipt<Receipt extends OrchestrationRuntimeReceipt>(
      predicate: (receipt: OrchestrationRuntimeReceipt) => receipt is Receipt,
      timeoutMs?: number,
    ): Effect.Effect<Receipt, never>;
    function waitForReceipt(
      predicate: (receipt: OrchestrationRuntimeReceipt) => boolean,
      timeoutMs?: number,
    ) {
      const readMatchingReceipt = Ref.get(receiptHistory).pipe(
        Effect.map((history) => history.find(predicate)),
      );

      return waitFor(
        readMatchingReceipt,
        (receipt): receipt is OrchestrationRuntimeReceipt => receipt !== undefined,
        "runtime receipt",
        timeoutMs,
      );
    }

    let disposed = false;
    const dispose = Effect.gen(function* () {
      if (disposed) {
        return;
      }
      disposed = true;

      const shutdown = Effect.gen(function* () {
        const closeScopeExit = yield* Effect.exit(Scope.close(scope, Exit.void));
        const disposeRuntimeExit = yield* Effect.exit(Effect.promise(() => runtime.dispose()));

        const failureCause = Exit.isFailure(closeScopeExit)
          ? closeScopeExit.cause
          : Exit.isFailure(disposeRuntimeExit)
            ? disposeRuntimeExit.cause
            : null;

        if (failureCause) {
          return yield* Effect.failCause(failureCause);
        }
      });

      yield* shutdown.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (!options?.rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
          }),
        ),
      );
    });

    return {
      rootDir,
      workspaceDir,
      dbPath,
      adapterHarness,
      engine,
      snapshotQuery,
      providerService,
      providerSessionDirectory,
      checkpointStore,
      checkpointRepository,
      pendingApprovalRepository,
      waitForThread,
      waitForDomainEvent,
      waitForPendingApproval,
      waitForReceipt,
      dispose,
    } satisfies OrchestrationIntegrationHarness;
  });

/** Common aggregate seed for integration and chaos scenarios. */
export const seedOrchestrationProjectAndThread = (
  harness: OrchestrationIntegrationHarness,
  branch: string | null = null,
) =>
  Effect.gen(function* () {
    const createdAt = new Date().toISOString();
    const projectId = ProjectId.makeUnsafe("project-1");
    yield* harness.engine.dispatch({
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-project-create"),
      projectId,
      title: "Integration Project",
      workspaceRoot: harness.workspaceDir,
      defaultModel: "gpt-5-codex",
      createdAt,
    });
    yield* harness.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe("cmd-thread-create"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      projectId,
      title: "Integration Thread",
      model: "gpt-5-codex",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch,
      worktreePath: null,
      createdAt,
    });
  });
