import { timeOrderedUuid } from "@t3tools/shared/ids";
import { makeShutdownSourceScope, registerShutdown } from "../../shutdown.ts";
import { setupProjectScript } from "@t3tools/shared/projectScripts";
import { makeWorkflowArchiveLifecycle } from "../workflowArchiveLifecycle.ts";
import {
  CommandId,
  DOCUMENT_WORKFLOW_TEMPLATE_ID,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationRetryWorkflowResult,
  type OrchestrationThread,
  OrchestrationProposedPlanId,
  PlanningWorkflowId,
  type PlanningWorkflow,
  ThreadId,
  type ThreadTurnStartCommand,
  TurnId,
  type WorkflowBranch,
  type WorkflowBranchId,
  type WorkflowModelSlot,
  type WorkflowReviewSlot,
} from "@t3tools/contracts";
import {
  expectedPlanReviewEdges,
  planningBranches,
  planningBranchIds,
  planReviewReviewerBranchId,
  requirePlanningBranch,
  updatePlanningBranch,
  workflowMaxParticipants,
  workflowModelSlotsHaveDuplicate,
  workflowParticipantIndex,
  workflowParticipantLabel,
  workflowUsesMesh,
} from "@t3tools/shared/workflowParticipants";
import { createHash } from "node:crypto";
import {
  Cause,
  Clock,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { roughTokenEstimateFromCharacters } from "@t3tools/shared/model";
import {
  defaultDocumentReaderSlot,
  documentWorkflowForThread,
  isDocumentWorkflow,
  planningWorkflowDocumentType,
  validateDocumentArtifact,
  type DocumentValidationResult,
} from "@t3tools/shared/documentWorkflow";
import { makeBackgroundWorker } from "../../backgroundWorker.ts";
import { planningWorkflowBranchFailureStage } from "@t3tools/shared/planningWorkflow";
import {
  extractProposedPlanMarkdown,
  stripProposedPlanBlockTags,
  validateProposedPlanOutput,
} from "@t3tools/shared/proposedPlan";
import { isArchivedWorkflow, isDeletedWorkflow } from "@t3tools/shared/workflowArchive";
import {
  buildTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
} from "@t3tools/shared/worktree";

import { GitCore } from "../../git/Services/GitCore.ts";
import { CheckpointDiffQuery } from "../../checkpointing/Services/CheckpointDiffQuery.ts";
import { truncatePatchAtFileBoundary } from "../../git/patchTruncation.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { buildFallbackTitle, resolveBestEffortGeneratedTitle } from "../../threadTitle.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  WorkflowService,
  type CreateWorkflowInput,
  type WorkflowServiceShape,
} from "../Services/WorkflowService.ts";
import {
  buildDocumentAuthorPrompt,
  buildDocumentReviewPrompt,
  buildDocumentRevisionPrompt,
  buildDocumentReaderReviewPrompt,
  buildDocumentPolishPrompt,
} from "../documentWorkflowPrompts.ts";
import {
  markDocumentMergeDrafted,
  markReaderRunning,
  markReaderSaved,
  markPolishRequested,
  markPolishCompleted,
  markReaderPassError,
  markReaderPassSkipped,
} from "../documentReaderPass.ts";
import {
  buildAuthorPrompt,
  buildCodeReviewPrompt,
  buildImplementationPrompt,
  buildImplementationRevisionPrompt,
  buildReviewPrompt,
  buildRevisionPrompt,
} from "../workflowPrompts.ts";
import {
  getFinishedConsumableLatestTurn,
  getFinishedConsumableTurn,
  formatAssistantFeedback,
  nextWorkflowSlug,
  reviewFeedbackForPinnedTurn,
  slotLabel,
  type WorkflowFitThread,
  WORKFLOW_FAN_IN_MIN_ARTIFACT_CHARS,
  WORKFLOW_MAX_ACTIVE_REVIEW_TURNS,
  WORKFLOW_MIN_PLAN_CHAR_BUDGET,
  WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT,
  workflowContextTarget,
  workflowPromptFit,
} from "../workflowSharedUtils.ts";
import { applyWorkflowTurnCost, workflowBudgetError } from "../workflowBudget.ts";
import {
  resolveAvailableWorkflowModelSlot,
  workflowTurnProviderFields,
  withWorkflowModelSelectionGuard,
} from "../workflowModelSelection.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { type OrchestrationDispatchError } from "../Errors.ts";
import { ProviderTurnDeliveryWorker } from "../Services/ProviderTurnDeliveryWorker.ts";
import {
  CompactionService,
  type WorkflowCompactionOutcome,
} from "../Services/CompactionService.ts";
import { ProviderTurnDeliveryRepository } from "../Services/ProviderTurnDeliveryRepository.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { makeOperationGate } from "../../provider/operationGate.ts";
import {
  makeWorkflowStageDispatchResolver,
  STARTUP_DISPATCH_RECHECK_TIMEOUT,
} from "../workflowStageDispatch.ts";
import {
  assertWorkflowStageProviderSupported,
  latestWorkflowTemplateVersion,
  documentWorkflowCreateInvariant,
  resolveWorkflowBehavior,
  type UnsupportedWorkflowProviderError,
  UnsupportedWorkflowTemplateError,
  workflowTurnBehaviorFields,
} from "../workflowBehavior.ts";
import {
  buildPlanningWorkflowRecord,
  planningCommandAuthorFields,
  planningInputAuthorFields,
  planningInputAuthorSlots,
} from "../workflowRecordBuilders.ts";
import type { WorkflowRetryContext } from "../workflowPromptFragments.ts";
import { prepareCodeReviewPrompt } from "../workflowReviewPrompt.ts";

import {
  createWorkflowStageThread,
  dispatchWorkflowDeleteCompensationCommand,
  readActivePlanningWorkflow as readWorkflow,
  upsertPlanningWorkflowRecord,
} from "../workflowEngine/WorkflowThreadCoordinator.ts";
import {
  buildWorkflowMergePrompt,
  excerptRevisionReviews,
  planReplacementFilter,
  planReviewThreadId,
  type ReplacementPlanCandidate,
  workflowPlanCharBudget,
  workflowPlanMergeChars,
  WORKFLOW_PLANNING_INTERACTION_MODE,
  MAX_AUTO_RETRY_ATTEMPTS,
  AUTO_RETRY_BACKOFF_MS,
  AUTO_RETRY_SETTLE_INTERVAL_MS,
  AUTO_RETRY_SETTLE_TIMEOUT_MS,
  stableWorkflowUuid,
  stableWorkflowCommandId,
  errorMessage,
  workflowPromptInvariant,
  isRetryableSessionError,
  formatSessionError,
  isSessionSettledForAutoRetry,
  hasRunningSessionTurn,
  isSessionUnavailableForReconciliation,
  getFinishedLatestTurnId,
  updateAuthoringBranch,
  planReviewLabel,
  labelForThread,
  workflowForAuthorThread,
  markBranchPlanSaved,
  markBranchError,
  workflowForReviewThread,
  workflowForCodeReviewThread,
  workflowForImplementationThread,
  workflowForMergeThread,
  planReviewerSlot,
  markReviewsRequested,
  markReviewCompleted,
  markPlanningReviewError,
  markBranchRevising,
  markBranchRevised,
  markMergeStarted,
  markMergeError,
  markMergeReadyForManualReview,
  repinManualReviewApprovedPlan,
  markImplementationDone,
  markCodeReviewsRequested,
  markCodeReviewsRunning,
  markCodeReviewCompleted,
  markImplementationApplyingReviews,
  hasMisattributedRevision,
  isApplyReviewsLifecycle,
  markImplementationCompleted,
  markImplementationError,
  markCodeReviewError,
  incrementBranchRetryCount,
  incrementPlanningReviewRetryCount,
  incrementImplementationRetryCount,
  incrementCodeReviewRetryCount,
  latestMarkdownFileChangePath,
  hasProposedPlanForTurn,
  reviewedPlanTurnIdForBranch,
  planOverBudgetMessage,
  validateCapturedPlanForTurn,
  compareWorkflowReviewSlots,
  resolveApprovedMergedPlan,
  resolveMergedPlanForImplementation,
  type WorkflowTitleGenerationWorkItem,
  type PlanReviewIntent,
} from "../workflowEngine/PlanningWorkflowTransitions.ts";

export { workflowPlanCharBudget, workflowPlanMergeChars };

export const makeWorkflowService = Effect.gen(function* () {
  const sources = yield* makeShutdownSourceScope("planning-workflows-sources");
  const baseOrchestrationEngine = yield* OrchestrationEngineService;
  const textGeneration = yield* TextGeneration;
  const gitCore = yield* GitCore;
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry);
  const providerTurnDeliveryWorker = yield* Effect.serviceOption(ProviderTurnDeliveryWorker);
  const providerTurnDeliveryRepository = yield* Effect.serviceOption(
    ProviderTurnDeliveryRepository,
  );
  const checkpointDiffQuery = yield* Effect.serviceOption(CheckpointDiffQuery);
  const commandReceipts = yield* Effect.serviceOption(OrchestrationCommandReceiptRepository);
  const turnRepository = yield* Effect.serviceOption(ProjectionTurnRepository);
  const resolveStageDispatch = yield* makeWorkflowStageDispatchResolver;
  const withWorkflowGate = makeOperationGate<PlanningWorkflowId>();
  const withWorkflowRetryGate = makeOperationGate<PlanningWorkflowId>();
  const compactionService = yield* Effect.serviceOption(CompactionService);
  const activeRevisionCompactions = new Set<CommandId>();

  const getWorkflowProviders =
    providerRegistry._tag === "Some" ? providerRegistry.value.getProviders : Effect.succeed([]);
  const orchestrationEngine = withWorkflowModelSelectionGuard(
    baseOrchestrationEngine,
    getWorkflowProviders,
  );

  const writeWorkflow = (workflow: PlanningWorkflow) =>
    upsertPlanningWorkflowRecord(orchestrationEngine, workflow, workflow.updatedAt);

  const upsertWorkflow = (workflow: PlanningWorkflow) =>
    withWorkflowGate(
      workflow.id,
      Effect.gen(function* () {
        const current = yield* readWorkflow(orchestrationEngine, workflow.id);
        if (!current) return yield* writeWorkflow(workflow);
        const applying = current.implementation && isApplyReviewsLifecycle(current);
        // Stale writers must not reopen a finished revision or replace its pin.
        // A writer that has observed the finished revision may update it.
        const preserveImplementation =
          applying &&
          (current.implementation?.status !== "completed" ||
            workflow.implementation?.status !== "completed" ||
            workflow.implementation.revisionTurnId !== current.implementation.revisionTurnId);
        return yield* writeWorkflow({
          ...workflow,
          ...(preserveImplementation ? { implementation: current.implementation } : {}),
          ...(applying
            ? { archivedAt: current.archivedAt, archiveRestorations: current.archiveRestorations }
            : {}),
          totalCostUsd: Math.max(workflow.totalCostUsd, current.totalCostUsd),
          updatedAt:
            current.updatedAt > workflow.updatedAt ? current.updatedAt : workflow.updatedAt,
        });
      }),
    );

  /**
   * Fail one branch's revision visibly (error with Retry), unless the branch moved
   * on since `input.workflow` was read. The sibling branch is left alone.
   */
  const rejectRevision = (
    input: Pick<Parameters<typeof prepareRevisionTurn>[0], "workflow" | "branch" | "createdAt">,
    error: string,
  ) => {
    const expected = requirePlanningBranch(input.workflow, input.branch.branchId);
    return withWorkflowGate(
      input.workflow.id,
      Effect.gen(function* () {
        const current = yield* readWorkflow(orchestrationEngine, input.workflow.id);
        if (!current) return input.workflow;
        const branch = requirePlanningBranch(current, input.branch.branchId);
        if (
          isArchivedWorkflow(current) ||
          branch.status !== expected.status ||
          branch.updatedAt !== expected.updatedAt ||
          branch.planTurnId !== expected.planTurnId
        ) {
          return current;
        }
        const failed = markBranchError(current, input.branch.branchId, {
          error,
          stage: "revision",
          updatedAt: input.createdAt,
        });
        const next = {
          ...failed,
          updatedAt: current.updatedAt > failed.updatedAt ? current.updatedAt : failed.updatedAt,
        };
        yield* writeWorkflow(next);
        return next;
      }),
    );
  };

  const dispatchRevisionTurn = (
    input: Parameters<typeof prepareRevisionTurn>[0],
    priorFailure?: string,
  ) =>
    Effect.gen(function* () {
      // Size and send the prompt for the model dispatch will actually use: the
      // model-selection guard swaps an unavailable saved model at dispatch.
      const authorSlot = resolveAvailableWorkflowModelSlot(
        input.branch.authorSlot,
        yield* getWorkflowProviders,
      );
      const prepared = prepareRevisionTurn({ ...input, branch: { ...input.branch, authorSlot } });
      if ("rejection" in prepared) {
        const workflow = yield* rejectRevision(
          input,
          priorFailure ? `${priorFailure} ${prepared.rejection}` : prepared.rejection,
        );
        return { workflow, started: false };
      }
      // The slot was resolved against this catalog read and the prompt sized for it.
      // Dispatching through the guard would read the catalog again and could swap in
      // a smaller model than the one that passed the fit check.
      yield* baseOrchestrationEngine.dispatch(prepared.command);
      return { workflow: input.workflow, started: true };
    });

  const recordWorkflowTurnCost = (
    workflow: PlanningWorkflow,
    turnCostUsd: number | undefined,
    occurredAt: string,
  ) =>
    turnCostUsd === undefined || !Number.isFinite(turnCostUsd) || turnCostUsd <= 0
      ? Effect.succeed(workflow)
      : withWorkflowGate(
          workflow.id,
          Effect.gen(function* () {
            const current = yield* readWorkflow(orchestrationEngine, workflow.id);
            if (!current || isDeletedWorkflow(current)) return workflow;
            const costed = applyWorkflowTurnCost(
              current,
              turnCostUsd,
              current.updatedAt > occurredAt ? current.updatedAt : occurredAt,
            );
            yield* writeWorkflow(costed);
            return costed;
          }),
        );

  const deliveryForStage = (threadId: ThreadId, intentPersistedAt: string) =>
    providerTurnDeliveryWorker._tag === "Some"
      ? providerTurnDeliveryWorker.value
          .recheck(threadId)
          .pipe(
            Effect.map((delivery) =>
              delivery && delivery.createdAt >= intentPersistedAt ? delivery : null,
            ),
          )
      : Effect.succeed(null);

  const ensureDeliveryCanResume = (
    delivery: { readonly state: string; readonly errorDetail: string | null } | null,
    stage: string,
  ) => {
    if (delivery?.state === "rejected" || delivery?.state === "ambiguous") {
      return new Error(
        `${stage} delivery is '${delivery.state}' and cannot be sent again automatically: ${delivery.errorDetail ?? "delivery outcome requires manual review"}`,
      );
    }
    return null;
  };

  const hasDeliveryInFlight = (threadId: ThreadId) =>
    providerTurnDeliveryRepository._tag === "Some"
      ? providerTurnDeliveryRepository.value.getLatestByThread(threadId).pipe(
          Effect.map((delivery) => delivery?.state === "pending" || delivery?.state === "sending"),
          // An unreadable delivery state is not proof that nothing is in
          // flight. Keep waiting; the settle timeout bounds a lasting failure.
          Effect.catchCause((cause) =>
            Effect.logWarning("auto-retry could not read the thread's delivery state", {
              threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(true)),
          ),
        )
      : Effect.succeed(false);

  const isThreadSettledForAutoRetry = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const snapshot = yield* orchestrationEngine.getReadModel();
      const thread = snapshot.threads.find((entry) => entry.id === threadId);
      return isSessionSettledForAutoRetry(thread) && !(yield* hasDeliveryInFlight(threadId));
    });

  /**
   * Sleeps for the retry backoff, then keeps waiting until the thread's session
   * has looked settled on two consecutive observations. Fails when the session
   * never settles, so the caller records an error instead of a blind send.
   */
  const awaitAutoRetrySettled = (threadId: ThreadId) =>
    Effect.gen(function* () {
      yield* Effect.sleep(Duration.millis(AUTO_RETRY_BACKOFF_MS - AUTO_RETRY_SETTLE_INTERVAL_MS));
      // Wall-clock deadline, so slow state reads cannot stretch the bound.
      const deadline = (yield* Clock.currentTimeMillis) + AUTO_RETRY_SETTLE_TIMEOUT_MS;
      let previousSettled = yield* isThreadSettledForAutoRetry(threadId);
      while (true) {
        yield* Effect.sleep(Duration.millis(AUTO_RETRY_SETTLE_INTERVAL_MS));
        const settled = yield* isThreadSettledForAutoRetry(threadId);
        if (settled && previousSettled) return;
        previousSettled = settled;
        if ((yield* Clock.currentTimeMillis) >= deadline) {
          return yield* Effect.fail(
            new Error("The provider session did not become ready for an automatic retry."),
          );
        }
      }
    });

  const forkAutoRetry = (input: {
    readonly kind: "authoring" | "implementation" | "code_review" | "document_reader";
    readonly workflowId: PlanningWorkflowId;
    readonly threadId: ThreadId;
    readonly buildDispatch: (input: {
      readonly workflow: PlanningWorkflow;
      readonly snapshot: OrchestrationReadModel;
    }) => Effect.Effect<unknown, OrchestrationDispatchError | Error> | null;
    /** Records a visible error when the retry cannot be dispatched. */
    readonly markFailed?: (input: {
      readonly workflow: PlanningWorkflow;
      readonly detail: string;
      readonly failedAt: string;
    }) => PlanningWorkflow | null;
  }) =>
    Effect.gen(function* () {
      yield* awaitAutoRetrySettled(input.threadId);
      const snapshot = yield* orchestrationEngine.getReadModel();
      const workflow =
        snapshot.planningWorkflows.find(
          (entry) =>
            entry.id === input.workflowId &&
            !isDeletedWorkflow(entry) &&
            !isArchivedWorkflow(entry),
        ) ?? null;
      if (!workflow) {
        return;
      }

      const dispatch = input.buildDispatch({ workflow, snapshot });
      if (!dispatch) {
        return;
      }

      yield* dispatch;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logError("WorkflowService.autoRetryDispatch failed", {
            kind: input.kind,
            workflowId: input.workflowId,
            threadId: input.threadId,
            cause,
          });
          if (!input.markFailed || Cause.hasInterruptsOnly(cause)) return;
          const snapshot = yield* orchestrationEngine.getReadModel();
          const workflow =
            snapshot.planningWorkflows.find(
              (entry) =>
                entry.id === input.workflowId &&
                !isDeletedWorkflow(entry) &&
                !isArchivedWorkflow(entry),
            ) ?? null;
          if (!workflow) return;
          const squashed = Cause.squash(cause);
          const failed = input.markFailed({
            workflow,
            detail: squashed instanceof Error ? squashed.message : Cause.pretty(cause),
            failedAt: new Date().toISOString(),
          });
          if (failed) yield* upsertWorkflow(failed);
        }).pipe(
          Effect.catchCause((markCause) =>
            Effect.logError("WorkflowService.autoRetryDispatch failure could not be recorded", {
              kind: input.kind,
              workflowId: input.workflowId,
              threadId: input.threadId,
              cause: markCause,
            }),
          ),
        ),
      ),
      Scope.provide(sources.scope),
      Effect.forkIn(sources.scope),
    );

  const forkPlanningReviewAutoRetry = (input: {
    readonly workflowId: PlanningWorkflowId;
    readonly branchId: WorkflowBranchId;
    readonly threadId: ThreadId;
    readonly expectedRetryCount: number;
    readonly originalError: string;
  }) =>
    Effect.gen(function* () {
      yield* awaitAutoRetrySettled(input.threadId);
      const snapshot = yield* orchestrationEngine.getReadModel();
      const workflow =
        snapshot.planningWorkflows.find(
          (entry) =>
            entry.id === input.workflowId &&
            !isDeletedWorkflow(entry) &&
            !isArchivedWorkflow(entry),
        ) ?? null;
      if (!workflow) {
        return;
      }

      const branch = requirePlanningBranch(workflow, input.branchId);
      const review = branch.reviews.find((entry) => entry.threadId === input.threadId);
      if (
        branch.status !== "reviews_requested" ||
        review?.status !== "running" ||
        review.retryCount !== input.expectedRetryCount
      ) {
        return;
      }

      const retryThread = snapshot.threads.find((thread) => thread.id === input.threadId);
      if (hasRunningSessionTurn(retryThread)) {
        return;
      }
      if (!retryThread) {
        return yield* Effect.fail(new Error("Review thread not found for automatic retry."));
      }
      const planMarkdown = completedProposedPlanForTurn(
        snapshot,
        branch.authorThreadId,
        branch.planTurnId,
        branch.updatedAt,
        planReplacementFilter(workflow, branch.branchId),
      )?.planMarkdown;
      if (!planMarkdown) {
        return yield* Effect.fail(new Error("Saved plan not found for automatic review retry."));
      }
      const reviewerSlot = planReviewerSlot(workflow, input.branchId, review);
      yield* startReviewTurn({
        orchestrationEngine,
        workflow,
        reviewerSlot,
        reviewThreadId: review.threadId,
        planMarkdown,
        planTurnId: branch.planTurnId,
        reviewKind: review.slot,
        reviewedBranchId: input.branchId,
        createdAt: new Date().toISOString(),
        retry: { kind: "retry", reusedThread: true, priorFailure: input.originalError },
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logError("WorkflowService.autoRetryDispatch failed", {
            kind: "planning_review",
            workflowId: input.workflowId,
            threadId: input.threadId,
            cause,
          });
          const snapshot = yield* orchestrationEngine.getReadModel();
          const workflow =
            snapshot.planningWorkflows.find(
              (entry) =>
                entry.id === input.workflowId &&
                !isDeletedWorkflow(entry) &&
                !isArchivedWorkflow(entry),
            ) ?? null;
          if (!workflow) {
            return;
          }
          const branch = requirePlanningBranch(workflow, input.branchId);
          const review = branch.reviews.find((entry) => entry.threadId === input.threadId);
          if (
            branch.status !== "reviews_requested" ||
            review?.status !== "running" ||
            review.retryCount !== input.expectedRetryCount
          ) {
            return;
          }
          const failedAt = new Date().toISOString();
          yield* upsertWorkflow(
            markPlanningReviewError(
              workflow,
              input.branchId,
              input.threadId,
              `${input.originalError} | Automatic retry failed: ${Cause.pretty(cause)}`,
              failedAt,
            ),
          );
          // The failed retry frees its slot; nothing else would admit the next queued review.
          const launchSnapshot = yield* orchestrationEngine.getReadModel();
          const launchWorkflow =
            launchSnapshot.planningWorkflows.find((entry) => entry.id === input.workflowId) ?? null;
          if (launchWorkflow && !isArchivedWorkflow(launchWorkflow)) {
            yield* maybeStartReviews(launchWorkflow, launchSnapshot, failedAt);
          }
        }),
      ),
      Scope.provide(sources.scope),
      Effect.forkIn(sources.scope),
    );

  const titleGenerationWorker = yield* makeBackgroundWorker(
    (item: WorkflowTitleGenerationWorkItem) =>
      Effect.gen(function* () {
        const snapshot = yield* orchestrationEngine.getReadModel();
        const workflow =
          snapshot.planningWorkflows.find(
            (entry) => entry.id === item.workflowId && !isDeletedWorkflow(entry),
          ) ?? null;
        if (!workflow || workflow.title !== item.expectedCurrentTitle) {
          return;
        }

        const cwd =
          snapshot.projects.find(
            (project) => project.id === workflow.projectId && project.deletedAt === null,
          )?.workspaceRoot ?? null;
        const title = yield* resolveBestEffortGeneratedTitle({
          cwd,
          titleSourceText: item.titleSourceText,
          attachments: [],
          titleGenerationModel: item.titleGenerationModel,
          defaultTitle: item.defaultTitle,
          textGeneration,
          logPrefix: "workflow service",
          logContext: {
            workflowId: item.workflowId,
          },
        });
        if (title === workflow.title) {
          return;
        }

        const latestSnapshot = yield* orchestrationEngine.getReadModel();
        const latestWorkflow =
          latestSnapshot.planningWorkflows.find(
            (entry) => entry.id === item.workflowId && !isDeletedWorkflow(entry),
          ) ?? null;
        if (!latestWorkflow || latestWorkflow.title !== item.expectedCurrentTitle) {
          return;
        }

        const updatedAt = new Date().toISOString();
        yield* upsertWorkflow({
          ...latestWorkflow,
          title,
          updatedAt,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("WorkflowService.titleGenerationWorker failed", {
            workflowId: item.workflowId,
            cause,
          }),
        ),
      ),
    { name: "WorkflowService", key: (item) => String(item.workflowId) },
  );

  const reviewFeedbackForBranch = (
    workflow: PlanningWorkflow,
    branch: WorkflowBranch,
    snapshot: {
      readonly threads: ReadonlyArray<{
        readonly id: ThreadId;
        readonly proposedPlans?: ReadonlyArray<{
          readonly turnId: string | null;
          readonly planMarkdown: string;
        }>;
        readonly latestTurn: { readonly assistantMessageId: string | null } | null;
        readonly messages: ReadonlyArray<{
          readonly id: string;
          readonly role: string;
          readonly text: string;
          readonly reasoningText?: string | undefined;
          readonly streaming: boolean;
          readonly createdAt: string;
        }>;
      }>;
    },
  ) =>
    Effect.forEach(
      // Cross reviews by reviewer id, then the self review.
      branch.reviews.toSorted(
        (left, right) =>
          compareWorkflowReviewSlots(left.slot, right.slot) ||
          workflowParticipantIndex(planReviewReviewerBranchId(workflow, branch.branchId, left)) -
            workflowParticipantIndex(planReviewReviewerBranchId(workflow, branch.branchId, right)),
      ),
      (review) =>
        Effect.gen(function* () {
          const workflowId = workflow.id;
          const thread = snapshot.threads.find((entry) => entry.id === review.threadId);
          const reviewerLabel = planReviewLabel(workflow, branch.branchId, review);
          const pinnedMessageMissing =
            review.pinnedAssistantMessageId != null &&
            !thread?.messages.some((message) => message.id === review.pinnedAssistantMessageId);
          const feedback =
            thread &&
            (!pinnedMessageMissing ||
              thread.proposedPlans?.some((plan) => plan.turnId === review.pinnedTurnId))
              ? reviewFeedbackForPinnedTurn(
                  thread,
                  review.pinnedTurnId ?? null,
                  review.pinnedAssistantMessageId ?? null,
                )
              : null;
          if (!feedback) {
            yield* Effect.logWarning("review yielded empty feedback text", {
              threadId: review.threadId,
              reviewerLabel,
              reviewStatus: review.status,
            });
            return null;
          }
          if (feedback.source !== "text-only") {
            yield* Effect.logDebug("reviewer feedback included reasoning-channel content", {
              threadId: review.threadId,
              reviewerLabel,
              source: feedback.source,
            });
          }
          return {
            reviewerLabel,
            reviewMarkdown: feedback.text,
            source: {
              workflowId,
              stage: reviewerLabel,
              ...(review.pinnedTurnId ? { turnId: review.pinnedTurnId } : {}),
              ...(review.pinnedAssistantMessageId
                ? { messageId: review.pinnedAssistantMessageId }
                : {}),
            },
          };
        }),
    ).pipe(
      Effect.map((reviews) =>
        reviews.filter((review): review is NonNullable<typeof review> => review !== null),
      ),
    );

  const maybeSynthesizeProposedPlan = (input: {
    readonly workflow: PlanningWorkflow;
    readonly provider: WorkflowModelSlot["provider"];
    readonly thread: Pick<
      OrchestrationReadModel["threads"][number],
      | "id"
      | "projectId"
      | "worktreePath"
      | "latestTurn"
      | "messages"
      | "session"
      | "proposedPlans"
      | "activities"
    >;
    readonly turnId: TurnId;
    readonly createdAt: string;
    readonly validate?: (markdown: string) => DocumentValidationResult;
    /**
     * An author's capture on a run with a per-plan budget: a reply over it is not saved as a
     * plan. `onOverBudget` receives the reason, for the caller's repair.
     */
    readonly budget?: {
      readonly branchId: WorkflowBranchId;
      readonly onOverBudget?: (error: string) => void;
    };
  }) =>
    Effect.gen(function* () {
      const exceedsBudget = (markdown: string) => {
        const maxPlanChars = input.budget ? workflowPlanCharBudget(input.workflow) : null;
        if (maxPlanChars === null || !input.budget) return false;
        const renderedChars = workflowPlanMergeChars(
          input.workflow,
          input.budget.branchId,
          markdown,
          input.turnId,
        );
        if (renderedChars <= maxPlanChars) return false;
        input.budget.onOverBudget?.(
          planOverBudgetMessage(input.workflow, renderedChars, maxPlanChars),
        );
        return true;
      };
      const behavior = resolveWorkflowBehavior({
        runKind: "planning",
        templateId: input.workflow.templateId,
        templateVersion: input.workflow.templateVersion,
      });
      const existingCapture = validateCapturedPlanForTurn({
        workflow: input.workflow,
        provider: input.provider,
        thread: input.thread,
        turnId: input.turnId,
      });
      if (existingCapture.valid) {
        return false;
      }

      const latestCompletedTurn = getFinishedConsumableLatestTurn(input.thread);
      const assistantText =
        latestCompletedTurn?.turnId === input.turnId ? latestCompletedTurn.assistantText : null;
      if (behavior.strictPlanCapture) {
        const capture = behavior.planCaptureForProvider(input.provider);
        if (capture !== "line-wrapper") {
          yield* Effect.logWarning("workflow strict proposed-plan capture was missing", {
            workflowId: input.workflow.id,
            threadId: input.thread.id,
            turnId: input.turnId,
            provider: input.provider,
            validationError: existingCapture.error,
          });
          return false;
        }
        // Reasoning is useful review feedback, but it is not a submitted plan.
        const finalMessage = input.thread.messages.find(
          (message) =>
            message.id === latestCompletedTurn?.assistantMessageId &&
            message.turnId === input.turnId &&
            message.role === "assistant" &&
            !message.streaming,
        );
        const validation = validateProposedPlanOutput(finalMessage?.text);
        if (!validation.valid) {
          yield* Effect.logWarning("workflow proposed-plan wrapper validation failed", {
            workflowId: input.workflow.id,
            threadId: input.thread.id,
            turnId: input.turnId,
            provider: input.provider,
            validationError: validation.error,
          });
          return false;
        }
        if (hasProposedPlanForTurn(input.thread, input.turnId)) {
          return false;
        }
        if (exceedsBudget(validation.markdown)) return false;
        yield* orchestrationEngine.dispatch({
          type: "thread.proposed-plan.upsert",
          commandId: CommandId.makeUnsafe(timeOrderedUuid()),
          threadId: input.thread.id,
          proposedPlan: {
            id: OrchestrationProposedPlanId.makeUnsafe(crypto.randomUUID()),
            turnId: input.turnId,
            planMarkdown: validation.markdown,
            implementedAt: null,
            implementationThreadId: null,
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
          },
          createdAt: input.createdAt,
        });
        return true;
      }

      if (hasProposedPlanForTurn(input.thread, input.turnId)) {
        return false;
      }
      const extractedPlanMarkdown = extractProposedPlanMarkdown(assistantText);
      const strippedAssistantText = assistantText
        ? stripProposedPlanBlockTags(assistantText)
        : null;
      let planMarkdown = extractedPlanMarkdown ?? strippedAssistantText;
      if (!planMarkdown) return false;
      const documentType = planningWorkflowDocumentType(input.workflow);
      if (documentType) {
        const validation =
          input.validate?.(planMarkdown) ??
          validateDocumentArtifact(planMarkdown, documentType, "capture");
        if (!validation.valid) return false;
        planMarkdown = validation.markdown;
      }
      if (exceedsBudget(planMarkdown)) return false;

      yield* orchestrationEngine.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: CommandId.makeUnsafe(timeOrderedUuid()),
        threadId: input.thread.id,
        proposedPlan: {
          id: OrchestrationProposedPlanId.makeUnsafe(crypto.randomUUID()),
          turnId: input.turnId,
          planMarkdown,
          implementedAt: null,
          implementationThreadId: null,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
      return true;
    });

  const retryOrFailInvalidPlanCapture = (input: {
    readonly workflow: PlanningWorkflow;
    readonly snapshot: OrchestrationReadModel;
    readonly thread: OrchestrationReadModel["threads"][number];
    readonly turnId: TurnId;
    readonly branchId?: WorkflowBranchId;
    readonly createdAt: string;
    /** Why the turn was rejected, when the caller already knows (no record to validate). */
    readonly validationError?: string;
  }) =>
    Effect.gen(function* () {
      let workflow = input.workflow;
      const behavior = resolveWorkflowBehavior({
        runKind: "planning",
        templateId: workflow.templateId,
        templateVersion: workflow.templateVersion,
      });
      if (!behavior.strictPlanCapture && !isDocumentWorkflow(workflow)) return;

      let branch = input.branchId ? requirePlanningBranch(workflow, input.branchId) : null;
      // Format repair may create a new turn only for a currently running stage.
      if (
        branch
          ? branch.status !== "authoring" && branch.status !== "revising"
          : workflow.merge.status !== "in_progress"
      )
        return;
      // A turn this stage already rejected has its repair outstanding. A later
      // evaluation of it (a session update while the repair turn starts, with
      // the same logical timestamp) must neither repair nor fail it again.
      if (
        input.turnId ===
        (branch ? branch.rejectedDocumentTurnId : workflow.merge.rejectedDocumentTurnId)
      )
        return;
      const provider = branch?.authorSlot.provider ?? workflow.merge.mergeSlot.provider;
      const validation =
        input.validationError !== undefined
          ? { valid: false as const, error: input.validationError }
          : validateCapturedPlanForTurn({
              workflow: workflow,
              provider,
              thread: input.thread,
              turnId: input.turnId,
              ...(branch
                ? { maxPlanChars: workflowPlanCharBudget(workflow), branchId: branch.branchId }
                : {}),
            });
      if (validation.valid) return;
      // Every workflow kind records the rejected turn, so the stage evaluates it once. Planning
      // workflows record it only once the repair turn was dispatched: until then a repeated
      // evaluation must still be able to fail the stage visibly (dispatch failure, restart),
      // instead of skipping the turn with no repair running. Events are handled one at a
      // time, so the record lands before any event the dispatch itself causes.
      const deferRejection = !isDocumentWorkflow(workflow);
      const beforeRejection = { workflow, branch };
      // A repair turn that cannot be dispatched fails its stage visibly (with Retry) instead
      // of leaving it running with no turn. Returns whether the turn was dispatched.
      const dispatchRepair = <A, E, R>(
        start: Effect.Effect<A, E, R>,
        failed: (message: string) => PlanningWorkflow,
      ) =>
        start.pipe(
          Effect.map(Option.some),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("workflow format repair turn could not be dispatched", {
                  workflowId: workflow.id,
                  cause: Cause.pretty(cause),
                }).pipe(
                  Effect.andThen(
                    upsertWorkflow(failed("The format repair turn could not be started.")),
                  ),
                  Effect.as(Option.none()),
                ),
          ),
        );
      if (branch && input.branchId) {
        branch = { ...branch, rejectedDocumentTurnId: input.turnId };
        const rejectedBranch = branch;
        workflow = updatePlanningBranch(workflow, input.branchId, () => rejectedBranch);
      } else {
        workflow = {
          ...workflow,
          merge: { ...workflow.merge, rejectedDocumentTurnId: input.turnId },
        };
      }

      const error = `${isDocumentWorkflow(workflow) ? "Invalid document" : "Invalid proposed-plan capture"}: ${validation.error}`;
      const branchStage = branch?.status === "revising" ? "revision" : "authoring";
      const budgetError = workflowBudgetError(workflow);
      if (
        budgetError &&
        (branch
          ? branchStage === "revision"
            ? (branch.revisionFormatRepairAttempts ?? 0)
            : (branch.authorFormatRepairAttempts ?? 0)
          : (workflow.merge.formatRepairAttempts ?? 0)) < 1
      ) {
        yield* upsertWorkflow(
          branch && input.branchId
            ? markBranchError(workflow, input.branchId, {
                error: budgetError.message,
                stage: branchStage,
                updatedAt: input.createdAt,
              })
            : markMergeError(workflow, budgetError.message, input.createdAt),
        );
        return;
      }
      if (branch && input.branchId) {
        const stage = branchStage;
        const formatRepairAttempts =
          stage === "revision"
            ? (branch.revisionFormatRepairAttempts ?? 0)
            : (branch.authorFormatRepairAttempts ?? 0);
        if (formatRepairAttempts >= 1) {
          yield* upsertWorkflow(
            markBranchError(workflow, input.branchId, {
              error,
              stage,
              updatedAt: input.createdAt,
            }),
          );
          return;
        }

        const retryBase = deferRejection ? beforeRejection : { workflow, branch };
        const repairedBranch: WorkflowBranch = {
          ...retryBase.branch!,
          ...(stage === "revision"
            ? { revisionFormatRepairAttempts: formatRepairAttempts + 1 }
            : { authorFormatRepairAttempts: formatRepairAttempts + 1 }),
          updatedAt: input.createdAt,
        };
        const retryWorkflow: PlanningWorkflow = {
          ...updatePlanningBranch(retryBase.workflow, input.branchId, () => repairedBranch),
          updatedAt: input.createdAt,
        };
        const retryBranch = requirePlanningBranch(retryWorkflow, input.branchId);
        yield* upsertWorkflow(retryWorkflow);
        const retry: WorkflowRetryContext = {
          kind: "retry",
          formatRepair: true,
          reusedThread: true,
          priorFailure: error,
        };
        const branchId = input.branchId;
        const failBranch = (message: string) =>
          markBranchError(retryWorkflow, branchId, {
            error: `${error} ${message}`,
            stage,
            updatedAt: input.createdAt,
          });
        if (stage === "authoring") {
          const started = yield* dispatchRepair(
            startAuthoringTurn({
              orchestrationEngine,
              workflow: retryWorkflow,
              branch: retryBranch,
              createdAt: input.createdAt,
              retry,
            }),
            failBranch,
          );
          if (Option.isSome(started) && deferRejection)
            yield* recordRejectedPlanTurn(workflow.id, branchId, input.turnId);
          return;
        }

        const originalPlan = completedProposedPlanForTurn(
          input.snapshot,
          branch.authorThreadId,
          branch.planTurnId,
          branch.updatedAt,
          planReplacementFilter(workflow, branch.branchId),
        )?.planMarkdown;
        const reviews = yield* reviewFeedbackForBranch(workflow, branch, input.snapshot);
        if (!originalPlan || reviews.length === 0) {
          yield* upsertWorkflow(
            markBranchError(retryWorkflow, input.branchId, {
              error: `${error} Revision inputs could not be reconstructed.`,
              stage,
              updatedAt: input.createdAt,
            }),
          );
          return;
        }
        const started = yield* dispatchRepair(
          dispatchRevisionTurn(
            {
              workflow: retryWorkflow,
              branch: retryBranch,
              originalPlanMarkdown: originalPlan,
              reviews,
              thread: input.thread,
              createdAt: input.createdAt,
              retry,
            },
            error,
          ),
          failBranch,
        );
        if (Option.isSome(started) && started.value.started && deferRejection)
          yield* recordRejectedPlanTurn(workflow.id, branchId, input.turnId);
        return;
      }

      if ((workflow.merge.formatRepairAttempts ?? 0) >= 1 || !workflow.merge.threadId) {
        yield* upsertWorkflow(markMergeError(workflow, error, input.createdAt));
        return;
      }
      const mergePlans = collectMergeInputs(workflow, input.snapshot);
      if (!mergePlans) {
        yield* upsertWorkflow(
          markMergeError(
            workflow,
            `${error} Merge inputs could not be reconstructed.`,
            input.createdAt,
          ),
        );
        return;
      }
      const mergeBase = deferRejection ? beforeRejection.workflow : workflow;
      const retryWorkflow: PlanningWorkflow = {
        ...mergeBase,
        merge: {
          ...mergeBase.merge,
          status: "in_progress",
          error: null,
          formatRepairAttempts: (mergeBase.merge.formatRepairAttempts ?? 0) + 1,
          updatedAt: input.createdAt,
        },
        updatedAt: input.createdAt,
      };
      yield* upsertWorkflow(retryWorkflow);
      const started = yield* dispatchRepair(
        startMergeTurn({
          orchestrationEngine,
          workflow: retryWorkflow,
          threadId: workflow.merge.threadId,
          plans: mergePlans,
          createdAt: input.createdAt,
          retry: { kind: "retry", formatRepair: true, reusedThread: true, priorFailure: error },
        }),
        (message) => markMergeError(retryWorkflow, `${error} ${message}`, input.createdAt),
      );
      if (Option.isSome(started) && deferRejection)
        yield* recordRejectedPlanTurn(workflow.id, undefined, input.turnId);
    });

  /**
   * Records a planning stage's rejected turn once its repair turn was dispatched, on the
   * workflow as it is now: dispatching may itself have updated it.
   */
  const recordRejectedPlanTurn = (
    workflowId: PlanningWorkflow["id"],
    branchId: WorkflowBranchId | undefined,
    turnId: TurnId,
  ) =>
    Effect.gen(function* () {
      const current = (yield* orchestrationEngine.getReadModel()).planningWorkflows.find(
        (entry) => entry.id === workflowId,
      );
      if (!current) return;
      if (branchId) {
        const branch = requirePlanningBranch(current, branchId);
        if (
          (branch.status !== "authoring" && branch.status !== "revising") ||
          branch.rejectedDocumentTurnId === turnId
        )
          return;
        yield* upsertWorkflow(
          updatePlanningBranch(current, branchId, (entry) => ({
            ...entry,
            rejectedDocumentTurnId: turnId,
          })),
        );
        return;
      }
      if (current.merge.status !== "in_progress" || current.merge.rejectedDocumentTurnId === turnId)
        return;
      yield* upsertWorkflow({
        ...current,
        merge: { ...current.merge, rejectedDocumentTurnId: turnId },
      });
    });

  /**
   * The author's accepted plan: the pinned one, or a newer finished turn's plan that replaces it.
   * A replacement that `acceptsReplacement` refuses (one over the per-plan budget) is never
   * selected, so the accepted pin stays usable when an over-long replacement is rejected.
   */
  const resolvePinnedAuthorPlan = (
    snapshot: OrchestrationReadModel,
    threadId: ThreadId,
    pinnedTurnId: string | null,
    replacementNotBefore?: string,
    acceptsReplacement?: (plan: ReplacementPlanCandidate) => boolean,
  ):
    | { readonly status: "missing" | "waiting" }
    | {
        readonly status: "ready";
        readonly plan: OrchestrationReadModel["threads"][number]["proposedPlans"][number];
      } => {
    if (!pinnedTurnId) {
      return { status: "missing" };
    }
    const withinReplacementBudget = (plan: ReplacementPlanCandidate) =>
      acceptsReplacement?.(plan) ?? true;

    const thread = snapshot.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      return { status: "missing" };
    }
    const latestTurn = thread.latestTurn;
    const pinnedPlan = thread.proposedPlans.find((candidate) => candidate.turnId === pinnedTurnId);
    if (!pinnedPlan) {
      if (!latestTurn) {
        return { status: "missing" };
      }
      const latestTurnStillSettling =
        (thread.session?.status === "running" && thread.session.activeTurnId !== null) ||
        latestTurn.state === "running" ||
        latestTurn.completedAt === null ||
        latestTurn.processingQuiescedAt === null;
      if (latestTurnStillSettling) {
        return { status: "waiting" };
      }
      const replacementPlan = thread.proposedPlans.find(
        (candidate) => candidate.turnId === latestTurn.turnId,
      );
      if (
        latestTurn.state === "completed" &&
        replacementPlan &&
        withinReplacementBudget(replacementPlan) &&
        (replacementNotBefore === undefined || latestTurn.requestedAt > replacementNotBefore)
      ) {
        return { status: "ready", plan: replacementPlan };
      }
      return { status: "missing" };
    }

    if (thread.latestTurn?.turnId === pinnedTurnId) {
      if (thread.latestTurn.state !== "completed") {
        return { status: "waiting" };
      }
      if (thread.session?.status === "running" && thread.session.activeTurnId === pinnedTurnId) {
        return { status: "waiting" };
      }
      return { status: "ready", plan: pinnedPlan };
    }

    if (
      !latestTurn ||
      latestTurn.requestedAt <= pinnedPlan.updatedAt ||
      (replacementNotBefore !== undefined && latestTurn.requestedAt < replacementNotBefore)
    ) {
      return { status: "ready", plan: pinnedPlan };
    }

    const newerTurnStillSettling =
      (thread.session?.status === "running" && thread.session.activeTurnId !== null) ||
      latestTurn.state === "running" ||
      latestTurn.completedAt === null ||
      latestTurn.processingQuiescedAt === null;
    if (newerTurnStillSettling) {
      return { status: "waiting" };
    }

    const replacementPlan = thread.proposedPlans.find(
      (candidate) => candidate.turnId === latestTurn.turnId,
    );
    if (
      latestTurn.state === "completed" &&
      replacementPlan &&
      withinReplacementBudget(replacementPlan)
    ) {
      return { status: "ready", plan: replacementPlan };
    }

    return { status: "ready", plan: pinnedPlan };
  };

  const completedProposedPlanForTurn = (
    snapshot: OrchestrationReadModel,
    threadId: ThreadId,
    expectedTurnId: string | null,
    replacementNotBefore?: string,
    acceptsReplacement?: (plan: ReplacementPlanCandidate) => boolean,
  ): { readonly planMarkdown: string } | null => {
    const resolution = resolvePinnedAuthorPlan(
      snapshot,
      threadId,
      expectedTurnId,
      replacementNotBefore,
      acceptsReplacement,
    );
    return resolution.status === "ready" && resolution.plan.turnId === expectedTurnId
      ? resolution.plan
      : null;
  };

  /** Every branch's pinned revised plan in author order, or `null` while any is missing. */
  const collectMergeInputs = (
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
  ): string[] | null => {
    const plans: string[] = [];
    for (const branch of planningBranches(workflow)) {
      const plan = completedProposedPlanForTurn(
        snapshot,
        branch.authorThreadId,
        branch.revisionTurnId,
        branch.updatedAt,
        planReplacementFilter(workflow, branch.branchId),
      )?.planMarkdown;
      if (!plan) return null;
      plans.push(plan);
    }
    return plans;
  };

  /** Plan review threads whose turn this process dispatched; empty again after a restart. */
  const dispatchedPlanReviewThreads = new Set<ThreadId>();
  /**
   * Requeued plan reviews whose failed delivery is resent (same delivery, same duplicate-risk
   * choice) when the launcher admits them, rather than as a new turn.
   */
  const requeuedPlanReviewDeliveries = new Map<
    ThreadId,
    { readonly allowPossibleDuplicate: boolean }
  >();

  /**
   * The resend a requeued review still owes after a restart dropped its in-memory intent. When
   * the thread's latest delivery is rejected or ambiguous and older than the review's current
   * attempt, a retry requeued the review to resend it (or the resend was interrupted), so that
   * delivery is resent rather than a new turn started. A failed delivery from the current
   * attempt still fails the review for a manual retry. The duplicate-risk confirmation is not
   * carried over: an ambiguous delivery then fails visibly and asks for it again.
   */
  const persistedPlanReviewRedelivery = (threadId: ThreadId, attemptStartedAt: string) =>
    providerTurnDeliveryWorker._tag === "Some"
      ? providerTurnDeliveryWorker.value.recheck(threadId).pipe(
          Effect.map((delivery) =>
            (delivery?.state === "rejected" || delivery?.state === "ambiguous") &&
            delivery.createdAt < attemptStartedAt
              ? { allowPossibleDuplicate: false }
              : undefined,
          ),
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
      : Effect.succeed(undefined);

  /**
   * Whether a plan review holds one of the `WORKFLOW_MAX_ACTIVE_REVIEW_TURNS` slots. A running
   * review holds one once its turn or delivery exists, or this process dispatched it. A failed
   * review whose delivery is being resent stays visibly failed, but holds a slot while that
   * delivery or a turn on its thread is live.
   */
  const planReviewHoldsSlot = (
    review: WorkflowBranch["reviews"][number],
    snapshot: OrchestrationReadModel,
    idempotentStageSetup: boolean,
  ) =>
    Effect.gen(function* () {
      const thread = snapshot.threads.find((entry) => entry.id === review.threadId);
      if (review.status === "error") {
        return hasRunningSessionTurn(thread) || (yield* hasDeliveryInFlight(review.threadId));
      }
      if (review.status !== "running") return false;
      // A turn requested before the review was (re)queued is an earlier attempt's. A resent
      // delivery keeps its original row, so an unsettled one also marks the review in flight.
      const currentTurn =
        thread?.latestTurn != null && thread.latestTurn.requestedAt >= review.updatedAt;
      if (currentTurn || dispatchedPlanReviewThreads.has(review.threadId)) return true;
      const delivery = idempotentStageSetup
        ? yield* deliveryForStage(review.threadId, review.updatedAt)
        : null;
      return delivery !== null || (yield* hasDeliveryInFlight(review.threadId));
    });

  /**
   * Plan review launcher, one pass. When every plan is saved it first records every expected
   * review as `pending` in one write; each pass then admits pending reviews (and re-dispatches
   * running ones that never got a turn) in order, branch id, cross by reviewer id, then self,
   * until `WORKFLOW_MAX_ACTIVE_REVIEW_TURNS` are running. Each review launches on its own, so one
   * failure marks only that review. Results are applied by thread id onto a fresh read.
   */

  /**
   * One launcher pass at a time. The event fiber, manual retries and reconciliation all admit
   * reviews; each pass counts occupancy and reserves slots from a fresh read inside this gate, so
   * two overlapping passes can't both fill the same free slot.
   */
  const reviewLaunchGate = yield* Semaphore.make(1);

  /** Runs one launcher pass and returns the review threads it dispatched. */
  const maybeStartReviews = (
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
    updatedAt: string,
    retries?: ReadonlyMap<ThreadId, WorkflowRetryContext>,
  ) =>
    reviewLaunchGate.withPermits(1)(
      Effect.gen(function* () {
        const fresh = yield* orchestrationEngine.getReadModel();
        const current = fresh.planningWorkflows.find((entry) => entry.id === workflow.id);
        if (current && (isDeletedWorkflow(current) || isArchivedWorkflow(current))) {
          return new Set<ThreadId>();
        }
        return yield* maybeStartReviewsPass(current ?? workflow, fresh, updatedAt, retries);
      }),
    );

  const maybeStartReviewsPass = (
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
    updatedAt: string,
    retries?: ReadonlyMap<ThreadId, WorkflowRetryContext>,
  ) =>
    Effect.gen(function* () {
      const dispatched = new Set<ThreadId>();
      const branches = planningBranches(workflow);
      // Only running reviews need the mark; the rest of this run's entries are dropped here.
      for (const branch of branches) {
        for (const review of branch.reviews) {
          if (review.status !== "running") dispatchedPlanReviewThreads.delete(review.threadId);
          if (review.status !== "pending") requeuedPlanReviewDeliveries.delete(review.threadId);
        }
      }
      const startsFresh = branches.every(
        (branch) => branch.status === "plan_saved" && branch.reviews.length === 0,
      );
      const resumesPersistedIntent =
        branches.every(
          (branch) =>
            (branch.status === "reviews_requested" || branch.status === "reviews_saved") &&
            branch.reviews.length > 0,
        ) && branches.some((branch) => branch.status === "reviews_requested");
      if (!startsFresh && !resumesPersistedIntent) {
        return dispatched;
      }

      const plans = new Map<WorkflowBranchId, string>();
      for (const branch of branches) {
        const plan = completedProposedPlanForTurn(
          snapshot,
          branch.authorThreadId,
          branch.planTurnId,
          branch.updatedAt,
          planReplacementFilter(workflow, branch.branchId),
        )?.planMarkdown;
        if (!plan) return dispatched;
        plans.set(branch.branchId, plan);
      }

      const behavior = resolveWorkflowBehavior({
        runKind: "planning",
        templateId: workflow.templateId,
        templateVersion: workflow.templateVersion,
      });
      const mesh = workflowUsesMesh(branches.length);
      let intentWorkflow = workflow;
      if (startsFresh) {
        const budgetError = workflowBudgetError(workflow);
        if (budgetError) {
          yield* upsertWorkflow(markMergeError(workflow, budgetError.message, updatedAt));
          return dispatched;
        }
        const reviews = new Map<WorkflowBranchId, PlanReviewIntent[]>();
        for (const branch of branches) {
          reviews.set(
            branch.branchId,
            expectedPlanReviewEdges(workflow, branch.branchId).map((edge) => ({
              slot: edge.slot,
              ...(mesh ? { reviewerBranchId: edge.reviewerBranchId } : {}),
              threadId: planReviewThreadId(
                workflow,
                branch.branchId,
                edge,
                branch.planTurnId ?? "",
              ),
            })),
          );
        }
        intentWorkflow = markReviewsRequested(workflow, { reviews, updatedAt });
        yield* upsertWorkflow(intentWorkflow);
      }

      // Every review record of the run, in admission order.
      const records = planningBranches(intentWorkflow).flatMap((branch) =>
        branch.reviews
          .map((review) => ({
            branch,
            review,
            reviewerBranchId: planReviewReviewerBranchId(intentWorkflow, branch.branchId, review),
          }))
          .toSorted(
            (left, right) =>
              compareWorkflowReviewSlots(left.review.slot, right.review.slot) ||
              workflowParticipantIndex(left.reviewerBranchId) -
                workflowParticipantIndex(right.reviewerBranchId),
          ),
      );

      // Running reviews that never got a turn (a restart mid-launch) are re-dispatched; the
      // rest of the running ones are in flight and count against the cap. A review this
      // process dispatched is in flight even before its provider reports the turn.
      type ReviewRecord = (typeof records)[number];
      const resumes: ReviewRecord[] = [];
      let inFlight = 0;
      for (const record of records) {
        if (record.review.status !== "running" && record.review.status !== "error") continue;
        if (yield* planReviewHoldsSlot(record.review, snapshot, behavior.idempotentStageSetup))
          inFlight += 1;
        else if (record.review.status === "running") resumes.push(record);
      }
      const pending = records.filter((record) => record.review.status === "pending");

      const launch = (record: ReviewRecord) =>
        Effect.gen(function* () {
          const { branch, review, reviewerBranchId } = record;
          const budgetError = workflowBudgetError(intentWorkflow);
          if (budgetError) return yield* Effect.fail(budgetError);
          const redelivery =
            requeuedPlanReviewDeliveries.get(review.threadId) ??
            (yield* persistedPlanReviewRedelivery(review.threadId, review.updatedAt));
          if (redelivery && providerTurnDeliveryWorker._tag === "Some") {
            requeuedPlanReviewDeliveries.delete(review.threadId);
            yield* providerTurnDeliveryWorker.value.retry({
              threadId: review.threadId,
              allowPossibleDuplicate: redelivery.allowPossibleDuplicate,
            });
            return;
          }
          const reviewerSlot = requirePlanningBranch(intentWorkflow, reviewerBranchId).authorSlot;
          const reviewThread = snapshot.threads.find((thread) => thread.id === review.threadId);
          if (!reviewThread) {
            yield* createReviewThread({
              orchestrationEngine,
              workflow: intentWorkflow,
              reviewerSlot,
              reviewedBranchId: branch.branchId,
              reviewerBranchId,
              reviewSlot: review.slot,
              threadId: review.threadId,
              createdAt: updatedAt,
            });
          }
          const existingDelivery = behavior.idempotentStageSetup
            ? yield* deliveryForStage(review.threadId, review.updatedAt)
            : null;
          const deliveryError = ensureDeliveryCanResume(
            existingDelivery,
            `${review.slot} plan review`,
          );
          if (deliveryError) return yield* Effect.fail(deliveryError);
          // A turn requested before this review was (re)queued belongs to an earlier, failed
          // attempt; one requested since is this attempt's turn (a restart mid-launch).
          const latestTurn = reviewThread?.latestTurn ?? null;
          const staleTurn = latestTurn !== null && latestTurn.requestedAt < review.updatedAt;
          const alreadyStarted = latestTurn !== null && !staleTurn;
          const retry =
            retries?.get(review.threadId) ??
            (staleTurn ? ({ kind: "retry", reusedThread: true } as const) : undefined);
          if (!existingDelivery && !alreadyStarted) {
            yield* startReviewTurn({
              orchestrationEngine,
              workflow: intentWorkflow,
              reviewerSlot,
              reviewThreadId: review.threadId,
              planMarkdown: plans.get(branch.branchId)!,
              planTurnId: branch.planTurnId,
              reviewKind: review.slot,
              reviewedBranchId: branch.branchId,
              createdAt: updatedAt,
              attempt: review.retryCount,
              ...(retry ? { retry } : {}),
            });
          }
        });

      /** Applies one review's transition onto a fresh read, unless it already moved on. */
      const writeReview = (
        threadId: ThreadId,
        from: ReadonlyArray<string>,
        patch:
          | { readonly status: "running" }
          | { readonly status: "error"; readonly error: string },
      ) =>
        Effect.gen(function* () {
          const current = yield* readWorkflow(orchestrationEngine, workflow.id);
          if (!current || isArchivedWorkflow(current)) return false;
          let changed = false;
          let next = current;
          for (const branch of planningBranches(current)) {
            next = updatePlanningBranch(next, branch.branchId, (entry) => ({
              ...entry,
              reviews: entry.reviews.map((review) => {
                if (review.threadId !== threadId || !from.includes(review.status)) return review;
                changed = true;
                return { ...review, ...patch, updatedAt };
              }),
            }));
          }
          if (changed) yield* upsertWorkflow({ ...next, updatedAt });
          return changed;
        });

      const launched = new Set<ThreadId>();
      let costLimitError: string | null = null;
      // Backfilling: a review that fails to launch frees its slot for the next one in order, so
      // a pass that admits reviews which all fail still starts the rest of the queue.
      let active = inFlight;
      for (const record of [...resumes, ...pending]) {
        if (active >= WORKFLOW_MAX_ACTIVE_REVIEW_TURNS) break;
        // Turns already running may finish above the limit; nothing new starts past it.
        const budgetError = workflowBudgetError(intentWorkflow);
        if (budgetError) {
          costLimitError = budgetError.message;
          break;
        }
        // Each admission is saved before its dispatch, so a turn that finishes (even across a
        // restart) always finds its review running and completes it.
        if (
          record.review.status === "pending" &&
          !(yield* writeReview(record.review.threadId, ["pending"], { status: "running" }))
        ) {
          continue;
        }
        launched.add(record.review.threadId);
        // Marked before dispatching, so a concurrent pass never resends this review.
        dispatchedPlanReviewThreads.add(record.review.threadId);
        const exit = yield* Effect.exit(launch(record));
        if (Exit.isSuccess(exit)) {
          active += 1;
          dispatched.add(record.review.threadId);
          continue;
        }
        dispatchedPlanReviewThreads.delete(record.review.threadId);
        yield* writeReview(record.review.threadId, ["pending", "running"], {
          status: "error",
          error: errorMessage(Cause.squash(exit.cause)),
        });
      }
      if (costLimitError) {
        for (const record of pending) {
          if (launched.has(record.review.threadId)) continue;
          yield* writeReview(record.review.threadId, ["pending"], {
            status: "error",
            error: costLimitError,
          });
        }
      }
      return dispatched;
    });

  const maybeStartRevisions = (
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
    updatedAt: string,
    handledThreads?: ReadonlySet<ThreadId>,
  ) =>
    Effect.gen(function* () {
      const branches = planningBranches(workflow);
      const startsFresh = branches.every((branch) => branch.status === "reviews_saved");
      const candidates = startsFresh
        ? branches
        : branches.filter(
            (branch) => branch.status === "revising" && !handledThreads?.has(branch.authorThreadId),
          );
      if (candidates.length === 0) return;

      const behavior = resolveWorkflowBehavior({
        runKind: "planning",
        templateId: workflow.templateId,
        templateVersion: workflow.templateVersion,
      });

      // Every candidate is judged against this captured record: a sibling's rejection
      // rereads and rewrites the workflow, and must not become the baseline another
      // branch's stale failure is compared with.
      const current = startsFresh
        ? branches.reduce(
            (next, branch) => markBranchRevising(next, branch.branchId, updatedAt),
            workflow,
          )
        : workflow;

      const inputs = yield* Effect.forEach(candidates, (candidate) =>
        Effect.gen(function* () {
          const branch = requirePlanningBranch(current, candidate.branchId);
          const thread = snapshot.threads.find((entry) => entry.id === branch.authorThreadId);
          const originalPlanMarkdown = thread?.proposedPlans.find(
            (plan) => plan.turnId === branch.planTurnId,
          )?.planMarkdown;
          const reviews = yield* reviewFeedbackForBranch(workflow, branch, snapshot);
          if (!reviews.length || (behavior.templateVersion === 2 && !originalPlanMarkdown)) {
            return null;
          }
          return {
            branch,
            thread,
            originalPlanMarkdown:
              originalPlanMarkdown ?? "# Original plan unavailable (legacy workflow)",
            reviews,
          };
        }),
      );
      if (startsFresh) {
        if (inputs.some((input) => input === null)) return;
        yield* upsertWorkflow(current);
      }

      // Each branch settles on its own: a delivery that can't resume, or a start that
      // fails, marks only that branch failed (with Retry), and the caller always learns
      // which branches did start so the startup audit leaves them alone.
      const dispatched = new Set<ThreadId>();
      yield* Effect.forEach(
        inputs,
        (input) =>
          Effect.gen(function* () {
            if (!input) return;
            const { branch, thread } = input;
            const existingDelivery = behavior.idempotentStageSetup
              ? yield* deliveryForStage(branch.authorThreadId, branch.updatedAt)
              : null;
            const deliveryError = ensureDeliveryCanResume(existingDelivery, "Plan revision");
            if (deliveryError) {
              yield* rejectRevision(
                { workflow: current, branch, createdAt: updatedAt },
                deliveryError.message,
              );
              return;
            }
            if (
              existingDelivery ||
              (thread?.latestTurn &&
                thread.latestTurn.turnId !== branch.planTurnId &&
                thread.latestTurn.requestedAt >= branch.updatedAt)
            ) {
              return;
            }
            const outcome = yield* dispatchRevisionTurn({
              ...input,
              workflow: current,
              createdAt: updatedAt,
            });
            if (outcome.started) dispatched.add(branch.authorThreadId);
          }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("workflow revision start failed", {
                    workflowId: workflow.id,
                    branchId: input?.branch.branchId,
                    cause: Cause.pretty(cause),
                  }).pipe(
                    Effect.andThen(
                      input
                        ? rejectRevision(
                            { workflow: current, branch: input.branch, createdAt: updatedAt },
                            `Plan revision could not be started: ${errorMessage(Cause.squash(cause))}`,
                          ).pipe(Effect.asVoid)
                        : Effect.void,
                    ),
                  ),
            ),
          ),
        { discard: true },
      );
      return dispatched;
    });

  const maybeStartMerge = (
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
    updatedAt: string,
    retry?: WorkflowRetryContext,
  ) =>
    Effect.gen(function* () {
      const branches = planningBranches(workflow);
      const allRevised = branches.every((branch) => branch.status === "revised");
      const startsFresh = allRevised && workflow.merge.status === "not_started";
      const resumesPersistedIntent =
        allRevised && workflow.merge.status === "in_progress" && workflow.merge.threadId !== null;
      if (!startsFresh && !resumesPersistedIntent) {
        return;
      }

      const plans = collectMergeInputs(workflow, snapshot);
      if (!plans) {
        return;
      }

      const behavior = resolveWorkflowBehavior({
        runKind: "planning",
        templateId: workflow.templateId,
        templateVersion: workflow.templateVersion,
      });
      const mergeThreadId =
        workflow.merge.threadId ??
        ThreadId.makeUnsafe(
          stableWorkflowUuid(
            "plan-merge-thread",
            workflow.id,
            ...branches.map((branch) => branch.revisionTurnId),
            workflow.merge.updatedAt,
          ),
        );
      if (startsFresh) {
        // Checked before the start is saved: a merge whose inputs can never fit (every revised
        // plan in one prompt) or that is over budget fails visibly, instead of sitting
        // `in_progress` with no turn.
        const preflightError =
          workflowBudgetError(workflow) ??
          workflowPromptInvariant({
            workflow,
            prompt: buildWorkflowMergePrompt(workflow, plans, retry),
            artifacts: plans,
            targetSlot: workflow.merge.mergeSlot,
            artifactLabel: "Merge inputs",
          });
        if (preflightError) {
          yield* upsertWorkflow(markMergeError(workflow, preflightError.message, updatedAt));
          return;
        }
      }
      const intentWorkflow = startsFresh
        ? markMergeStarted(workflow, mergeThreadId, updatedAt)
        : workflow;
      if (startsFresh) {
        yield* upsertWorkflow(intentWorkflow);
      }

      const mergeThread = snapshot.threads.find((thread) => thread.id === mergeThreadId);
      if (!mergeThread) {
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: stableWorkflowCommandId("create-plan-merge-thread", mergeThreadId),
          threadId: mergeThreadId,
          projectId: intentWorkflow.projectId,
          title: "Merge",
          model: intentWorkflow.merge.mergeSlot.model,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: WORKFLOW_PLANNING_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: updatedAt,
        });
      }
      const existingDelivery = behavior.idempotentStageSetup
        ? yield* deliveryForStage(mergeThreadId, intentWorkflow.merge.updatedAt)
        : null;
      const deliveryError = ensureDeliveryCanResume(existingDelivery, "Plan merge");
      if (deliveryError) return yield* Effect.fail(deliveryError);
      const alreadyStarted =
        mergeThread?.latestTurn !== null &&
        mergeThread?.latestTurn !== undefined &&
        mergeThread.latestTurn.requestedAt >= intentWorkflow.merge.updatedAt;
      if (existingDelivery || alreadyStarted) {
        return;
      }
      yield* startMergeTurn({
        orchestrationEngine,
        workflow: intentWorkflow,
        threadId: mergeThreadId,
        plans,
        createdAt: updatedAt,
        ...(retry ? { retry } : {}),
      });
    });

  const dispatchDocumentReaderStage = (
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
    stage: "reader" | "polish",
    createdAt: string,
    retry?: WorkflowRetryContext,
  ) =>
    Effect.gen(function* () {
      const pass = workflow.readerPass!;
      const slot = stage === "reader" ? workflow.readerSlot! : workflow.merge.mergeSlot;
      const threadId = stage === "reader" ? pass.readerThreadId : workflow.merge.threadId!;
      const thread = snapshot.threads.find((entry) => entry.id === threadId);
      const draft = snapshot.threads
        .find((entry) => entry.id === workflow.merge.threadId)
        ?.proposedPlans.find((plan) => plan.id === pass.draftPlanId);
      if (!draft) return yield* Effect.fail(new Error("Merged document not found."));
      const reportThread = snapshot.threads.find((entry) => entry.id === pass.readerThreadId);
      const report = reportThread
        ? reviewFeedbackForPinnedTurn(
            reportThread,
            pass.pinnedTurnId,
            pass.pinnedAssistantMessageId,
          )?.text
        : null;
      if (stage === "polish" && !report?.trim())
        return yield* Effect.fail(new Error("Reader review produced no report."));
      const budgetError = workflowBudgetError(workflow);
      if (budgetError) return yield* Effect.fail(budgetError);
      const source = {
        workflowId: workflow.id,
        stage: stage === "reader" ? "merge" : "reader-review",
        turnId: stage === "reader" ? pass.draftTurnId : (pass.pinnedTurnId ?? undefined),
      };
      const prompt =
        stage === "reader"
          ? buildDocumentReaderReviewPrompt({ workflow, markdown: draft.planMarkdown, source })
          : buildDocumentPolishPrompt({
              workflow,
              report: report!,
              source,
              ...(retry ? { retry } : {}),
            });
      const promptError = workflowPromptInvariant({
        workflow,
        prompt,
        artifacts: [stage === "reader" ? draft.planMarkdown : report!],
        targetSlot: slot,
        artifactLabel: stage === "reader" ? "Merged document" : "Reader report",
        ...(thread ? { thread } : {}),
      });
      if (promptError) return yield* Effect.fail(promptError);
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: stableWorkflowCommandId(`document-${stage}`, workflow.id, threadId, createdAt),
        threadId,
        message: {
          messageId: MessageId.makeUnsafe(
            stableWorkflowUuid(`document-${stage}-message`, workflow.id, threadId, createdAt),
          ),
          role: "user",
          text: prompt,
          attachments: [],
        },
        ...workflowTurnProviderFields(slot),
        titleSourceText: workflow.title,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        ...workflowTurnBehaviorFields({
          runKind: "planning",
          templateId: workflow.templateId,
          templateVersion: workflow.templateVersion,
          stage: stage === "reader" ? "plan-review" : "merge",
        }),
        createdAt,
      });
    });

  const maybeContinueDocumentReaderPass = (
    workflow: PlanningWorkflow,
  ): Effect.Effect<void, OrchestrationDispatchError | Error> =>
    Effect.gen(function* () {
      if (
        !isDocumentWorkflow(workflow) ||
        workflow.merge.status !== "merged" ||
        !workflow.readerPass
      )
        return;
      let current = workflow;
      const snapshot = yield* orchestrationEngine.getReadModel();
      const persisted = snapshot.planningWorkflows.find((entry) => entry.id === workflow.id);
      if (persisted) current = persisted;
      if (isArchivedWorkflow(current)) return;
      const pass = current.readerPass;
      if (!pass || current.merge.status !== "merged") return;
      const stage =
        pass.status === "reader_requested"
          ? "reader"
          : pass.status === "reader_saved" || pass.status === "polishing"
            ? "polish"
            : null;
      if (!stage) return;
      yield* Effect.gen(function* () {
        const budgetError = pass.status === "polishing" ? null : workflowBudgetError(current);
        if (budgetError) return yield* Effect.fail(budgetError);
        if (
          stage === "reader" &&
          !snapshot.threads.some((thread) => thread.id === pass.readerThreadId)
        ) {
          yield* orchestrationEngine.dispatch({
            type: "thread.create",
            commandId: stableWorkflowCommandId(
              "create-document-reader",
              current.id,
              pass.readerThreadId,
            ),
            threadId: pass.readerThreadId,
            projectId: current.projectId,
            title: "Reader review",
            model: current.readerSlot!.model,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: "plan",
            branch: null,
            worktreePath: null,
            createdAt: pass.updatedAt,
          });
        }
        if (pass.status === "reader_saved") {
          current = markPolishRequested(current, new Date().toISOString());
          yield* upsertWorkflow(current);
        }
        const intentAt =
          stage === "reader" ? pass.updatedAt : current.readerPass!.polishRequestedAt!;
        const threadId = stage === "reader" ? pass.readerThreadId : current.merge.threadId!;
        const thread = snapshot.threads.find((entry) => entry.id === threadId);
        const alreadyStarted = !!thread?.latestTurn && thread.latestTurn.requestedAt >= intentAt;
        if (
          alreadyStarted &&
          (hasRunningSessionTurn(thread) || thread?.latestTurn?.state === "running")
        ) {
          if (stage === "reader") yield* upsertWorkflow(markReaderRunning(current, intentAt));
          return;
        }
        const delivery = yield* deliveryForStage(threadId, intentAt);
        const deliveryError = ensureDeliveryCanResume(
          delivery,
          stage === "reader" ? "Reader review" : "Polish",
        );
        if (deliveryError) return yield* Effect.fail(deliveryError);
        if (!delivery && !alreadyStarted)
          yield* dispatchDocumentReaderStage(current, snapshot, stage, intentAt);
        if (stage === "reader") {
          current = markReaderRunning(current, intentAt);
          yield* upsertWorkflow(current);
          // Dispatch may have completed before the running state was persisted (including
          // across a restart). Consume that completion without sending another turn.
          const latest = yield* orchestrationEngine.getReadModel();
          const advanced = yield* maybeAdvanceDocumentReaderPass(
            current,
            latest,
            threadId,
            new Date().toISOString(),
          );
          if (advanced !== current) yield* maybeContinueDocumentReaderPass(advanced);
        }
      }).pipe(
        Effect.catch((error) =>
          upsertWorkflow(
            markReaderPassError(current, stage, String(error), new Date().toISOString()),
          ).pipe(Effect.asVoid),
        ),
      );
    });

  const maybeAdvanceDocumentReaderPass = (
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
    threadId: ThreadId,
    updatedAt: string,
    expectedTurnId?: TurnId | null,
  ): Effect.Effect<PlanningWorkflow, OrchestrationDispatchError | Error | null> =>
    Effect.gen(function* () {
      const pass = workflow.readerPass;
      const thread = snapshot.threads.find((entry) => entry.id === threadId);
      if (!thread) return workflow;
      if (!pass) {
        const plan = thread.proposedPlans.find((entry) => entry.turnId === workflow.merge.turnId);
        if (threadId !== workflow.merge.threadId || !plan) return workflow;
        const healed = markMergeReadyForManualReview(
          { ...workflow, merge: { ...workflow.merge, approvedPlanId: null } },
          {
            turnId: plan.turnId!,
            approvedPlanId: plan.id,
            updatedAt,
          },
        );
        yield* upsertWorkflow(healed);
        return healed;
      }
      const completedTurnId = getFinishedLatestTurnId(thread);
      const finished =
        getFinishedConsumableLatestTurn(thread) ??
        (completedTurnId
          ? {
              turnId: completedTurnId,
              assistantMessageId: thread.latestTurn?.assistantMessageId ?? null,
              assistantText: "",
            }
          : null);
      if (!finished || (expectedTurnId && finished.turnId !== expectedTurnId)) return workflow;
      if (pass.status === "error" && (thread.latestTurn?.completedAt ?? "") < pass.updatedAt)
        return workflow;
      let next = workflow;
      if (
        threadId === pass.readerThreadId &&
        (pass.status === "reader_running" ||
          (pass.status === "error" && pass.errorStage === "reader")) &&
        pass.readerStartedAt &&
        thread.latestTurn!.requestedAt >= pass.readerStartedAt
      ) {
        next = markReaderSaved(workflow, {
          turnId: finished.turnId,
          messageId: finished.assistantMessageId,
          updatedAt,
        });
        if (
          !reviewFeedbackForPinnedTurn(
            thread,
            finished.turnId,
            finished.assistantMessageId,
          )?.text.trim()
        )
          next = markReaderPassError(
            next,
            "reader",
            "Reader review produced no report.",
            updatedAt,
          );
      } else if (
        threadId === workflow.merge.threadId &&
        (pass.status === "polishing" ||
          (pass.status === "error" && pass.errorStage === "polish")) &&
        finished.turnId !== pass.draftTurnId &&
        pass.polishRequestedAt &&
        thread.latestTurn!.requestedAt >= pass.polishRequestedAt
      ) {
        const validate = (markdown: string) =>
          validateDocumentArtifact(
            markdown,
            planningWorkflowDocumentType(workflow)!,
            "replacement",
          );
        let plan = thread.proposedPlans.find((entry) => entry.turnId === finished.turnId);
        if (!plan) {
          yield* maybeSynthesizeProposedPlan({
            workflow,
            provider: workflow.merge.mergeSlot.provider,
            thread,
            turnId: finished.turnId,
            createdAt: updatedAt,
            validate,
          });
          const refreshed = yield* orchestrationEngine.getReadModel();
          plan = refreshed.threads
            .find((entry) => entry.id === threadId)
            ?.proposedPlans.find((entry) => entry.turnId === finished.turnId);
        }
        const validation = validate(plan?.planMarkdown ?? finished.assistantText ?? "");
        if (plan && validation.valid)
          next = markPolishCompleted(workflow, {
            turnId: finished.turnId,
            planId: plan.id,
            updatedAt,
          });
        else {
          const reason = validation.valid
            ? "No complete document was captured."
            : validation.reason;
          if (pass.polishFormatRepairAttempts >= 1)
            next = markReaderPassError(
              workflow,
              "polish",
              `Invalid document: ${reason}`,
              updatedAt,
            );
          else {
            next = markPolishRequested(
              {
                ...workflow,
                readerPass: {
                  ...pass,
                  polishFormatRepairAttempts: pass.polishFormatRepairAttempts + 1,
                },
              },
              updatedAt,
            );
            yield* upsertWorkflow(next);
            yield* dispatchDocumentReaderStage(next, snapshot, "polish", updatedAt, {
              kind: "retry",
              reusedThread: true,
              formatRepair: true,
              priorFailure: reason,
            }).pipe(
              Effect.catch((error) =>
                upsertWorkflow(markReaderPassError(next, "polish", String(error), updatedAt)).pipe(
                  Effect.asVoid,
                ),
              ),
            );
            return next;
          }
        }
      }
      if (next !== workflow) yield* upsertWorkflow(next);
      return next;
    });

  const maybeContinuePlanningWorkflowLifecycle = (
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
    updatedAt: string,
    handledRevisionThreads?: ReadonlySet<ThreadId>,
  ) =>
    Effect.gen(function* () {
      if (isArchivedWorkflow(workflow)) return;
      const dispatchedReviews = yield* maybeStartReviews(workflow, snapshot, updatedAt);
      const dispatchedRevisions = yield* maybeStartRevisions(
        workflow,
        snapshot,
        updatedAt,
        handledRevisionThreads,
      );
      yield* maybeStartMerge(workflow, snapshot, updatedAt);
      yield* maybeContinueDocumentReaderPass(workflow);
      // Every author and review thread this pass dispatched a turn to.
      return new Set<ThreadId>([...dispatchedReviews, ...(dispatchedRevisions ?? [])]);
    });

  const maybeAdvancePlanningWorkflowFromCompletedThread = (
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
    threadId: ThreadId,
    updatedAt: string,
    options?: {
      readonly expectedTurnId?: TurnId | null;
    },
  ) =>
    Effect.gen(function* () {
      const thread = snapshot.threads.find((entry) => entry.id === threadId);
      if (!thread) {
        return workflow;
      }

      if (isDocumentWorkflow(workflow) && workflow.merge.status === "merged")
        return yield* maybeAdvanceDocumentReaderPass(
          workflow,
          snapshot,
          threadId,
          updatedAt,
          options?.expectedTurnId,
        );

      const authorBranchId =
        planningBranches(workflow).find((entry) => entry.authorThreadId === threadId)?.branchId ??
        null;
      if (authorBranchId) {
        const branch = requirePlanningBranch(workflow, authorBranchId);
        if (branch.status === "plan_saved" || branch.status === "revised") {
          const pinnedTurnId =
            branch.status === "revised" ? branch.revisionTurnId : branch.planTurnId;
          const selection = resolvePinnedAuthorPlan(
            snapshot,
            threadId,
            pinnedTurnId,
            branch.updatedAt,
            planReplacementFilter(workflow, branch.branchId),
          );
          if (selection.status !== "ready" || selection.plan.turnId === pinnedTurnId) {
            return workflow;
          }

          const replacementTurnId = selection.plan.turnId;
          if (
            !replacementTurnId ||
            (options?.expectedTurnId && replacementTurnId !== options.expectedTurnId) ||
            (branch.status === "plan_saved" && branch.reviews.length > 0) ||
            workflow.merge.status !== "not_started" ||
            !validateCapturedPlanForTurn({
              workflow,
              provider: branch.authorSlot.provider,
              thread,
              turnId: replacementTurnId,
              maxPlanChars: workflowPlanCharBudget(workflow),
              branchId: authorBranchId,
            }).valid
          ) {
            return workflow;
          }

          const nextWorkflow =
            branch.status === "revised"
              ? markBranchRevised(workflow, authorBranchId, {
                  turnId: replacementTurnId,
                  updatedAt,
                })
              : markBranchPlanSaved(workflow, authorBranchId, {
                  turnId: replacementTurnId,
                  updatedAt,
                });
          if (nextWorkflow !== workflow) {
            yield* upsertWorkflow(nextWorkflow);
          }
          return nextWorkflow;
        }

        const turnId = getFinishedLatestTurnId(thread);
        if (!turnId || (options?.expectedTurnId && turnId !== options.expectedTurnId)) {
          return workflow;
        }
        const failureStage = planningWorkflowBranchFailureStage(branch);
        // Once the current draft has been fully reviewed, the next author turn
        // is a revision even if a stale failure stage says otherwise.
        const currentDraftReviewed =
          branch.reviews.length > 0 &&
          branch.reviews.every((review) => review.status === "completed") &&
          reviewedPlanTurnIdForBranch(workflow, authorBranchId, branch, snapshot) ===
            branch.planTurnId;
        const authoringStage = branch.status === "authoring" || failureStage === "authoring";
        const isRevisionCompletion =
          branch.status === "revising" ||
          failureStage === "revision" ||
          (authoringStage && currentDraftReviewed);
        const isAuthoringCompletion = authoringStage && !currentDraftReviewed;
        if (!isAuthoringCompletion && !isRevisionCompletion) {
          return workflow;
        }
        if (isRevisionCompletion && turnId === branch.planTurnId) {
          return workflow;
        }
        // A rejected turn is not evaluated again while its stage still runs.
        // Planning branches in error may still accept a late valid capture.
        if (
          turnId === branch.rejectedDocumentTurnId &&
          (isDocumentWorkflow(workflow) ||
            branch.status === "authoring" ||
            branch.status === "revising")
        ) {
          return workflow;
        }
        const completionEvidenceAt =
          thread.latestTurn?.completedAt ?? thread.latestTurn?.requestedAt ?? null;
        if (!completionEvidenceAt || completionEvidenceAt < branch.updatedAt) {
          return workflow;
        }

        const capture = validateCapturedPlanForTurn({
          workflow,
          provider: branch.authorSlot.provider,
          thread,
          turnId,
          maxPlanChars: workflowPlanCharBudget(workflow),
          branchId: authorBranchId,
        });
        if (!capture.valid) {
          // An over-long plan was captured: repair it rather than synthesizing another.
          // A reply over the per-plan budget is not saved as a plan; it takes the same repair.
          let overBudgetError: string | undefined;
          const synthesized =
            !("overBudget" in capture) &&
            (yield* maybeSynthesizeProposedPlan({
              workflow,
              provider: branch.authorSlot.provider,
              thread,
              turnId,
              createdAt: updatedAt,
              budget: {
                branchId: authorBranchId,
                onOverBudget: (error) => {
                  overBudgetError = error;
                },
              },
            }));
          if (!synthesized) {
            // Valid late output can still be captured; a failed turn must not
            // trigger another provider turn to repair invalid output.
            if (branch.status === "error") return workflow;
            yield* retryOrFailInvalidPlanCapture({
              workflow,
              snapshot,
              thread,
              turnId,
              branchId: authorBranchId,
              createdAt: updatedAt,
              ...(overBudgetError !== undefined ? { validationError: overBudgetError } : {}),
            });
            return workflow;
          }
        }

        const nextWorkflow = isRevisionCompletion
          ? markBranchRevised(workflow, authorBranchId, {
              turnId,
              updatedAt,
            })
          : markBranchPlanSaved(workflow, authorBranchId, {
              turnId,
              updatedAt,
            });
        if (nextWorkflow !== workflow) {
          yield* upsertWorkflow(nextWorkflow);
        }
        return nextWorkflow;
      }

      const reviewMatch = workflowForReviewThread([workflow], threadId);
      if (reviewMatch) {
        const branch = requirePlanningBranch(workflow, reviewMatch.branchId);
        const review = branch.reviews.find((entry) => entry.threadId === threadId);
        const finishedTurn = getFinishedConsumableLatestTurn(thread);
        if (
          (review?.status !== "running" && review?.status !== "error") ||
          !finishedTurn ||
          (review.status === "error" &&
            (thread.latestTurn?.completedAt ?? thread.latestTurn?.requestedAt ?? "") <
              review.updatedAt) ||
          // A requeued review is saved `running` before its new turn exists: a turn requested
          // before that belongs to an earlier attempt, not this one.
          (review.status === "running" && (thread.latestTurn?.requestedAt ?? "") < review.updatedAt)
        ) {
          return workflow;
        }

        const nextWorkflow = markReviewCompleted(
          workflow,
          reviewMatch.branchId,
          threadId,
          updatedAt,
          finishedTurn.turnId,
          finishedTurn.assistantMessageId,
        );
        if (nextWorkflow !== workflow) {
          yield* upsertWorkflow(nextWorkflow);
        }
        return nextWorkflow;
      }

      if (
        workflow.merge.threadId !== threadId ||
        (workflow.merge.status !== "in_progress" && workflow.merge.status !== "error")
      ) {
        return workflow;
      }

      const turnId = getFinishedLatestTurnId(thread);
      if (!turnId || (options?.expectedTurnId && turnId !== options.expectedTurnId)) {
        return workflow;
      }
      const mergeCompletionEvidenceAt =
        thread.latestTurn?.completedAt ?? thread.latestTurn?.requestedAt ?? null;
      if (
        turnId === workflow.merge.rejectedDocumentTurnId &&
        (isDocumentWorkflow(workflow) || workflow.merge.status === "in_progress")
      )
        return workflow;
      if (
        workflow.merge.status === "error" &&
        (!mergeCompletionEvidenceAt || mergeCompletionEvidenceAt < workflow.merge.updatedAt)
      ) {
        return workflow;
      }

      const hasPlan = validateCapturedPlanForTurn({
        workflow,
        provider: workflow.merge.mergeSlot.provider,
        thread,
        turnId,
      }).valid;
      if (!hasPlan) {
        const synthesized = yield* maybeSynthesizeProposedPlan({
          workflow,
          provider: workflow.merge.mergeSlot.provider,
          thread,
          turnId,
          createdAt: updatedAt,
        });
        if (!synthesized) {
          if (workflow.merge.status === "error") return workflow;
          yield* retryOrFailInvalidPlanCapture({
            workflow,
            snapshot,
            thread,
            turnId,
            createdAt: updatedAt,
          });
          return workflow;
        }
      }

      // The output path comes from the merge turn's file-change activity, which a
      // thread archived before startup has not loaded yet.
      yield* orchestrationEngine.ensureThreadActivities?.([threadId]) ?? Effect.void;
      const latestReadModel = yield* orchestrationEngine.getReadModel();
      const latestMergeThread =
        latestReadModel.threads.find((entry) => entry.id === threadId) ?? thread;
      const mergedPlanId =
        latestMergeThread.proposedPlans.find((plan) => plan.turnId === turnId)?.id ?? null;
      const outputFilePath = latestMarkdownFileChangePath(latestMergeThread, turnId);
      const nextWorkflow =
        isDocumentWorkflow(workflow) && workflow.readerReviewEnabled && mergedPlanId
          ? markDocumentMergeDrafted(workflow, {
              turnId,
              draftPlanId: mergedPlanId,
              readerThreadId: ThreadId.makeUnsafe(
                stableWorkflowUuid("document-reader-thread", workflow.id, turnId, updatedAt),
              ),
              updatedAt,
            })
          : markMergeReadyForManualReview(workflow, {
              turnId,
              updatedAt,
              approvedPlanId: mergedPlanId,
              ...(outputFilePath ? { outputFilePath } : {}),
            });
      if (nextWorkflow !== workflow) {
        yield* upsertWorkflow(nextWorkflow);
      }
      return nextWorkflow;
    });

  const maybeStartCodeReviews = (
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
    updatedAt: string,
  ) =>
    Effect.gen(function* () {
      if (
        !workflow.implementation ||
        (workflow.implementation.status !== "implemented" &&
          workflow.implementation.status !== "code_reviews_requested")
      ) {
        return;
      }
      if (!workflow.implementation.codeReviewEnabled) {
        yield* upsertWorkflow(markImplementationCompleted(workflow, null, updatedAt));
        return;
      }

      const mergeThread = snapshot.threads.find((thread) => thread.id === workflow.merge.threadId);
      const mergedPlan = mergeThread ? resolveApprovedMergedPlan(workflow, mergeThread) : null;
      if (!mergedPlan?.planMarkdown) {
        yield* upsertWorkflow(
          markImplementationError(workflow, "Merged plan not found for code review.", updatedAt),
        );
        return;
      }

      const behavior = resolveWorkflowBehavior({
        runKind: "planning",
        templateId: workflow.templateId,
        templateVersion: workflow.templateVersion,
      });
      let reviewWorkflow = workflow;
      let reviewArtifact = workflow.implementation.reviewArtifact;
      if (behavior.checkpointBackedImplementationReview && !reviewArtifact) {
        const implementationThreadId = workflow.implementation.threadId;
        const implementationTurnId = workflow.implementation.implementationTurnId;
        const implementationThread = snapshot.threads.find(
          (thread) => thread.id === implementationThreadId,
        );
        const checkpoint = implementationThread?.checkpoints.find(
          (candidate) => candidate.turnId === implementationTurnId,
        );
        if (!implementationThreadId || !implementationTurnId || !implementationThread) {
          yield* upsertWorkflow(
            markImplementationError(
              workflow,
              "Implementation review setup could not resolve the completed implementation turn.",
              updatedAt,
              "review-setup",
            ),
          );
          return;
        }
        // Assistant completion can arrive before checkpoint capture. The
        // thread.turn-diff-completed event re-enters this state machine. At
        // processing quiescence, absence is definitive. Some valid workspaces,
        // such as roots spanning multiple Git repositories, cannot produce a
        // single checkpoint, so continue with read-only workspace inspection.
        if (!checkpoint) {
          if (!implementationThread.latestTurn?.processingQuiescedAt) {
            return;
          }
        } else {
          if (checkpoint.status !== "ready") {
            yield* upsertWorkflow(
              markImplementationError(
                workflow,
                `Implementation review setup checkpoint ended with status '${checkpoint.status}'.`,
                updatedAt,
                "review-setup",
              ),
            );
            return;
          }
          if (checkpointDiffQuery._tag === "None") {
            yield* upsertWorkflow(
              markImplementationError(
                workflow,
                "Implementation review setup requires the checkpoint diff service.",
                updatedAt,
                "review-setup",
              ),
            );
            return;
          }
          const diffResult = yield* checkpointDiffQuery.value
            .getFullThreadDiff({
              threadId: implementationThreadId,
              toTurnCount: checkpoint.checkpointTurnCount,
            })
            .pipe(
              Effect.map((value) => ({ ok: true as const, value })),
              Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
            );
          if (!diffResult.ok) {
            yield* upsertWorkflow(
              markImplementationError(
                workflow,
                `Implementation review setup failed: ${String(diffResult.error)}`,
                updatedAt,
                "review-setup",
              ),
            );
            return;
          }
          const bounded = truncatePatchAtFileBoundary(diffResult.value.diff, false);
          reviewArtifact = {
            sourceThreadId: implementationThreadId,
            sourceTurnCount: checkpoint.checkpointTurnCount,
            patchText: bounded.patch,
            fullPatchHash: createHash("sha256").update(diffResult.value.diff).digest("hex"),
            truncated: bounded.truncated,
            truncationReason: bounded.reason,
            createdAt: updatedAt,
          };
          reviewWorkflow = {
            ...workflow,
            implementation: {
              ...workflow.implementation,
              reviewArtifact,
              error: null,
              errorStage: null,
              updatedAt,
            },
            updatedAt,
          };
          yield* upsertWorkflow(reviewWorkflow);
        }
      }

      const promptArtifact = implementationReviewPromptArtifact(reviewWorkflow);

      const reviewImplementation = reviewWorkflow.implementation;
      if (!reviewImplementation) return;
      const requestedReviews =
        reviewImplementation.codeReviews.length === 0
          ? // One reviewer per author against the same saved patch.
            planningBranches(workflow).map((branch) => ({
              reviewerSlot: branch.authorSlot,
              reviewerLabel: `Author ${workflowParticipantLabel(branch.branchId)} (${slotLabel(branch.authorSlot)})`,
              threadId: ThreadId.makeUnsafe(crypto.randomUUID()),
            }))
          : reviewImplementation.codeReviews.map((review) => ({
              reviewerSlot: review.reviewerSlot,
              reviewerLabel: review.reviewerLabel,
              threadId: review.threadId,
            }));

      const pendingWorkflow: PlanningWorkflow =
        reviewImplementation.codeReviews.length === 0
          ? markCodeReviewsRequested(reviewWorkflow, requestedReviews, updatedAt)
          : {
              ...reviewWorkflow,
              implementation: {
                ...reviewImplementation,
                status: "code_reviews_requested" as const,
                error: null,
                errorStage: null,
                updatedAt,
              },
              updatedAt,
            };
      yield* upsertWorkflow(pendingWorkflow);

      const setupResult = yield* Effect.gen(function* () {
        // Validate every undelivered review before creating threads or starting either turn.
        const preparedPrompts = new Map<ThreadId, string>();
        for (const [index, review] of requestedReviews.entries()) {
          const reviewState = pendingWorkflow.implementation?.codeReviews.find(
            (candidate) => candidate.threadId === review.threadId,
          );
          if (reviewState?.status !== "pending") continue;
          const reviewThread = snapshot.threads.find((thread) => thread.id === review.threadId);
          const delivery = behavior.idempotentStageSetup
            ? yield* deliveryForStage(review.threadId, reviewState.updatedAt)
            : null;
          const deliveryError = ensureDeliveryCanResume(
            delivery,
            `${review.reviewerLabel} implementation review`,
          );
          if (deliveryError) return yield* Effect.fail(deliveryError);
          if (reviewThread?.latestTurn || delivery) continue;
          const prepared = prepareCodeReviewPrompt({
            mergedPlanMarkdown: mergedPlan.planMarkdown,
            requirementPrompt: pendingWorkflow.requirementPrompt,
            reviewArtifact: promptArtifact,
            reviewerLabel: review.reviewerLabel,
            lensBranch: index % 2 === 0 ? "a" : "b",
            reviewerSlot: review.reviewerSlot,
            enforceArtifactBudget: behavior.loudAuthoritativeArtifactLimit,
            thread: reviewThread,
          });
          if (!("prompt" in prepared)) return yield* prepared;
          preparedPrompts.set(review.threadId, prepared.prompt);
        }
        yield* Effect.forEach(
          requestedReviews,
          (review) =>
            Effect.gen(function* () {
              const reviewState = pendingWorkflow.implementation?.codeReviews.find(
                (candidate) => candidate.threadId === review.threadId,
              );
              if (reviewState?.status !== "pending") return;
              let reviewThread = snapshot.threads.find((thread) => thread.id === review.threadId);
              if (!reviewThread) {
                yield* createCodeReviewThread({
                  orchestrationEngine,
                  workflow: pendingWorkflow,
                  reviewerSlot: review.reviewerSlot,
                  threadId: review.threadId,
                  reviewerLabel: review.reviewerLabel,
                  createdAt: updatedAt,
                });
                const refreshed = yield* orchestrationEngine.getReadModel();
                reviewThread = refreshed.threads.find((thread) => thread.id === review.threadId);
              }
              const existingDelivery = behavior.idempotentStageSetup
                ? yield* deliveryForStage(
                    review.threadId,
                    reviewState?.updatedAt ?? pendingWorkflow.updatedAt,
                  )
                : null;
              const deliveryError = ensureDeliveryCanResume(
                existingDelivery,
                `${review.reviewerLabel} implementation review`,
              );
              if (deliveryError) return yield* Effect.fail(deliveryError);
              if (!reviewThread?.latestTurn && !existingDelivery) {
                yield* startCodeReviewTurn({
                  orchestrationEngine,
                  workflow: pendingWorkflow,
                  reviewerSlot: review.reviewerSlot,
                  reviewThreadId: review.threadId,
                  mergedPlanMarkdown: mergedPlan.planMarkdown,
                  reviewerLabel: review.reviewerLabel,
                  lensBranch: codeReviewLensBranch(pendingWorkflow, review.threadId),
                  reviewArtifact: promptArtifact,
                  preparedPrompt: preparedPrompts.get(review.threadId),
                  createdAt: updatedAt,
                });
              }
            }),
          { discard: true },
        );
      }).pipe(
        Effect.map(() => ({ ok: true as const })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      );
      if (!setupResult.ok) {
        yield* upsertWorkflow(
          markImplementationError(
            pendingWorkflow,
            `Implementation review setup failed: ${String(setupResult.error)}`,
            updatedAt,
            "review-setup",
          ),
        );
        return;
      }

      yield* upsertWorkflow(markCodeReviewsRunning(pendingWorkflow, updatedAt));
    });

  const readRevisionTurn = (thread: OrchestrationThread, turnId: TurnId) => {
    if (thread.latestTurn?.turnId === turnId) return Effect.succeed(thread.latestTurn);
    return turnRepository._tag === "Some"
      ? turnRepository.value
          .getByTurnId({ threadId: thread.id, turnId })
          .pipe(Effect.map(Option.getOrNull))
      : Effect.succeed(null);
  };

  const prepareImplementationRevision = (
    workflow: PlanningWorkflow,
    implementation: NonNullable<PlanningWorkflow["implementation"]>,
    snapshot: OrchestrationReadModel,
    legacyFormatting = false,
  ) =>
    Effect.gen(function* () {
      const reviews = [];
      const pinnedReviews = [];
      for (const review of implementation.codeReviews) {
        const thread = snapshot.threads.find((entry) => entry.id === review.threadId);
        let turnId = review.pinnedTurnId;
        let messageId = review.pinnedAssistantMessageId;
        if (thread && !turnId && !messageId) {
          // Legacy saves have only their completion boundary. Use the unique
          // completed output at that boundary, even if a later turn is latest.
          const turns =
            turnRepository._tag === "Some"
              ? yield* turnRepository.value.listByThreadId({ threadId: thread.id })
              : thread.latestTurn
                ? [thread.latestTurn]
                : [];
          const atBoundary = turns.filter((turn) => turn.requestedAt <= review.updatedAt);
          const lastRequestedAt = atBoundary.reduce(
            (latest, turn) => (latest > turn.requestedAt ? latest : turn.requestedAt),
            "",
          );
          const candidates = atBoundary.filter((turn) => turn.requestedAt === lastRequestedAt);
          const candidate =
            candidates.length === 1 &&
            candidates[0]?.state === "completed" &&
            candidates[0].completedAt &&
            candidates[0].completedAt <= review.updatedAt
              ? candidates[0]
              : undefined;
          const completed = candidate?.turnId
            ? getFinishedConsumableTurn(thread, { ...candidate, turnId: candidate.turnId })
            : null;
          turnId = completed?.turnId;
          messageId = completed?.assistantMessageId;
        }
        const message = thread?.messages.find(
          (entry) =>
            entry.id === messageId &&
            entry.turnId === turnId &&
            entry.role === "assistant" &&
            !entry.streaming,
        );
        const feedback = message
          ? formatAssistantFeedback(message, "Reviewer reasoning", !legacyFormatting)
          : null;
        if (review.status !== "completed" || !turnId || !messageId || !feedback) {
          return yield* Effect.fail(
            new Error(
              `Apply Reviews could not identify the saved output from ${review.reviewerLabel}. Restore the completed review output and retry.`,
            ),
          );
        }
        pinnedReviews.push({
          ...review,
          pinnedTurnId: turnId,
          pinnedAssistantMessageId: messageId,
        });
        reviews.push({
          reviewerLabel: review.reviewerLabel,
          reviewMarkdown: feedback.text,
          source: { workflowId: workflow.id, stage: review.reviewerLabel, turnId, messageId },
        });
      }
      if (reviews.length === 0) {
        return yield* Effect.fail(new Error("Apply Reviews has no saved reviews to send."));
      }
      return {
        pinnedReviews,
        prompt: buildImplementationRevisionPrompt({ reviews }),
        artifacts: reviews.map((review) => review.reviewMarkdown),
      };
    });

  const getRevisionDelivery = (commandId: CommandId) =>
    providerTurnDeliveryRepository._tag === "Some"
      ? providerTurnDeliveryRepository.value.getByCommandId(commandId)
      : Effect.succeed(null);

  const revisionContext = (
    thread: OrchestrationThread,
    slot: NonNullable<PlanningWorkflow["implementation"]>["implementationSlot"],
  ) => {
    // Same window resolution as planning revisions. Apply Reviews additionally
    // treats a compaction estimate as a full window, because it compacts on its
    // own before dispatching when the live fit fails.
    const { session, matchingThread, contextWindowTokens } = workflowContextTarget(slot, thread);
    const compactionEstimateOnly =
      matchingThread &&
      thread.compaction &&
      !thread.compaction.freshSessionRecordId &&
      session?.tokenUsageSource !== "provider" &&
      (thread.compaction.kind === "native" ||
        session?.status === "stopped" ||
        thread.lastInteractionAt <= thread.compaction.createdAt);
    return {
      contextWindowTokens,
      contextUsageTokens: compactionEstimateOnly
        ? contextWindowTokens
        : (session?.estimatedContextTokens ??
          (matchingThread ? thread.estimatedContextTokens : null) ??
          0),
    };
  };

  const reconcileApplyReviews = (
    workflowId: PlanningWorkflowId,
    options: {
      readonly retry?: "manual" | "automatic";
      readonly allowPossibleDuplicate?: boolean;
      readonly recheck?: boolean;
      readonly expectedTurnId?: TurnId | null;
      readonly expectedCommandId?: CommandId;
      readonly preflightOnly?: boolean;
      readonly compactionOutcome?: {
        readonly requestId: CommandId;
        readonly outcome: WorkflowCompactionOutcome;
      };
      readonly session?: Extract<
        OrchestrationEvent,
        { type: "thread.session-set" }
      >["payload"]["session"];
    } = {},
  ): Effect.Effect<OrchestrationRetryWorkflowResult, Error> =>
    Effect.gen(function* () {
      // A provider history read can block. Its result is consumed from the
      // durable delivery only after reacquiring the workflow gate.
      if (
        (options.recheck || options.retry === "manual") &&
        providerTurnDeliveryWorker._tag === "Some"
      ) {
        const current = yield* readWorkflow(orchestrationEngine, workflowId);
        const implementation = current?.implementation;
        if (implementation?.threadId && implementation.revisionDispatchCommandId) {
          const delivery = yield* getRevisionDelivery(implementation.revisionDispatchCommandId);
          if (
            delivery?.state === "sending" ||
            (options.retry === "manual" && delivery?.state === "ambiguous")
          ) {
            yield* providerTurnDeliveryWorker.value
              .recheck(implementation.threadId, delivery.deliveryId)
              .pipe(Effect.timeout(STARTUP_DISPATCH_RECHECK_TIMEOUT), Effect.ignore);
          }
        }
      }

      return yield* withWorkflowGate(
        workflowId,
        Effect.gen(function* () {
          const result = { status: "started" as const };
          const snapshot = yield* orchestrationEngine.getReadModel();
          const current = snapshot.planningWorkflows.find((entry) => entry.id === workflowId);
          if (!current || isDeletedWorkflow(current) || isArchivedWorkflow(current)) return result;
          let workflow = current;
          let implementation = workflow.implementation;
          if (!implementation?.threadId || !isApplyReviewsLifecycle(workflow)) return result;
          if (
            options.expectedCommandId &&
            implementation.revisionDispatchCommandId !== options.expectedCommandId
          )
            return result;
          const threadId = implementation.threadId;
          const thread = snapshot.threads.find(
            (entry) => entry.id === threadId && !entry.deletedAt,
          );
          const updatedAt = new Date().toISOString();

          if (options.session) {
            const withCost = applyWorkflowTurnCost(
              workflow,
              options.session.turnCostUsd,
              updatedAt,
            );
            if (withCost !== workflow) {
              yield* writeWorkflow(withCost);
              workflow = withCost;
            }
            // Only a current error can prompt a look at the exact failed turn.
            if (
              options.session.status !== "error" ||
              thread?.session?.status !== "error" ||
              thread.session.updatedAt !== options.session.updatedAt
            )
              return result;
          }
          const repairOnly = hasMisattributedRevision(workflow);
          if (implementation.status === "completed" && !repairOnly) return result;

          const fail = (detail: string) =>
            writeWorkflow(
              markImplementationError(workflow, detail, updatedAt, "apply-feedback"),
            ).pipe(Effect.as(result));
          if (!thread)
            return yield* fail("The Apply Reviews implementation thread is unavailable.");

          let commandId = implementation.revisionDispatchCommandId;
          let delivery = commandId ? yield* getRevisionDelivery(commandId) : null;
          if (options.preflightOnly && (delivery?.state === "accepted" || repairOnly))
            return result;
          if (!commandId && implementation.revisionAttempt === undefined) {
            let latest =
              providerTurnDeliveryRepository._tag === "Some"
                ? yield* providerTurnDeliveryRepository.value.getLatestByThread(threadId)
                : null;
            const boundary = repairOnly
              ? implementation.codeReviews.reduce(
                  (at, review) => (at > review.updatedAt ? at : review.updatedAt),
                  implementation.codeReviews[0]?.updatedAt ?? implementation.updatedAt,
                )
              : implementation.updatedAt;
            const legacyPrepared = thread.messages.some(
              (entry) => entry.role === "user" && entry.createdAt >= boundary,
            )
              ? yield* prepareImplementationRevision(workflow, implementation, snapshot, true).pipe(
                  Effect.option,
                )
              : Option.none();
            const matchingMessages = Option.isSome(legacyPrepared)
              ? thread.messages.filter(
                  (entry) =>
                    entry.role === "user" &&
                    entry.createdAt >= boundary &&
                    entry.text === legacyPrepared.value.prompt,
                )
              : [];
            const [matchingMessage] = matchingMessages;
            if (
              matchingMessages.length === 1 &&
              matchingMessage &&
              latest?.messageId !== matchingMessage.id
            ) {
              const evidence = yield* orchestrationEngine
                .readEvents(0, { threadId, eventTypes: ["thread.turn-start-requested"] })
                .pipe(
                  Stream.filter(
                    (event) =>
                      event.type === "thread.turn-start-requested" &&
                      event.payload.threadId === threadId &&
                      event.payload.messageId === matchingMessage.id &&
                      event.commandId !== null,
                  ),
                  Stream.take(2),
                  Stream.runCollect,
                );
              const [intent] = evidence;
              if (evidence.length === 1 && intent?.commandId)
                latest = yield* getRevisionDelivery(intent.commandId);
            }
            // The legacy dispatcher used the same timestamp for the durable
            // turn-start event and the applying state. Require the exact outbox
            // event and, when accepted, the turn's projected input association.
            let possibleLegacyDelivery = false;
            if (
              matchingMessages.length <= 1 &&
              latest &&
              (latest.createdAt === boundary ||
                ((repairOnly || implementation.status === "code_reviews_saved") &&
                  latest.createdAt >= boundary)) &&
              latest.event.type === "thread.turn-start-requested" &&
              latest.event.commandId === latest.commandId &&
              latest.event.payload.messageId === latest.messageId &&
              latest.providerTurnId !== implementation.implementationTurnId
            ) {
              const projected =
                latest.providerTurnId && turnRepository._tag === "Some"
                  ? yield* turnRepository.value.getByTurnId({
                      threadId,
                      turnId: latest.providerTurnId,
                    })
                  : Option.none();
              const prepared = legacyPrepared;
              const message = thread.messages.find((entry) => entry.id === latest.messageId);
              possibleLegacyDelivery =
                !message || Option.isNone(prepared) || message.text === prepared.value.prompt;
              if (
                Option.isSome(prepared) &&
                message?.role === "user" &&
                message.text === prepared.value.prompt &&
                (!repairOnly ||
                  (latest.state === "accepted" &&
                    Option.isSome(projected) &&
                    getFinishedConsumableTurn(thread, projected.value) !== null)) &&
                (latest.state !== "accepted" ||
                  (Option.isSome(projected) &&
                    projected.value.pendingMessageId === latest.messageId))
              ) {
                commandId = latest.commandId;
                delivery = latest;
                implementation = {
                  ...implementation,
                  status: "applying_reviews",
                  revisionTurnId: null,
                  revisionAttempt: 0,
                  revisionDispatchCommandId: commandId,
                };
                workflow = { ...workflow, implementation, updatedAt };
                yield* writeWorkflow(workflow);
              }
            }
            if (!commandId && repairOnly) {
              if (options.retry !== "manual") {
                if (options.recheck)
                  yield* Effect.logWarning("Could not verify the legacy Apply Reviews completion", {
                    workflowId,
                    threadId,
                  });
                return result;
              }
              if (!options.allowPossibleDuplicate)
                return { status: "confirmation_required" as const, threadIds: [threadId] };
            }
            if (
              !commandId &&
              !repairOnly &&
              (matchingMessages.length > 0 ||
                (possibleLegacyDelivery &&
                  implementation.status === "code_reviews_saved" &&
                  latest &&
                  latest.createdAt >= boundary &&
                  (latest.state === "accepted" ||
                    latest.state === "sending" ||
                    latest.state === "ambiguous") &&
                  latest.providerTurnId !== implementation.implementationTurnId))
            ) {
              yield* writeWorkflow({
                ...workflow,
                implementation: {
                  ...implementation,
                  status: "error",
                  revisionTurnId: null,
                  errorStage: "apply-feedback",
                  error:
                    "Could not verify the previous Apply Reviews delivery. Check the implementation conversation before retrying.",
                },
                updatedAt,
              });
              return result;
            }
            if (!commandId && implementation.status === "applying_reviews") {
              yield* writeWorkflow({
                ...markImplementationError(
                  workflow,
                  "Could not identify the previous Apply Reviews delivery. Wait for outstanding work to settle, then retry.",
                  updatedAt,
                  "apply-feedback",
                ),
                // Keep the legacy evidence boundary across retries.
                implementation: {
                  ...implementation,
                  status: "error",
                  errorStage: "apply-feedback",
                  error:
                    "Could not identify the previous Apply Reviews delivery. Wait for outstanding work to settle, then retry.",
                },
              });
              return result;
            }
            if (
              !commandId &&
              options.retry &&
              latest &&
              (latest.state === "pending" ||
                latest.state === "sending" ||
                latest.state === "ambiguous")
            ) {
              return yield* Effect.fail(
                new Error(
                  "Resolve the outstanding provider delivery before retrying Apply Reviews.",
                ),
              );
            }
          }

          if (options.preflightOnly && delivery?.state === "accepted") return result;
          let settledFailure = false;
          if (delivery?.state === "accepted") {
            const dispatch = yield* resolveStageDispatch(commandId);
            if (
              dispatch.kind !== "turn" ||
              dispatch.turnId === implementation.implementationTurnId ||
              (options.expectedTurnId && dispatch.turnId !== options.expectedTurnId)
            )
              return result;
            const turn = yield* readRevisionTurn(thread, dispatch.turnId);
            if (!turn?.completedAt) return result;
            const hasStreamingOutput = thread.messages.some(
              (message) =>
                message.turnId === turn.turnId && message.role === "assistant" && message.streaming,
            );
            if (!hasStreamingOutput && getFinishedConsumableTurn(thread, turn)) {
              if (!options.session)
                yield* writeWorkflow(markImplementationCompleted(workflow, turn.turnId, updatedAt));
              return result;
            }
            settledFailure = Boolean(
              turn.state === "error" ||
              turn.state === "interrupted" ||
              (turn.state === "completed" &&
                turn.processingQuiescedAt &&
                !hasStreamingOutput &&
                isSessionSettledForAutoRetry(thread)),
            );
            if (!settledFailure) return result;
            if (!options.retry) {
              const errorSession =
                thread.latestTurn?.turnId === dispatch.turnId && thread.session?.status === "error"
                  ? thread.session
                  : null;
              const failed = markImplementationError(
                workflow,
                errorSession?.lastError ??
                  (turn.state === "completed"
                    ? "The Apply Reviews turn finished without a finalized response."
                    : "The Apply Reviews turn failed or was interrupted."),
                updatedAt,
                "apply-feedback",
              );
              if (
                commandId &&
                errorSession &&
                isRetryableSessionError(errorSession) &&
                (implementation.lastRetryAt == null ||
                  implementation.lastRetryAt < turn.requestedAt) &&
                implementation.retryCount < MAX_AUTO_RETRY_ATTEMPTS
              ) {
                const expectedCommandId = commandId;
                yield* writeWorkflow(incrementImplementationRetryCount(failed, updatedAt));
                yield* awaitAutoRetrySettled(threadId).pipe(
                  Effect.andThen(
                    Effect.suspend(() =>
                      reconcileApplyReviews(workflowId, {
                        retry: "automatic",
                        expectedCommandId,
                      }),
                    ),
                  ),
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Apply Reviews automatic retry did not start", {
                      workflowId,
                      cause,
                    }),
                  ),
                  Effect.forkIn(sources.scope),
                );
                return result;
              }
              if (implementation.status !== "error") yield* writeWorkflow(failed);
              return result;
            }
          }

          if (options.session) return result;
          if (repairOnly && options.retry !== "manual") return result;
          if (options.expectedTurnId && !settledFailure && delivery) return result;
          if (delivery?.state === "pending" || delivery?.state === "sending") return result;
          if (implementation.status === "error" && !options.retry) return result;

          const marker = implementation.revisionCompaction;
          const outcome = options.compactionOutcome;
          if (outcome && outcome.requestId !== marker?.requestId) return result;
          if (marker && activeRevisionCompactions.has(marker.requestId) && !outcome) return result;
          const compactionReceipt =
            marker && commandReceipts._tag === "Some"
              ? yield* commandReceipts.value.getByCommandId({ commandId: marker.recordCommandId })
              : Option.none();
          const recoveredContext = Boolean(
            marker &&
            thread.compaction?.freshSessionRecordId === marker.recordCommandId &&
            (commandReceipts._tag === "None" ||
              (Option.isSome(compactionReceipt) && compactionReceipt.value.status === "accepted")),
          );
          if (
            marker &&
            !options.retry &&
            !recoveredContext &&
            outcome?.outcome.kind !== "busy" &&
            outcome?.outcome.kind !== "skipped"
          ) {
            return yield* fail(
              outcome && outcome.outcome.kind !== "committed"
                ? `Apply Reviews context recovery failed. ${outcome.outcome.detail}`
                : "Apply Reviews context recovery was interrupted before its result could be verified. Retry the step.",
            );
          }

          const terminal = delivery?.state === "rejected" || delivery?.state === "ambiguous";
          if (delivery?.state === "abandoned" && !options.retry)
            return yield* fail(
              "The Apply Reviews delivery was discarded. Retry the step to start a new turn.",
            );
          const ambiguous =
            delivery?.state === "ambiguous" ||
            (delivery?.state === "rejected" && delivery.certainty !== "not_sent");
          if (terminal) {
            if (!options.retry && !(marker && !ambiguous && (recoveredContext || outcome))) {
              return yield* fail(
                delivery?.errorDetail ?? "The provider could not accept the Apply Reviews turn.",
              );
            }
            if (ambiguous && !options.allowPossibleDuplicate) {
              return { status: "confirmation_required" as const, threadIds: [threadId] };
            }
          }

          let rejectedReceipt = false;
          if (commandId && !delivery && commandReceipts._tag === "Some") {
            const receipt = yield* commandReceipts.value.getByCommandId({ commandId });
            if (Option.isSome(receipt)) {
              rejectedReceipt = receipt.value.status === "rejected";
              if (rejectedReceipt && !options.retry) {
                return yield* fail(
                  receipt.value.error ?? "The Apply Reviews command was rejected.",
                );
              }
              // An accepted receipt with an unreadable/missing outbox is not a
              // license to create another turn.
              if (!rejectedReceipt) return result;
            }
          }

          if (!isSessionSettledForAutoRetry(thread) || thread.latestTurn?.state === "running") {
            if (options.retry) {
              return yield* Effect.fail(
                new Error("Wait for the active turn to settle before retrying Apply Reviews."),
              );
            }
            return result;
          }
          const branchChanged =
            implementation.branch !== undefined && implementation.branch !== thread.branch;
          const sameWorktreeRename =
            branchChanged &&
            implementation.worktreePath != null &&
            implementation.worktreePath === thread.worktreePath &&
            implementation.branch != null &&
            isTemporaryWorktreeBranch(implementation.branch) &&
            thread.branch != null &&
            (yield* orchestrationEngine
              .readEvents(0, { threadId, eventTypes: ["thread.meta-updated"] })
              .pipe(
                Stream.filter(
                  (event) =>
                    event.type === "thread.meta-updated" &&
                    event.payload.threadId === threadId &&
                    (event.payload.branch !== undefined ||
                      event.payload.worktreePath !== undefined),
                ),
                Stream.runLast,
                Effect.map(Option.getOrNull),
              ));
          const verifiedRename =
            sameWorktreeRename &&
            sameWorktreeRename.type === "thread.meta-updated" &&
            sameWorktreeRename.commandId?.startsWith("server:worktree-branch-rename:") &&
            sameWorktreeRename.payload.branch === thread.branch &&
            sameWorktreeRename.payload.worktreePath === thread.worktreePath;
          if (
            (implementation.worktreePath !== undefined &&
              implementation.worktreePath !== thread.worktreePath) ||
            (branchChanged && !verifiedRename)
          ) {
            return yield* fail(
              "The implementation checkout changed. Restore it before applying the saved reviews.",
            );
          }
          if (verifiedRename) {
            implementation = { ...implementation, branch: thread.branch };
            workflow = { ...workflow, implementation, updatedAt };
            yield* writeWorkflow(workflow);
          }
          const unresolved =
            providerTurnDeliveryRepository._tag === "Some"
              ? yield* providerTurnDeliveryRepository.value.getUnresolvedByThread(threadId)
              : null;
          if (unresolved && unresolved.deliveryId !== delivery?.deliveryId) {
            return yield* fail(
              "Resolve the competing provider delivery before retrying Apply Reviews.",
            );
          }

          const budgetError = workflowBudgetError(workflow);
          if (budgetError) return yield* fail(budgetError.message);
          const prepared = yield* prepareImplementationRevision(
            workflow,
            implementation,
            snapshot,
          ).pipe(
            Effect.match({ onSuccess: (value) => ({ value }), onFailure: (error) => ({ error }) }),
          );
          if ("error" in prepared) return yield* fail(prepared.error.message);
          const targetSlot = resolveAvailableWorkflowModelSlot(
            implementation.implementationSlot,
            yield* getWorkflowProviders,
          );
          const context = revisionContext(thread, targetSlot);
          const behavior = resolveWorkflowBehavior({
            runKind: "planning",
            templateId: workflow.templateId,
            templateVersion: workflow.templateVersion,
          });
          const artifactTokens = prepared.value.artifacts.reduce(
            (total, artifact) => total + roughTokenEstimateFromCharacters(artifact.length),
            0,
          );
          const fit = (contextUsageTokens: number) =>
            workflowPromptFit({
              ...prepared.value,
              ...context,
              contextUsageTokens,
              promptFramingTokens: Math.max(
                0,
                roughTokenEstimateFromCharacters(prepared.value.prompt.length) - artifactTokens,
              ),
              targetSlot,
              artifactLabel: "Implementation review feedback",
              enforceArtifactBudget: behavior.loudAuthoritativeArtifactLimit,
            });
          const freshFit = fit(0);
          if (freshFit.kind !== "fits") return yield* fail(freshFit.detail);
          const liveFit = fit(context.contextUsageTokens);

          const newAttempt =
            !commandId ||
            settledFailure ||
            rejectedReceipt ||
            delivery?.state === "abandoned" ||
            (options.retry === "manual" &&
              implementation.status === "error" &&
              marker != null &&
              !delivery &&
              !recoveredContext);
          const attempt = (implementation.revisionAttempt ?? 0) + (newAttempt ? 1 : 0);
          const dispatchId = newAttempt
            ? stableWorkflowCommandId("apply-reviews", workflow.id, attempt)
            : commandId!;
          const applyingWorkflow = markImplementationApplyingReviews(
            {
              ...workflow,
              implementation: {
                ...implementation,
                codeReviews: prepared.value.pinnedReviews,
                ...(repairOnly ? { revisionTurnId: null } : {}),
                revisionAttempt: attempt,
                revisionDispatchCommandId: dispatchId,
                ...(newAttempt ? { revisionCompaction: null } : {}),
                ...(options.retry === "manual" ? { retryCount: 0, lastRetryAt: null } : {}),
              },
            },
            updatedAt,
          );
          if (liveFit.kind !== "fits") {
            if (outcome && outcome.outcome.kind !== "committed") {
              return yield* fail(`${liveFit.detail} ${outcome.outcome.detail}`);
            }
            const retryRecovery = options.retry === "manual" && implementation.status === "error";
            if (
              compactionService._tag === "None" ||
              ambiguous ||
              (marker && !newAttempt && !retryRecovery)
            ) {
              return yield* fail(liveFit.detail);
            }
            const requestId = CommandId.makeUnsafe(timeOrderedUuid());
            const recordCommandId = stableWorkflowCommandId(
              "apply-reviews-compaction-record",
              workflow.id,
              requestId,
            );
            yield* writeWorkflow({
              ...applyingWorkflow,
              implementation: {
                ...applyingWorkflow.implementation!,
                revisionCompaction: { requestId, recordCommandId },
              },
            });
            activeRevisionCompactions.add(requestId);
            yield* compactionService.value
              .requestSummary({
                threadId,
                workflowId,
                attempt,
                dispatchCommandId: dispatchId,
                requestId,
                recordCommandId,
                targetSlot,
                contextWindowTokens: context.contextWindowTokens,
                interactionMode: behavior.interactionModeForStage("apply-feedback"),
                workflowExecutionProfile: behavior.executionProfileForStage("apply-feedback"),
                checkFit: (usage) => {
                  const restored = fit(usage);
                  return restored.kind === "fits" ? null : restored.detail;
                },
              })
              .pipe(
                Effect.flatMap((outcome) =>
                  reconcileApplyReviews(workflowId, {
                    expectedCommandId: dispatchId,
                    compactionOutcome: { requestId, outcome },
                  }),
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    activeRevisionCompactions.delete(requestId);
                  }),
                ),
                Effect.catchCause((cause) =>
                  Effect.logWarning("Could not reconcile Apply Reviews context recovery", {
                    workflowId,
                    requestId,
                    cause,
                  }),
                ),
                Effect.forkIn(sources.scope),
              );
            return result;
          }
          if (newAttempt || implementation.status !== "applying_reviews") {
            yield* writeWorkflow(applyingWorkflow);
          }

          const dispatch: Effect.Effect<void, Error> =
            terminal && delivery
              ? providerTurnDeliveryWorker._tag === "Some"
                ? providerTurnDeliveryWorker.value
                    .retry({
                      threadId,
                      deliveryId: delivery.deliveryId,
                      allowPossibleDuplicate: options.allowPossibleDuplicate ?? false,
                    })
                    .pipe(Effect.asVoid)
                : Effect.fail(new Error("The provider delivery worker is unavailable."))
              : orchestrationEngine
                  .dispatch({
                    type: "thread.turn.start",
                    commandId: dispatchId,
                    threadId,
                    message: {
                      messageId: MessageId.makeUnsafe(
                        stableWorkflowUuid("apply-reviews-message", workflow.id, attempt),
                      ),
                      role: "user",
                      text: prepared.value.prompt,
                      attachments: [],
                    },
                    ...workflowTurnProviderFields(targetSlot),
                    titleSourceText: workflow.title,
                    runtimeMode: implementation.runtimeMode ?? DEFAULT_RUNTIME_MODE,
                    ...workflowTurnBehaviorFields({
                      runKind: "planning",
                      templateId: workflow.templateId,
                      templateVersion: workflow.templateVersion,
                      stage: "apply-feedback",
                    }),
                    createdAt: newAttempt ? updatedAt : implementation.updatedAt,
                  })
                  .pipe(Effect.asVoid);
          yield* dispatch.pipe(
            Effect.catch((error) =>
              writeWorkflow(
                markImplementationError(
                  applyingWorkflow,
                  `Apply Reviews dispatch failed: ${error.message}`,
                  updatedAt,
                  "apply-feedback",
                ),
              ).pipe(Effect.asVoid),
            ),
          );
          return result;
        }),
      );
    }).pipe(
      Effect.mapError((error) => (error instanceof Error ? error : new Error(String(error)))),
    );

  const maybeAdvanceImplementationLifecycle = (
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
    threadId: ThreadId,
    updatedAt: string,
  ) =>
    Effect.gen(function* () {
      if (!workflow.implementation) {
        return workflow;
      }

      if (threadId === workflow.implementation.threadId && isApplyReviewsLifecycle(workflow)) {
        return workflow;
      }
      const thread = snapshot.threads.find((entry) => entry.id === threadId);
      const completedTurn =
        threadId === workflow.implementation.threadId
          ? getFinishedConsumableLatestTurn(thread)
          : getFinishedConsumableTurn(thread, thread?.latestTurn);
      if (!completedTurn) {
        return workflow;
      }

      let nextWorkflow = workflow;
      if (threadId === workflow.implementation.threadId) {
        const failedCodeReviews = workflow.implementation.codeReviews.some(
          (review) => review.status === "error",
        );
        const completionEvidenceAt =
          thread?.latestTurn?.completedAt ?? thread?.latestTurn?.requestedAt ?? null;
        const recoveredStatus =
          workflow.implementation.status === "error" &&
          !failedCodeReviews &&
          completionEvidenceAt &&
          completionEvidenceAt >= workflow.implementation.updatedAt
            ? "implementing"
            : workflow.implementation.status;
        nextWorkflow =
          recoveredStatus === "implementing"
            ? markImplementationDone(workflow, completedTurn.turnId, updatedAt)
            : workflow;
      } else {
        const review = workflow.implementation.codeReviews.find(
          (entry) => entry.threadId === threadId,
        );
        const completionEvidenceAt =
          thread?.latestTurn?.completedAt ?? thread?.latestTurn?.requestedAt ?? null;
        nextWorkflow =
          review?.status === "running" ||
          (review?.status === "error" &&
            completionEvidenceAt !== null &&
            completionEvidenceAt >= review.updatedAt)
            ? markCodeReviewCompleted(workflow, threadId, completedTurn, updatedAt)
            : workflow;
      }

      if (nextWorkflow !== workflow) {
        yield* upsertWorkflow(nextWorkflow);
      }

      return nextWorkflow;
    });

  const maybeContinueImplementationLifecycle = (
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
    updatedAt: string,
  ) =>
    Effect.gen(function* () {
      if (isArchivedWorkflow(workflow)) {
        if (
          workflow.implementation?.status === "implemented" &&
          !workflow.implementation.codeReviewEnabled
        )
          yield* upsertWorkflow(markImplementationCompleted(workflow, null, updatedAt));
        return;
      }
      if (!workflow.implementation) {
        return;
      }

      if (
        workflow.implementation.status === "not_started" ||
        (workflow.implementation.status === "error" &&
          workflow.implementation.errorStage === "implementation-start")
      ) {
        yield* resumeImplementationStart(workflow, snapshot, updatedAt);
        return;
      }

      if (
        workflow.implementation.status === "code_reviews_requested" ||
        (workflow.implementation.status === "error" &&
          workflow.implementation.errorStage === "review-setup")
      ) {
        const resumableWorkflow: PlanningWorkflow =
          workflow.implementation.status === "error"
            ? {
                ...workflow,
                implementation: {
                  ...workflow.implementation,
                  status: "implemented",
                  error: null,
                  errorStage: null,
                  updatedAt,
                },
                updatedAt,
              }
            : workflow;
        yield* maybeStartCodeReviews(resumableWorkflow, snapshot, updatedAt);
        return;
      }

      if (workflow.implementation.status === "implemented") {
        yield* maybeStartCodeReviews(workflow, snapshot, updatedAt);
        return;
      }

      if (workflow.implementation.status === "code_reviews_saved") {
        yield* reconcileApplyReviews(workflow.id);
      }
    });

  function resumeImplementationStart(
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
    updatedAt: string,
  ) {
    return Effect.gen(function* () {
      const implementation = workflow.implementation;
      if (
        !implementation ||
        (implementation.status !== "not_started" &&
          !(
            implementation.status === "error" &&
            implementation.errorStage === "implementation-start"
          ))
      ) {
        return workflow;
      }
      if (!implementation.threadId) {
        return yield* Effect.fail(
          new Error("Implementation thread intent is missing its thread ID."),
        );
      }
      const budgetError = workflowBudgetError(workflow);
      if (budgetError) return yield* budgetError;

      const mergeThread = snapshot.threads.find((thread) => thread.id === workflow.merge.threadId);
      const mergedPlan = mergeThread ? resolveApprovedMergedPlan(workflow, mergeThread) : null;
      if (!mergeThread || !mergedPlan?.planMarkdown) {
        return yield* Effect.fail(
          new Error("Approved merged plan is unavailable for implementation."),
        );
      }

      const prompt = buildImplementationPrompt({
        workflow,
        mergedPlanMarkdown: mergedPlan.planMarkdown,
        implementationSlot: implementation.implementationSlot,
      });
      const promptError = workflowPromptInvariant({
        workflow,
        prompt,
        artifacts: [mergedPlan.planMarkdown],
        targetSlot: implementation.implementationSlot,
        artifactLabel: "Approved implementation plan",
      });
      if (promptError) return yield* promptError;

      let implementationThread = snapshot.threads.find(
        (thread) => thread.id === implementation.threadId,
      );
      if (!implementationThread) {
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(timeOrderedUuid()),
          threadId: implementation.threadId,
          projectId: workflow.projectId,
          title: "Implementation",
          model: implementation.implementationSlot.model,
          runtimeMode: implementation.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: implementation.branch ?? null,
          worktreePath: implementation.worktreePath ?? null,
          threadReferences: [
            {
              relation: "source",
              threadId: mergeThread.id,
              createdAt: updatedAt,
            },
          ],
          createdAt: updatedAt,
        });
        const refreshed = yield* orchestrationEngine.getReadModel();
        implementationThread = refreshed.threads.find(
          (thread) => thread.id === implementation.threadId,
        );
      }

      const behavior = resolveWorkflowBehavior({
        runKind: "planning",
        templateId: workflow.templateId,
        templateVersion: workflow.templateVersion,
      });
      const existingDelivery = behavior.idempotentStageSetup
        ? yield* deliveryForStage(implementation.threadId, implementation.updatedAt)
        : null;
      const deliveryError = ensureDeliveryCanResume(existingDelivery, "Implementation");
      if (deliveryError) return yield* Effect.fail(deliveryError);

      if (!implementationThread?.latestTurn && !existingDelivery) {
        yield* orchestrationEngine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(timeOrderedUuid()),
          threadId: implementation.threadId,
          message: {
            messageId: MessageId.makeUnsafe(crypto.randomUUID()),
            role: "user",
            text: prompt,
            attachments: [],
          },
          ...workflowTurnProviderFields(implementation.implementationSlot),
          titleSourceText: workflow.title,
          runtimeMode: implementation.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          sourceProposedPlan: {
            threadId: mergeThread.id,
            planId: mergedPlan.id,
          },
          createdAt: updatedAt,
        });
      }

      const startedWorkflow: PlanningWorkflow = {
        ...workflow,
        implementation: {
          ...implementation,
          status: "implementing",
          error: null,
          errorStage: null,
          updatedAt,
        },
        updatedAt,
      };
      yield* upsertWorkflow(startedWorkflow);
      return startedWorkflow;
    }).pipe(
      Effect.catchCause((cause) =>
        upsertWorkflow(
          markImplementationError(
            workflow,
            `Implementation setup failed: ${String(cause)}`,
            updatedAt,
            "implementation-start",
          ),
        ).pipe(Effect.andThen(Effect.failCause(cause))),
      ),
    );
  }

  const retryImplementationTurn = (input: {
    readonly workflow: PlanningWorkflow;
    readonly thread: OrchestrationReadModel["threads"][number];
    readonly createdAt: string;
  }) =>
    Effect.gen(function* () {
      if (!input.workflow.implementation) {
        return yield* Effect.die(new Error("Workflow implementation not found for retry."));
      }
      const budgetError = workflowBudgetError(input.workflow);
      if (budgetError) return yield* Effect.fail(new Error(budgetError.message));

      const latestUserMessage = input.thread.messages
        .toReversed()
        .find((message) => message.role === "user" && !message.streaming);
      if (!latestUserMessage) {
        return yield* Effect.die(
          new Error(`Implementation retry message not found for thread '${input.thread.id}'.`),
        );
      }

      return yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe(timeOrderedUuid()),
        threadId: input.thread.id,
        message: {
          messageId: MessageId.makeUnsafe(crypto.randomUUID()),
          role: "user",
          text: latestUserMessage.text,
          attachments: latestUserMessage.attachments ?? [],
        },
        ...workflowTurnProviderFields(input.workflow.implementation.implementationSlot),
        titleSourceText: input.workflow.title,
        runtimeMode: input.thread.runtimeMode,
        interactionMode: input.thread.interactionMode,
        createdAt: input.createdAt,
      });
    });

  const reconcileWorkflowImplementationLifecycle = (
    workflow: PlanningWorkflow,
    snapshot: OrchestrationReadModel,
    deferApplyReviews = false,
  ) =>
    Effect.gen(function* () {
      if (isDeletedWorkflow(workflow) || !workflow.implementation) {
        return;
      }

      const updatedAt = new Date().toISOString();
      let reconciledWorkflow = workflow.implementation.threadId
        ? yield* maybeAdvanceImplementationLifecycle(
            workflow,
            snapshot,
            workflow.implementation.threadId,
            updatedAt,
          )
        : workflow;

      for (const review of reconciledWorkflow.implementation?.codeReviews ?? []) {
        if (review.status !== "running") {
          continue;
        }
        reconciledWorkflow = yield* maybeAdvanceImplementationLifecycle(
          reconciledWorkflow,
          snapshot,
          review.threadId,
          updatedAt,
        );
      }

      if (!deferApplyReviews || !isApplyReviewsLifecycle(reconciledWorkflow)) {
        yield* maybeContinueImplementationLifecycle(reconciledWorkflow, snapshot, updatedAt);
      }
    });

  const reconcileWorkflowImplementationLifecycles = Effect.gen(function* () {
    const snapshot = yield* orchestrationEngine.getReadModel();
    yield* Effect.forEach(snapshot.planningWorkflows, (workflow) =>
      reconcileWorkflowImplementationLifecycle(workflow, snapshot, true).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("WorkflowService.reconcileWorkflowImplementationLifecycle failed", {
            workflowId: workflow.id,
            cause,
          }),
        ),
      ),
    );
  });

  const reconcileStuckWorkflow = (workflow: PlanningWorkflow, snapshot: OrchestrationReadModel) =>
    Effect.gen(function* () {
      if (isDeletedWorkflow(workflow) || isArchivedWorkflow(workflow)) {
        return;
      }

      const updatedAt = new Date().toISOString();
      let reconciledWorkflow = workflow;
      let latestSnapshot = snapshot;
      const legacyReviewErrors = new Map<WorkflowBranchId, string>();

      for (const branchId of planningBranchIds(workflow)) {
        const branch = requirePlanningBranch(reconciledWorkflow, branchId);
        if (branch.status !== "error" || branch.errorStage !== null) {
          continue;
        }
        const legacyStage = planningWorkflowBranchFailureStage(branch);
        if (legacyStage === "reviews" && branch.error) {
          legacyReviewErrors.set(branchId, branch.error);
          continue;
        }
        const repairedBranch: WorkflowBranch = {
          ...branch,
          errorStage: legacyStage === "revision" ? "revision" : "authoring",
          updatedAt,
        };
        reconciledWorkflow = {
          ...updatePlanningBranch(reconciledWorkflow, branchId, () => repairedBranch),
          updatedAt,
        };
      }
      // A revision recorded as a fresh draft leaves `plan_saved` with completed
      // reviews of an earlier draft, which no lifecycle step can advance.
      for (const branchId of planningBranchIds(workflow)) {
        const branch = requirePlanningBranch(reconciledWorkflow, branchId);
        if (
          branch.status !== "plan_saved" ||
          branch.reviews.length === 0 ||
          !branch.reviews.every((review) => review.status === "completed")
        ) {
          continue;
        }
        const reviewedTurnId = reviewedPlanTurnIdForBranch(
          reconciledWorkflow,
          branchId,
          branch,
          snapshot,
        );
        if (!reviewedTurnId || reviewedTurnId === branch.planTurnId) {
          continue;
        }
        const authorThread = snapshot.threads.find((entry) => entry.id === branch.authorThreadId);
        if (
          !branch.planTurnId ||
          !authorThread?.proposedPlans.some((plan) => plan.turnId === branch.planTurnId)
        ) {
          yield* Effect.logWarning("workflow revision recorded as draft could not be repaired", {
            workflowId: workflow.id,
            branchId,
            reviewedTurnId,
            planTurnId: branch.planTurnId,
          });
          continue;
        }
        const repairedBranch: WorkflowBranch = {
          ...branch,
          status: "revised",
          planTurnId: reviewedTurnId,
          revisionTurnId: branch.planTurnId,
          error: null,
          errorStage: null,
          updatedAt,
        };
        reconciledWorkflow = {
          ...updatePlanningBranch(reconciledWorkflow, branchId, () => repairedBranch),
          updatedAt,
        };
      }
      if (reconciledWorkflow !== workflow) {
        yield* upsertWorkflow(reconciledWorkflow);
      }

      const refreshWorkflowFromSnapshot = Effect.gen(function* () {
        latestSnapshot = yield* orchestrationEngine.getReadModel();
        reconciledWorkflow =
          latestSnapshot.planningWorkflows.find((entry) => entry.id === workflow.id) ??
          reconciledWorkflow;
      });

      const reconcilePendingBranch = (branchId: WorkflowBranchId) =>
        Effect.gen(function* () {
          const branch = requirePlanningBranch(reconciledWorkflow, branchId);
          if (branch.status !== "pending") {
            return;
          }

          const outcome = yield* startAuthoringTurn({
            orchestrationEngine,
            workflow: reconciledWorkflow,
            branch,
            createdAt: updatedAt,
          }).pipe(
            Effect.match({
              onFailure: (error) => ({ ok: false as const, error: String(error) }),
              onSuccess: () => ({ ok: true as const }),
            }),
          );

          reconciledWorkflow = updateAuthoringBranch(
            reconciledWorkflow,
            branchId,
            updatedAt,
            outcome,
          );
          yield* upsertWorkflow(reconciledWorkflow);
        });

      for (const branchId of planningBranchIds(reconciledWorkflow)) {
        yield* reconcilePendingBranch(branchId);
      }
      yield* refreshWorkflowFromSnapshot;

      const lifecycleThreadIds = [
        ...planningBranches(reconciledWorkflow).map((branch) => branch.authorThreadId),
        ...planningBranches(reconciledWorkflow).flatMap((branch) =>
          branch.reviews.map((review) => review.threadId),
        ),
        ...(reconciledWorkflow.merge.threadId ? [reconciledWorkflow.merge.threadId] : []),
        ...(reconciledWorkflow.readerPass ? [reconciledWorkflow.readerPass.readerThreadId] : []),
      ];
      for (const threadId of lifecycleThreadIds) {
        const nextWorkflow = yield* maybeAdvancePlanningWorkflowFromCompletedThread(
          reconciledWorkflow,
          latestSnapshot,
          threadId,
          updatedAt,
        );
        if (nextWorkflow !== reconciledWorkflow) {
          reconciledWorkflow = nextWorkflow;
          yield* refreshWorkflowFromSnapshot;
        }
      }

      for (const [branchId, legacyError] of legacyReviewErrors) {
        const branch = requirePlanningBranch(reconciledWorkflow, branchId);
        if (branch.reviews.length === 0) {
          const repairedBranch: WorkflowBranch = {
            ...branch,
            status: "plan_saved",
            error: null,
            errorStage: null,
            updatedAt,
          };
          reconciledWorkflow = {
            ...updatePlanningBranch(reconciledWorkflow, branchId, () => repairedBranch),
            updatedAt,
          };
          // Saved now: the review launcher reads the stored record.
          yield* upsertWorkflow(reconciledWorkflow);
          continue;
        }
        if (branch.reviews.every((review) => review.status === "completed")) {
          continue;
        }
        const repairedBranch: WorkflowBranch = {
          ...branch,
          reviews: branch.reviews.map((review) => {
            if (review.status === "completed") {
              return review;
            }
            const reviewThread = latestSnapshot.threads.find(
              (thread) => thread.id === review.threadId,
            );
            const sessionError = reviewThread?.session?.lastError
              ? formatSessionError(reviewThread.session, "Review failed.")
              : null;
            return {
              ...review,
              status: "error" as const,
              error: review.error ?? sessionError ?? legacyError,
              updatedAt,
            };
          }),
          status: "reviews_requested",
          error: null,
          errorStage: null,
          updatedAt,
        };
        reconciledWorkflow = {
          ...updatePlanningBranch(reconciledWorkflow, branchId, () => repairedBranch),
          updatedAt,
        };
        yield* upsertWorkflow(reconciledWorkflow);
      }

      const dispatchedRevisions = yield* maybeContinuePlanningWorkflowLifecycle(
        reconciledWorkflow,
        latestSnapshot,
        updatedAt,
      );
      yield* refreshWorkflowFromSnapshot;

      const readerPass = reconciledWorkflow.readerPass;
      if (
        readerPass &&
        (readerPass.status === "reader_running" || readerPass.status === "polishing")
      ) {
        const stage = readerPass.status === "reader_running" ? "reader" : "polish";
        const thread = latestSnapshot.threads.find(
          (entry) =>
            entry.id ===
            (stage === "reader" ? readerPass.readerThreadId : reconciledWorkflow.merge.threadId),
        );
        // Only audit a stage that was already running when reconciliation began.
        if (
          workflow.readerPass?.status === readerPass.status &&
          isSessionUnavailableForReconciliation(thread)
        ) {
          reconciledWorkflow = markReaderPassError(
            reconciledWorkflow,
            stage,
            `${stage === "reader" ? "Reader review" : "Polish"} session is unavailable; retry the failed stage.`,
            updatedAt,
          );
          yield* upsertWorkflow(reconciledWorkflow);
        }
      }

      let freedReviewSlots = false;
      for (const branchId of planningBranchIds(workflow)) {
        const branch = requirePlanningBranch(reconciledWorkflow, branchId);
        const baselineBranch = requirePlanningBranch(workflow, branchId);
        const authorThread = latestSnapshot.threads.find(
          (thread) => thread.id === branch.authorThreadId,
        );
        const startedBranchThisPass =
          dispatchedRevisions?.has(branch.authorThreadId) ||
          (baselineBranch.status !== branch.status &&
            (branch.status === "authoring" || branch.status === "revising"));
        if (
          (branch.status === "authoring" || branch.status === "revising") &&
          !startedBranchThisPass &&
          isSessionUnavailableForReconciliation(authorThread)
        ) {
          reconciledWorkflow = markBranchError(reconciledWorkflow, branchId, {
            error:
              branch.error ??
              (authorThread?.session?.lastError
                ? formatSessionError(
                    authorThread.session,
                    branch.status === "revising"
                      ? "Revision session was not running during reconciliation."
                      : "Authoring session was not running during reconciliation.",
                  )
                : branch.status === "revising"
                  ? "Revision session was not running during reconciliation."
                  : "Authoring session was not running during reconciliation."),
            stage: branch.status === "revising" ? "revision" : "authoring",
            updatedAt,
          });
          yield* upsertWorkflow(reconciledWorkflow);
          continue;
        }

        for (const review of branch.reviews) {
          if (review.status !== "running") {
            continue;
          }
          const baselineReview = baselineBranch.reviews.find(
            (entry) => entry.threadId === review.threadId,
          );
          // Includes a running review startup re-dispatched (a restart mid-launch): its session
          // may not be projected yet.
          const startedReviewThisPass =
            ((baselineReview?.status ?? null) !== "running" && review.status === "running") ||
            dispatchedRevisions?.has(review.threadId) === true;
          const reviewThread = latestSnapshot.threads.find(
            (thread) => thread.id === review.threadId,
          );
          if (!startedReviewThisPass && isSessionUnavailableForReconciliation(reviewThread)) {
            const error =
              review.error ??
              (reviewThread?.session?.lastError
                ? formatSessionError(
                    reviewThread.session,
                    "Review session was not running during reconciliation.",
                  )
                : (legacyReviewErrors.get(branchId) ??
                  "Review session was not running during reconciliation."));
            reconciledWorkflow = markPlanningReviewError(
              reconciledWorkflow,
              branchId,
              review.threadId,
              error,
              updatedAt,
            );
            yield* upsertWorkflow(reconciledWorkflow);
            freedReviewSlots = true;
          }
        }
      }
      // The launcher above counted these lost reviews as in flight; their slots are free now.
      if (freedReviewSlots) {
        yield* refreshWorkflowFromSnapshot;
        yield* maybeStartReviews(reconciledWorkflow, latestSnapshot, updatedAt);
        yield* refreshWorkflowFromSnapshot;
      }

      const startedMergeThisPass =
        workflow.merge.status !== "in_progress" &&
        reconciledWorkflow.merge.status === "in_progress";
      if (reconciledWorkflow.merge.status === "in_progress" && !startedMergeThisPass) {
        const mergeThread = reconciledWorkflow.merge.threadId
          ? latestSnapshot.threads.find((thread) => thread.id === reconciledWorkflow.merge.threadId)
          : null;
        if (isSessionUnavailableForReconciliation(mergeThread)) {
          reconciledWorkflow = markMergeError(
            reconciledWorkflow,
            "Merge session was not running during reconciliation.",
            updatedAt,
          );
          yield* upsertWorkflow(reconciledWorkflow);
        }
      }

      if (reconciledWorkflow.implementation?.status === "implementing") {
        const implementationThread = reconciledWorkflow.implementation.threadId
          ? latestSnapshot.threads.find(
              (thread) => thread.id === reconciledWorkflow.implementation?.threadId,
            )
          : null;
        if (
          isSessionUnavailableForReconciliation(implementationThread, {
            allowCompletedTurn: true,
          })
        ) {
          reconciledWorkflow = markImplementationError(
            reconciledWorkflow,
            "Implementation session was not running during reconciliation.",
            updatedAt,
          );
          yield* upsertWorkflow(reconciledWorkflow);
        }
      }

      for (const review of reconciledWorkflow.implementation?.codeReviews ?? []) {
        if (review.status !== "running") {
          continue;
        }
        const codeReviewThread = latestSnapshot.threads.find(
          (thread) => thread.id === review.threadId,
        );
        if (
          isSessionUnavailableForReconciliation(codeReviewThread, {
            allowCompletedTurn: true,
          })
        ) {
          reconciledWorkflow = markCodeReviewError(
            reconciledWorkflow,
            review.threadId,
            "Code review session was not running during reconciliation.",
            updatedAt,
          );
          yield* upsertWorkflow(reconciledWorkflow);
          break;
        }
      }
    });

  const reconcileStuckWorkflows = Effect.gen(function* () {
    const snapshot = yield* orchestrationEngine.getReadModel();
    yield* Effect.forEach(snapshot.planningWorkflows, (workflow) =>
      reconcileStuckWorkflow(workflow, snapshot).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("WorkflowService.reconcileStuckWorkflow failed", {
            workflowId: workflow.id,
            cause,
          }),
        ),
      ),
    );
  });

  const handleDomainEvent = (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      // Partial messages cannot complete a stage. Avoid snapshot and delivery reads
      // for token deltas across all threads, including unrelated workflows.
      if (
        event.type === "thread.message-sent" &&
        (event.payload.streaming || event.payload.role !== "assistant")
      )
        return;
      // Reader and polish share the normal event stream, but own their completion pins.
      if (
        [
          "thread.proposed-plan-upserted",
          "thread.turn-diff-completed",
          "thread.turn-processing-quiesced",
          "thread.message-sent",
          "thread.session-set",
        ].includes(event.type) &&
        "threadId" in event.payload
      ) {
        const snapshot = yield* orchestrationEngine.getReadModel();
        const threadId = event.payload.threadId as ThreadId;
        const applying = workflowForImplementationThread(
          snapshot.planningWorkflows,
          threadId,
        )?.workflow;
        if (applying && isApplyReviewsLifecycle(applying)) {
          if (event.type === "thread.session-set") {
            yield* reconcileApplyReviews(applying.id, { session: event.payload.session });
            if (
              event.payload.session.status === "ready" ||
              event.payload.session.status === "stopped"
            )
              yield* reconcileApplyReviews(applying.id, { preflightOnly: true });
          } else if (
            event.type === "thread.turn-diff-completed" ||
            event.type === "thread.turn-processing-quiesced" ||
            event.type === "thread.message-sent"
          ) {
            if (event.payload.turnId) {
              yield* reconcileApplyReviews(applying.id, { expectedTurnId: event.payload.turnId });
            }
          }
          return;
        }
        const document = documentWorkflowForThread(snapshot.planningWorkflows, threadId);
        if (
          document &&
          (document.readerPass?.readerThreadId === threadId || document.merge.threadId === threadId)
        ) {
          let current = document;
          if (event.type === "thread.session-set") {
            if (
              current.merge.status === "merged" ||
              current.readerPass?.readerThreadId === threadId ||
              (current.merge.status === "manual_review" && event.payload.session.status === "error")
            ) {
              current = yield* recordWorkflowTurnCost(
                current,
                event.payload.session.turnCostUsd,
                event.occurredAt,
              );
            }
            if (
              event.payload.session.status === "error" &&
              current.merge.status === "merged" &&
              current.readerPass
            ) {
              const stage = threadId === current.readerPass.readerThreadId ? "reader" : "polish";
              if (stage === "polish" && current.readerPass.status !== "polishing") return;
              if (
                stage === "reader" &&
                !["reader_requested", "reader_running", "error"].includes(current.readerPass.status)
              )
                return;
              const failed = markReaderPassError(
                current,
                stage,
                formatSessionError(event.payload.session, `${stage} failed.`),
                event.occurredAt,
              );
              yield* upsertWorkflow(failed);
              if (
                stage === "reader" &&
                current.readerPass.status === "reader_running" &&
                current.readerPass.readerStartedAt !== null &&
                snapshot.threads.find((thread) => thread.id === threadId)?.latestTurn?.state ===
                  "error" &&
                (snapshot.threads.find((thread) => thread.id === threadId)?.latestTurn
                  ?.requestedAt ?? "") >= current.readerPass.readerStartedAt &&
                isRetryableSessionError(event.payload.session) &&
                current.readerPass.retryCount < MAX_AUTO_RETRY_ATTEMPTS
              ) {
                const count = current.readerPass.retryCount + 1;
                const retrying = {
                  ...failed,
                  readerPass: {
                    ...failed.readerPass!,
                    retryCount: count,
                    lastRetryAt: event.occurredAt,
                  },
                };
                yield* upsertWorkflow(retrying);
                yield* forkAutoRetry({
                  kind: "document_reader",
                  workflowId: current.id,
                  threadId,
                  buildDispatch: ({ workflow, snapshot: retrySnapshot }) => {
                    if (
                      workflow.readerPass?.status !== "error" ||
                      workflow.readerPass.errorStage !== "reader" ||
                      workflow.readerPass.retryCount !== count ||
                      hasRunningSessionTurn(
                        retrySnapshot.threads.find((entry) => entry.id === threadId),
                      )
                    )
                      return null;
                    return Effect.gen(function* () {
                      const now = new Date().toISOString();
                      const running = markReaderRunning(workflow, now);
                      yield* upsertWorkflow(running);
                      yield* dispatchDocumentReaderStage(
                        running,
                        retrySnapshot,
                        "reader",
                        now,
                      ).pipe(
                        Effect.catch((error) =>
                          upsertWorkflow(
                            markReaderPassError(running, "reader", String(error), now),
                          ).pipe(Effect.asVoid),
                        ),
                      );
                    });
                  },
                });
              }
              return;
            }
            if (
              event.payload.session.status === "error" &&
              current.merge.status === "manual_review"
            )
              return;
          }
          if (current.merge.status === "merged") {
            const expectedTurnId =
              event.type === "thread.proposed-plan-upserted"
                ? event.payload.proposedPlan.turnId
                : "turnId" in event.payload
                  ? (event.payload.turnId as TurnId | null)
                  : undefined;
            current = yield* maybeAdvanceDocumentReaderPass(
              current,
              snapshot,
              threadId,
              event.occurredAt,
              expectedTurnId,
            );
            yield* maybeContinueDocumentReaderPass(current);
            return;
          }
          if (
            event.type === "thread.turn-processing-quiesced" &&
            current.merge.status === "manual_review" &&
            current.merge.threadId === threadId &&
            current.implementation === null &&
            event.payload.turnId !== current.merge.turnId
          ) {
            const thread = snapshot.threads.find((entry) => entry.id === threadId);
            if (thread && !hasProposedPlanForTurn(thread, event.payload.turnId))
              yield* maybeSynthesizeProposedPlan({
                workflow: current,
                provider: current.merge.mergeSlot.provider,
                thread,
                turnId: event.payload.turnId,
                createdAt: event.occurredAt,
                validate: (markdown) =>
                  validateDocumentArtifact(
                    markdown,
                    planningWorkflowDocumentType(current)!,
                    "replacement",
                  ),
              });
          }
        }
      }
      switch (event.type) {
        case "thread.proposed-plan-upserted": {
          const readModel = yield* orchestrationEngine.getReadModel();
          const planningWorkflow =
            workflowForAuthorThread(readModel.planningWorkflows, event.payload.threadId)
              ?.workflow ??
            workflowForMergeThread(readModel.planningWorkflows, event.payload.threadId)?.workflow ??
            null;
          if (!planningWorkflow) {
            return;
          }

          const nextWorkflow = yield* maybeAdvancePlanningWorkflowFromCompletedThread(
            planningWorkflow,
            readModel,
            event.payload.threadId,
            event.occurredAt,
            { expectedTurnId: event.payload.proposedPlan.turnId },
          );
          const lifecycleSnapshot =
            nextWorkflow !== planningWorkflow
              ? yield* orchestrationEngine.getReadModel()
              : readModel;
          yield* maybeContinuePlanningWorkflowLifecycle(
            nextWorkflow,
            lifecycleSnapshot,
            event.occurredAt,
          );
          if (
            nextWorkflow.merge.threadId === event.payload.threadId &&
            nextWorkflow.merge.status === "manual_review" &&
            nextWorkflow.implementation === null &&
            event.payload.proposedPlan.implementedAt === null &&
            (!isDocumentWorkflow(nextWorkflow) ||
              validateDocumentArtifact(
                event.payload.proposedPlan.planMarkdown,
                planningWorkflowDocumentType(nextWorkflow)!,
                "replacement",
              ).valid)
          ) {
            yield* upsertWorkflow(
              repinManualReviewApprovedPlan(nextWorkflow, {
                proposedPlanId: event.payload.proposedPlan.id,
                turnId: event.payload.proposedPlan.turnId,
                updatedAt: event.occurredAt,
              }),
            );
          }
          return;
        }

        case "thread.turn-diff-completed": {
          const readModel = yield* orchestrationEngine.getReadModel();
          const implementationMatch = workflowForImplementationThread(
            readModel.planningWorkflows,
            event.payload.threadId,
          );
          if (
            implementationMatch?.workflow.implementation?.status === "implemented" &&
            implementationMatch.workflow.implementation.implementationTurnId ===
              event.payload.turnId
          ) {
            yield* maybeContinueImplementationLifecycle(
              implementationMatch.workflow,
              readModel,
              event.occurredAt,
            );
            return;
          }
          const match = workflowForReviewThread(
            readModel.planningWorkflows,
            event.payload.threadId,
          );
          if (match) {
            const nextWorkflow = yield* maybeAdvancePlanningWorkflowFromCompletedThread(
              match.workflow,
              readModel,
              event.payload.threadId,
              event.occurredAt,
            );
            const lifecycleSnapshot =
              nextWorkflow !== match.workflow
                ? yield* orchestrationEngine.getReadModel()
                : readModel;
            yield* maybeContinuePlanningWorkflowLifecycle(
              nextWorkflow,
              lifecycleSnapshot,
              event.occurredAt,
            );
            return;
          }

          const authorMatch = workflowForAuthorThread(
            readModel.planningWorkflows,
            event.payload.threadId,
          );
          if (authorMatch) {
            const authorThread = readModel.threads.find(
              (thread) => thread.id === event.payload.threadId,
            );
            const branch = requirePlanningBranch(authorMatch.workflow, authorMatch.branchId);
            const canAdvanceAuthor =
              branch.status === "authoring" ||
              branch.status === "revising" ||
              (branch.status === "revised" && authorMatch.workflow.merge.status === "not_started");
            if (authorThread && canAdvanceAuthor) {
              const synthesized = yield* maybeSynthesizeProposedPlan({
                workflow: authorMatch.workflow,
                provider: branch.authorSlot.provider,
                thread: authorThread,
                turnId: event.payload.turnId,
                createdAt: event.occurredAt,
                // An over-long reply is left unsaved; the capture below repairs it.
                budget: { branchId: authorMatch.branchId },
              });
              const nextReadModel = synthesized
                ? yield* orchestrationEngine.getReadModel()
                : readModel;
              const nextAuthorMatch =
                workflowForAuthorThread(nextReadModel.planningWorkflows, event.payload.threadId) ??
                authorMatch;
              const nextWorkflow = yield* maybeAdvancePlanningWorkflowFromCompletedThread(
                nextAuthorMatch.workflow,
                nextReadModel,
                event.payload.threadId,
                event.occurredAt,
                { expectedTurnId: event.payload.turnId },
              );
              const lifecycleSnapshot =
                nextWorkflow !== nextAuthorMatch.workflow
                  ? yield* orchestrationEngine.getReadModel()
                  : nextReadModel;
              yield* maybeContinuePlanningWorkflowLifecycle(
                nextWorkflow,
                lifecycleSnapshot,
                event.occurredAt,
              );
            }
            return;
          }

          const mergeWorkflow = readModel.planningWorkflows.find(
            (workflow) =>
              !isDeletedWorkflow(workflow) &&
              workflow.merge.threadId === event.payload.threadId &&
              workflow.merge.status === "in_progress",
          );
          if (!mergeWorkflow) {
            return;
          }

          const mergeThread = readModel.threads.find(
            (thread) => thread.id === event.payload.threadId,
          );
          if (!mergeThread) {
            return;
          }

          const synthesized = yield* maybeSynthesizeProposedPlan({
            workflow: mergeWorkflow,
            provider: mergeWorkflow.merge.mergeSlot.provider,
            thread: mergeThread,
            turnId: event.payload.turnId,
            createdAt: event.occurredAt,
          });
          const nextReadModel = synthesized ? yield* orchestrationEngine.getReadModel() : readModel;
          const nextMergeWorkflow =
            workflowForMergeThread(nextReadModel.planningWorkflows, event.payload.threadId)
              ?.workflow ?? mergeWorkflow;
          const nextWorkflow = yield* maybeAdvancePlanningWorkflowFromCompletedThread(
            nextMergeWorkflow,
            nextReadModel,
            event.payload.threadId,
            event.occurredAt,
            { expectedTurnId: event.payload.turnId },
          );
          const lifecycleSnapshot =
            nextWorkflow !== nextMergeWorkflow
              ? yield* orchestrationEngine.getReadModel()
              : nextReadModel;
          yield* maybeContinuePlanningWorkflowLifecycle(
            nextWorkflow,
            lifecycleSnapshot,
            event.occurredAt,
          );
          return;
        }

        case "thread.turn-processing-quiesced": {
          const readModel = yield* orchestrationEngine.getReadModel();
          const implementationMatch = workflowForImplementationThread(
            readModel.planningWorkflows,
            event.payload.threadId,
          );
          if (
            implementationMatch?.workflow.implementation &&
            implementationMatch.workflow.implementation.implementationTurnId ===
              event.payload.turnId
          ) {
            const nextWorkflow = yield* maybeAdvanceImplementationLifecycle(
              implementationMatch.workflow,
              readModel,
              event.payload.threadId,
              event.occurredAt,
            );
            yield* maybeContinueImplementationLifecycle(nextWorkflow, readModel, event.occurredAt);
            return;
          }

          const implementationCodeReviewMatch = workflowForCodeReviewThread(
            readModel.planningWorkflows,
            event.payload.threadId,
          );
          if (implementationCodeReviewMatch?.workflow.implementation) {
            const nextWorkflow = yield* maybeAdvanceImplementationLifecycle(
              implementationCodeReviewMatch.workflow,
              readModel,
              event.payload.threadId,
              event.occurredAt,
            );
            yield* maybeContinueImplementationLifecycle(nextWorkflow, readModel, event.occurredAt);
            return;
          }

          const planningWorkflow =
            workflowForAuthorThread(readModel.planningWorkflows, event.payload.threadId)
              ?.workflow ??
            workflowForReviewThread(readModel.planningWorkflows, event.payload.threadId)
              ?.workflow ??
            workflowForMergeThread(readModel.planningWorkflows, event.payload.threadId)?.workflow ??
            null;
          if (!planningWorkflow) {
            return;
          }

          const nextWorkflow = yield* maybeAdvancePlanningWorkflowFromCompletedThread(
            planningWorkflow,
            readModel,
            event.payload.threadId,
            event.occurredAt,
            { expectedTurnId: event.payload.turnId },
          );
          const lifecycleSnapshot =
            nextWorkflow !== planningWorkflow
              ? yield* orchestrationEngine.getReadModel()
              : readModel;
          yield* maybeContinuePlanningWorkflowLifecycle(
            nextWorkflow,
            lifecycleSnapshot,
            event.occurredAt,
          );
          return;
        }

        case "thread.message-sent": {
          if (event.payload.role !== "assistant" || event.payload.streaming) {
            return;
          }

          const readModel = yield* orchestrationEngine.getReadModel();
          const implementationMatch = workflowForImplementationThread(
            readModel.planningWorkflows,
            event.payload.threadId,
          );
          if (implementationMatch?.workflow.implementation) {
            const nextWorkflow = yield* maybeAdvanceImplementationLifecycle(
              implementationMatch.workflow,
              readModel,
              event.payload.threadId,
              event.occurredAt,
            );
            yield* maybeContinueImplementationLifecycle(nextWorkflow, readModel, event.occurredAt);
            return;
          }

          const implementationCodeReviewMatch = workflowForCodeReviewThread(
            readModel.planningWorkflows,
            event.payload.threadId,
          );
          if (implementationCodeReviewMatch?.workflow.implementation) {
            const nextWorkflow = yield* maybeAdvanceImplementationLifecycle(
              implementationCodeReviewMatch.workflow,
              readModel,
              event.payload.threadId,
              event.occurredAt,
            );
            yield* maybeContinueImplementationLifecycle(nextWorkflow, readModel, event.occurredAt);
            return;
          }

          const planningWorkflow =
            workflowForAuthorThread(readModel.planningWorkflows, event.payload.threadId)
              ?.workflow ??
            workflowForReviewThread(readModel.planningWorkflows, event.payload.threadId)
              ?.workflow ??
            workflowForMergeThread(readModel.planningWorkflows, event.payload.threadId)?.workflow ??
            null;
          if (planningWorkflow) {
            const nextWorkflow = yield* maybeAdvancePlanningWorkflowFromCompletedThread(
              planningWorkflow,
              readModel,
              event.payload.threadId,
              event.occurredAt,
            );
            const lifecycleSnapshot =
              nextWorkflow !== planningWorkflow
                ? yield* orchestrationEngine.getReadModel()
                : readModel;
            yield* maybeContinuePlanningWorkflowLifecycle(
              nextWorkflow,
              lifecycleSnapshot,
              event.occurredAt,
            );
            return;
          }

          return;
        }

        case "thread.session-set": {
          const readModel = yield* orchestrationEngine.getReadModel();
          const applyTurnCost = (workflow: PlanningWorkflow) =>
            recordWorkflowTurnCost(workflow, event.payload.session.turnCostUsd, event.occurredAt);
          const reviewMatch = workflowForReviewThread(
            readModel.planningWorkflows,
            event.payload.threadId,
          );
          const authorMatch = workflowForAuthorThread(
            readModel.planningWorkflows,
            event.payload.threadId,
          );
          const implementationMatch = workflowForImplementationThread(
            readModel.planningWorkflows,
            event.payload.threadId,
          );
          const codeReviewMatch = workflowForCodeReviewThread(
            readModel.planningWorkflows,
            event.payload.threadId,
          );
          const mergeMatch = workflowForMergeThread(
            readModel.planningWorkflows,
            event.payload.threadId,
          );

          if (event.payload.session.status !== "error") {
            if (
              implementationMatch?.workflow.implementation &&
              event.payload.session.status === "ready"
            ) {
              const workflowWithCost = yield* applyTurnCost(implementationMatch.workflow);
              const nextWorkflow = yield* maybeAdvanceImplementationLifecycle(
                workflowWithCost,
                readModel,
                event.payload.threadId,
                event.occurredAt,
              );
              yield* maybeContinueImplementationLifecycle(
                nextWorkflow,
                readModel,
                event.occurredAt,
              );
              return;
            }

            if (
              codeReviewMatch?.workflow.implementation &&
              event.payload.session.status === "ready"
            ) {
              const workflowWithCost = yield* applyTurnCost(codeReviewMatch.workflow);
              const nextWorkflow = yield* maybeAdvanceImplementationLifecycle(
                workflowWithCost,
                readModel,
                event.payload.threadId,
                event.occurredAt,
              );
              yield* maybeContinueImplementationLifecycle(
                nextWorkflow,
                readModel,
                event.occurredAt,
              );
              return;
            }

            const planningWorkflow =
              reviewMatch?.workflow ?? authorMatch?.workflow ?? mergeMatch?.workflow;
            if (planningWorkflow) {
              const workflowWithCost = yield* applyTurnCost(planningWorkflow);
              const nextWorkflow =
                event.payload.session.status === "ready"
                  ? yield* maybeAdvancePlanningWorkflowFromCompletedThread(
                      workflowWithCost,
                      readModel,
                      event.payload.threadId,
                      event.occurredAt,
                    )
                  : workflowWithCost;
              if (event.payload.session.status === "ready") {
                const lifecycleSnapshot =
                  nextWorkflow !== workflowWithCost
                    ? yield* orchestrationEngine.getReadModel()
                    : readModel;
                yield* maybeContinuePlanningWorkflowLifecycle(
                  nextWorkflow,
                  lifecycleSnapshot,
                  event.occurredAt,
                );
              }
              return;
            }

            return;
          }
          if (reviewMatch) {
            const baseWorkflow = yield* applyTurnCost(reviewMatch.workflow);
            const reviewedBranch = requirePlanningBranch(baseWorkflow, reviewMatch.branchId);
            const review = reviewedBranch.reviews.find(
              (entry) => entry.threadId === event.payload.threadId,
            );
            const reviewThread = readModel.threads.find(
              (thread) => thread.id === event.payload.threadId,
            );
            const acceptedFailedTurn =
              reviewThread?.latestTurn?.state === "error" &&
              reviewThread.latestTurn.requestedAt >= (review?.updatedAt ?? event.occurredAt);
            if (
              reviewedBranch.status === "reviews_requested" &&
              review?.status === "running" &&
              acceptedFailedTurn &&
              isRetryableSessionError(event.payload.session) &&
              review.retryCount < MAX_AUTO_RETRY_ATTEMPTS
            ) {
              const retryWorkflow = incrementPlanningReviewRetryCount(
                baseWorkflow,
                reviewMatch.branchId,
                event.payload.threadId,
                event.occurredAt,
              );
              const expectedRetryCount =
                requirePlanningBranch(retryWorkflow, reviewMatch.branchId).reviews.find(
                  (entry) => entry.threadId === event.payload.threadId,
                )?.retryCount ?? 0;
              yield* upsertWorkflow(retryWorkflow);
              yield* forkPlanningReviewAutoRetry({
                workflowId: retryWorkflow.id,
                branchId: reviewMatch.branchId,
                threadId: event.payload.threadId,
                expectedRetryCount,
                originalError: formatSessionError(event.payload.session, "Review failed."),
              });
              return;
            }

            const failedReviewWorkflow = markPlanningReviewError(
              baseWorkflow,
              reviewMatch.branchId,
              event.payload.threadId,
              formatSessionError(event.payload.session, "Review failed."),
              event.occurredAt,
            );
            yield* upsertWorkflow(failedReviewWorkflow);
            if (failedReviewWorkflow !== baseWorkflow) {
              // A failed review frees a slot: admit the next pending review of the mesh.
              const launchSnapshot = yield* orchestrationEngine.getReadModel();
              const launchWorkflow =
                launchSnapshot.planningWorkflows.find(
                  (entry) => entry.id === failedReviewWorkflow.id,
                ) ?? null;
              if (launchWorkflow && !isArchivedWorkflow(launchWorkflow)) {
                yield* maybeStartReviews(launchWorkflow, launchSnapshot, event.occurredAt);
              }
            }
            return;
          }

          if (authorMatch) {
            const baseWorkflow = yield* applyTurnCost(authorMatch.workflow);
            const branch = requirePlanningBranch(baseWorkflow, authorMatch.branchId);
            if (branch.status !== "authoring" && branch.status !== "revising") {
              return;
            }
            if (
              branch.status === "authoring" &&
              isRetryableSessionError(event.payload.session) &&
              branch.retryCount < MAX_AUTO_RETRY_ATTEMPTS
            ) {
              const retryWorkflow = incrementBranchRetryCount(
                baseWorkflow,
                authorMatch.branchId,
                event.occurredAt,
              );
              const expectedRetryCount = requirePlanningBranch(
                retryWorkflow,
                authorMatch.branchId,
              ).retryCount;
              yield* upsertWorkflow(retryWorkflow);
              yield* forkAutoRetry({
                kind: "authoring",
                workflowId: retryWorkflow.id,
                threadId: event.payload.threadId,
                buildDispatch: ({ workflow, snapshot }) => {
                  const branch =
                    planningBranches(workflow).find(
                      (entry) => entry.authorThreadId === event.payload.threadId,
                    ) ?? null;
                  const retryThread = snapshot.threads.find(
                    (thread) => thread.id === event.payload.threadId,
                  );
                  if (
                    !branch ||
                    !retryThread ||
                    branch.status !== "authoring" ||
                    branch.retryCount !== expectedRetryCount ||
                    hasRunningSessionTurn(retryThread)
                  ) {
                    return null;
                  }

                  return startAuthoringTurn({
                    orchestrationEngine,
                    workflow,
                    branch,
                    createdAt: new Date().toISOString(),
                    retry: {
                      kind: "retry",
                      reusedThread: true,
                      interrupted: true,
                      priorFailure: event.payload.session.lastError ?? undefined,
                    },
                  });
                },
                markFailed: ({ workflow, detail, failedAt }) => {
                  const branch = requirePlanningBranch(workflow, authorMatch.branchId);
                  if (branch.status !== "authoring" || branch.retryCount !== expectedRetryCount) {
                    return null;
                  }
                  return markBranchError(workflow, authorMatch.branchId, {
                    error: `${formatSessionError(event.payload.session, "Authoring failed.")} | Automatic retry failed: ${detail}`,
                    stage: "authoring",
                    updatedAt: failedAt,
                  });
                },
              });
              return;
            }

            yield* upsertWorkflow(
              markBranchError(baseWorkflow, authorMatch.branchId, {
                error: formatSessionError(event.payload.session, "Authoring failed."),
                stage: branch.status === "revising" ? "revision" : "authoring",
                updatedAt: event.occurredAt,
              }),
            );
            return;
          }

          if (implementationMatch) {
            const baseWorkflow = yield* applyTurnCost(implementationMatch.workflow);
            if (
              baseWorkflow.implementation &&
              baseWorkflow.implementation.status === "implementing" &&
              isRetryableSessionError(event.payload.session) &&
              baseWorkflow.implementation.retryCount < MAX_AUTO_RETRY_ATTEMPTS
            ) {
              const implementationThread = readModel.threads.find(
                (thread) => thread.id === event.payload.threadId,
              );
              if (implementationThread) {
                const retryWorkflow = incrementImplementationRetryCount(
                  baseWorkflow,
                  event.occurredAt,
                );
                const expectedRetryCount = retryWorkflow.implementation?.retryCount;
                if (expectedRetryCount === undefined) {
                  return;
                }
                yield* upsertWorkflow(retryWorkflow);
                yield* forkAutoRetry({
                  kind: "implementation",
                  workflowId: retryWorkflow.id,
                  threadId: event.payload.threadId,
                  buildDispatch: ({ workflow, snapshot }) => {
                    if (
                      !workflow.implementation ||
                      workflow.implementation.threadId !== event.payload.threadId
                    ) {
                      return null;
                    }

                    const retryThread = snapshot.threads.find(
                      (thread) => thread.id === event.payload.threadId,
                    );
                    if (
                      !retryThread ||
                      workflow.implementation.status !== "implementing" ||
                      workflow.implementation.retryCount !== expectedRetryCount ||
                      hasRunningSessionTurn(retryThread)
                    ) {
                      return null;
                    }

                    return retryImplementationTurn({
                      workflow,
                      thread: retryThread,
                      createdAt: new Date().toISOString(),
                    });
                  },
                });
                return;
              }
            }

            yield* upsertWorkflow(
              markImplementationError(
                baseWorkflow,
                formatSessionError(event.payload.session, "Implementation failed."),
                event.occurredAt,
              ),
            );
            return;
          }

          if (codeReviewMatch) {
            const baseWorkflow = yield* applyTurnCost(codeReviewMatch.workflow);
            const review = baseWorkflow.implementation?.codeReviews.find(
              (entry) => entry.threadId === event.payload.threadId,
            );
            if (
              review?.status === "running" &&
              isRetryableSessionError(event.payload.session) &&
              review.retryCount < MAX_AUTO_RETRY_ATTEMPTS
            ) {
              const mergeThread = readModel.threads.find(
                (thread) => thread.id === baseWorkflow.merge.threadId,
              );
              const mergedPlan = mergeThread
                ? resolveApprovedMergedPlan(baseWorkflow, mergeThread)
                : null;
              if (mergedPlan?.planMarkdown) {
                const retryWorkflow = incrementCodeReviewRetryCount(
                  baseWorkflow,
                  event.payload.threadId,
                  event.occurredAt,
                );
                const expectedRetryCount =
                  retryWorkflow.implementation?.codeReviews.find(
                    (entry) => entry.threadId === event.payload.threadId,
                  )?.retryCount ?? 0;
                yield* upsertWorkflow(retryWorkflow);
                yield* forkAutoRetry({
                  kind: "code_review",
                  workflowId: retryWorkflow.id,
                  threadId: event.payload.threadId,
                  buildDispatch: ({ workflow, snapshot }) => {
                    const retryReview = workflow.implementation?.codeReviews.find(
                      (entry) => entry.threadId === event.payload.threadId,
                    );
                    const retryThread = snapshot.threads.find(
                      (thread) => thread.id === event.payload.threadId,
                    );
                    const retryMergeThread = workflow.merge.threadId
                      ? snapshot.threads.find((thread) => thread.id === workflow.merge.threadId)
                      : null;
                    const retryMergedPlan = retryMergeThread
                      ? resolveApprovedMergedPlan(workflow, retryMergeThread)
                      : null;
                    if (
                      !workflow.implementation ||
                      !retryReview ||
                      !retryThread ||
                      retryReview.status !== "running" ||
                      retryReview.retryCount !== expectedRetryCount ||
                      hasRunningSessionTurn(retryThread) ||
                      !retryMergedPlan?.planMarkdown
                    ) {
                      return null;
                    }

                    return startCodeReviewTurn({
                      orchestrationEngine,
                      workflow,
                      reviewerSlot: retryReview.reviewerSlot,
                      reviewThreadId: retryReview.threadId,
                      mergedPlanMarkdown: retryMergedPlan.planMarkdown,
                      reviewerLabel: retryReview.reviewerLabel,
                      lensBranch: codeReviewLensBranch(workflow, retryReview.threadId),
                      reviewArtifact: implementationReviewPromptArtifact(workflow),
                      thread: retryThread,
                      createdAt: new Date().toISOString(),
                      retry: {
                        kind: "retry",
                        reusedThread: true,
                        priorFailure: event.payload.session.lastError ?? undefined,
                      },
                    });
                  },
                });
                return;
              }
            }

            yield* upsertWorkflow(
              markCodeReviewError(
                baseWorkflow,
                event.payload.threadId,
                formatSessionError(event.payload.session, "Code review failed."),
                event.occurredAt,
              ),
            );
            return;
          }

          if (mergeMatch) {
            yield* upsertWorkflow(
              markMergeError(
                yield* applyTurnCost(mergeMatch.workflow),
                formatSessionError(event.payload.session, "Merge failed."),
                event.occurredAt,
              ),
            );
            return;
          }

          return;
        }

        default:
          return;
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("WorkflowService.handleDomainEvent failed", {
          eventType: event.type,
          cause,
        }),
      ),
    );

  const start: WorkflowServiceShape["start"] = Effect.gen(function* () {
    if (sources.stopped) return;
    yield* Effect.addFinalizer(() => sources.stop);
    yield* reconcileStuckWorkflows.pipe(
      Effect.catchCause((cause) =>
        Effect.logError("WorkflowService.reconcileStuckWorkflows failed", {
          cause,
        }).pipe(Effect.asVoid),
      ),
    );
    yield* reconcileWorkflowImplementationLifecycles.pipe(
      Effect.catchCause((cause) =>
        Effect.logError("WorkflowService.reconcileWorkflowImplementationLifecycles failed", {
          cause,
        }).pipe(Effect.asVoid),
      ),
    );
    yield* Stream.runForEach(orchestrationEngine.streamDomainEvents, handleDomainEvent).pipe(
      Scope.provide(sources.scope),
      Effect.forkIn(sources.scope, { startImmediately: true }),
      Effect.asVoid,
    );
    if (providerTurnDeliveryWorker._tag === "Some") {
      yield* Stream.runForEach(providerTurnDeliveryWorker.value.outcomes, (outcome) =>
        Effect.gen(function* () {
          const snapshot = yield* orchestrationEngine.getReadModel();
          const workflow = workflowForImplementationThread(
            snapshot.planningWorkflows,
            outcome.threadId,
          )?.workflow;
          if (workflow?.implementation?.revisionDispatchCommandId === outcome.commandId) {
            yield* reconcileApplyReviews(workflow.id, { expectedCommandId: outcome.commandId });
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not reconcile Apply Reviews delivery outcome", {
              commandId: outcome.commandId,
              cause,
            }),
          ),
        ),
      ).pipe(Effect.forkIn(sources.scope, { startImmediately: true }));
    }
    const latest = yield* orchestrationEngine.getReadModel();
    yield* Effect.forEach(
      latest.planningWorkflows.filter(
        (workflow) =>
          isApplyReviewsLifecycle(workflow) &&
          (workflow.implementation?.status !== "completed" || hasMisattributedRevision(workflow)),
      ),
      (workflow) =>
        reconcileApplyReviews(workflow.id, { recheck: true }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not reconcile Apply Reviews at startup", {
              workflowId: workflow.id,
              cause,
            }),
          ),
        ),
      { discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("WorkflowService.start failed", { cause }).pipe(
        Effect.asVoid,
        Effect.flatMap(() => Effect.failCause(cause)),
      ),
    ),
  );

  const createWorkflow: WorkflowServiceShape["createWorkflow"] = (rawInput) =>
    Effect.gen(function* () {
      const providers = yield* getWorkflowProviders;
      const input: CreateWorkflowInput = {
        ...rawInput,
        ...(rawInput.templateId === DOCUMENT_WORKFLOW_TEMPLATE_ID
          ? { readerReviewEnabled: rawInput.readerReviewEnabled ?? true }
          : {}),
        ...planningInputAuthorFields(
          planningInputAuthorSlots(rawInput).map((slot) =>
            resolveAvailableWorkflowModelSlot(slot, providers),
          ),
        ),
        merge: resolveAvailableWorkflowModelSlot(rawInput.merge, providers),
      };
      const authorSlots = planningInputAuthorSlots(input);
      const behavior = yield* Effect.try({
        try: () =>
          resolveWorkflowBehavior({
            runKind: "planning",
            templateId: input.templateId,
            templateVersion:
              input.templateVersion ??
              latestWorkflowTemplateVersion({ runKind: "planning", templateId: input.templateId }),
          }),
        catch: () =>
          new UnsupportedWorkflowTemplateError(
            "planning",
            input.templateId ?? "builtin.planning.dual",
            input.templateVersion ?? 2,
          ),
      });
      const document = input.templateId === DOCUMENT_WORKFLOW_TEMPLATE_ID;
      const maxAuthors = workflowMaxParticipants(document ? "document" : "planning");
      if (authorSlots.length > maxAuthors)
        return yield* Effect.fail(
          new Error(
            `${document ? "Document" : "Feature"} workflows support up to ${maxAuthors} authors.`,
          ),
        );
      yield* Effect.try({
        try: () => {
          for (const slot of authorSlots) {
            assertWorkflowStageProviderSupported({
              behavior,
              stage: "author",
              provider: slot.provider,
              providers,
            });
          }
          assertWorkflowStageProviderSupported({
            behavior,
            stage: "merge",
            provider: input.merge.provider,
            providers,
          });
        },
        catch: (error) => error as UnsupportedWorkflowProviderError,
      });
      const documentInvariant = documentWorkflowCreateInvariant({
        ...input,
        readerSlot: input.reader,
      });
      if (documentInvariant) return yield* Effect.fail(new Error(documentInvariant));
      if (document && workflowModelSlotsHaveDuplicate(authorSlots))
        return yield* Effect.fail(
          new Error(
            authorSlots.length === 2
              ? "Document workflows need two different author models."
              : "Document workflows need a different model for every author.",
          ),
        );
      const readerSlot =
        document && input.readerReviewEnabled
          ? resolveAvailableWorkflowModelSlot(
              input.reader ?? defaultDocumentReaderSlot(authorSlots, input.merge),
              providers,
            )
          : undefined;
      if (readerSlot)
        yield* Effect.try({
          try: () =>
            assertWorkflowStageProviderSupported({
              behavior,
              stage: "plan-review",
              provider: readerSlot.provider,
              providers,
            }),
          catch: (error) => error as UnsupportedWorkflowProviderError,
        });
      const snapshot = yield* orchestrationEngine.getReadModel();
      const existingSlugs = new Set(
        snapshot.planningWorkflows
          .filter(
            (workflow) => workflow.projectId === input.projectId && workflow.deletedAt === null,
          )
          .map((workflow) => workflow.slug),
      );
      const now = new Date().toISOString();
      const workflowId = PlanningWorkflowId.makeUnsafe(crypto.randomUUID());
      const authors = authorSlots.map((slot) => ({
        slot,
        threadId: ThreadId.makeUnsafe(crypto.randomUUID()),
      }));
      const titleSourceText = input.requirementPrompt;
      const initialTitle =
        input.title ??
        buildFallbackTitle({
          titleSourceText,
          attachments: [],
          defaultTitle: "New workflow",
        });
      const slug = nextWorkflowSlug(existingSlugs, initialTitle);
      const plansDirectory = input.plansDirectory?.trim() || "plans";
      const workflow = buildPlanningWorkflowRecord({
        workflowId,
        projectId: input.projectId,
        title: initialTitle,
        slug,
        templateId: behavior.templateId,
        templateVersion: behavior.templateVersion,
        requirementPrompt: input.requirementPrompt,
        plansDirectory,
        selfReviewEnabled: input.selfReviewEnabled,
        documentType: input.documentType,
        readerReviewEnabled: input.readerReviewEnabled,
        readerPersona: input.readerPersona,
        readerSlot,
        authors,
        merge: input.merge,
        maxCostUsd: input.maxCostUsd,
        createdAt: now,
      });
      const planCharBudget = workflowPlanCharBudget(workflow);
      if (planCharBudget !== null && planCharBudget < WORKFLOW_MIN_PLAN_CHAR_BUDGET)
        return yield* Effect.fail(
          new Error(
            `This requirement leaves ${Math.max(0, planCharBudget).toLocaleString("en-US")} characters per plan for ${authors.length} authors; shorten it or use fewer authors.`,
          ),
        );

      yield* orchestrationEngine.dispatch({
        type: "project.workflow.create",
        commandId: CommandId.makeUnsafe(timeOrderedUuid()),
        workflowId,
        projectId: input.projectId,
        title: initialTitle,
        slug,
        templateId: behavior.templateId,
        templateVersion: behavior.templateVersion,
        requirementPrompt: input.requirementPrompt,
        plansDirectory,
        ...planningCommandAuthorFields(authors),
        selfReviewEnabled: input.selfReviewEnabled,
        documentType: input.documentType,
        readerReviewEnabled: input.readerReviewEnabled,
        readerPersona: input.readerPersona,
        readerSlot,
        merge: input.merge,
        maxCostUsd: input.maxCostUsd ?? null,
        createdAt: now,
      });

      yield* Effect.all(
        planningBranches(workflow).map((branch) =>
          createWorkflowThread({
            orchestrationEngine,
            input,
            threadId: branch.authorThreadId,
            suffix: `${document ? "Draft" : "Branch"} ${workflowParticipantLabel(branch.branchId)}`,
            slot: branch.authorSlot,
            now,
          }),
        ),
      ).pipe(
        Effect.tapError(() =>
          dispatchWorkflowDeleteCompensation({
            orchestrationEngine,
            workflowId,
            projectId: input.projectId,
            createdAt: new Date().toISOString(),
          }).pipe(Effect.ignoreCause({ log: true })),
        ),
      );

      // Authoring turns start in author order.
      const outcomes: Array<{ ok: true } | { ok: false; error: string }> = [];
      for (const branch of planningBranches(workflow)) {
        outcomes.push(
          yield* startAuthoringTurn({
            orchestrationEngine,
            workflow,
            branch,
            createdAt: new Date().toISOString(),
          }).pipe(
            Effect.match({
              onFailure: (error) => ({ ok: false as const, error: String(error) }),
              onSuccess: () => ({ ok: true as const }),
            }),
          ),
        );
      }

      const workflowWithAuthoring = planningBranches(workflow).reduce(
        (next, branch, index) =>
          updateAuthoringBranch(next, branch.branchId, new Date().toISOString(), outcomes[index]!),
        workflow,
      );
      yield* upsertWorkflow(workflowWithAuthoring);
      if (input.title === undefined) {
        yield* titleGenerationWorker.enqueue({
          workflowId,
          titleSourceText,
          expectedCurrentTitle: initialTitle,
          titleGenerationModel: input.titleGenerationModel,
          defaultTitle: "New workflow",
        });
      }

      return workflowId;
    });

  const startImplementation: WorkflowServiceShape["startImplementation"] = (rawInput) =>
    Effect.gen(function* () {
      const providers = yield* getWorkflowProviders;
      const implementationSlot = resolveAvailableWorkflowModelSlot(
        {
          provider: rawInput.provider,
          model: rawInput.model,
          ...(rawInput.modelOptions ? { modelOptions: rawInput.modelOptions } : {}),
          ...(rawInput.providerOptions ? { providerOptions: rawInput.providerOptions } : {}),
        },
        providers,
      );
      const input = {
        ...rawInput,
        provider: implementationSlot.provider,
        model: implementationSlot.model,
        ...(implementationSlot.modelOptions
          ? { modelOptions: implementationSlot.modelOptions }
          : { modelOptions: undefined }),
        ...(implementationSlot.providerOptions
          ? { providerOptions: implementationSlot.providerOptions }
          : { providerOptions: undefined }),
      };
      const workflow = yield* readWorkflow(orchestrationEngine, input.workflowId).pipe(
        Effect.mapError((error) => new Error(`Failed to load workflow: ${String(error)}`)),
      );
      if (workflow && isArchivedWorkflow(workflow))
        return yield* Effect.fail(
          new Error("Restore the workflow before starting implementation."),
        );
      if (!workflow) {
        return yield* Effect.fail(new Error(`Workflow '${input.workflowId}' does not exist.`));
      }
      if (isDocumentWorkflow(workflow))
        return yield* Effect.fail(
          new Error(
            "Document workflows end at the final document and have no implementation phase.",
          ),
        );
      if (workflow.merge.status !== "manual_review") {
        return yield* Effect.fail(new Error("Workflow merge is not ready for implementation."));
      }
      if (workflow.implementation !== null) {
        return yield* Effect.fail(
          new Error("Implementation has already been started for this workflow."),
        );
      }
      const budgetError = workflowBudgetError(workflow);
      if (budgetError) return yield* budgetError;

      const snapshot = yield* orchestrationEngine.getReadModel();
      const mergeThread = snapshot.threads.find((thread) => thread.id === workflow.merge.threadId);
      if (!mergeThread) {
        return yield* Effect.fail(new Error("Merge thread not found."));
      }

      const now = new Date().toISOString();
      const {
        workflow: implementationWorkflow,
        mergedPlan,
        repinned,
      } = resolveMergedPlanForImplementation(workflow, mergeThread, now);
      if (!mergedPlan?.planMarkdown) {
        return yield* Effect.fail(new Error("Merged plan not found."));
      }
      if (repinned) {
        yield* upsertWorkflow(implementationWorkflow);
      }

      const implementationPrompt = buildImplementationPrompt({
        workflow: implementationWorkflow,
        mergedPlanMarkdown: mergedPlan.planMarkdown,
        implementationSlot,
      });
      const implementationPromptError = workflowPromptInvariant({
        workflow: implementationWorkflow,
        prompt: implementationPrompt,
        artifacts: [mergedPlan.planMarkdown],
        targetSlot: implementationSlot,
        artifactLabel: "Approved implementation plan",
      });
      if (implementationPromptError) return yield* implementationPromptError;

      const envMode = input.envMode ?? "local";
      const workspaceRoot =
        snapshot.projects.find(
          (project) =>
            project.id === implementationWorkflow.projectId && project.deletedAt === null,
        )?.workspaceRoot ?? null;

      let branch: string | null = null;
      let worktreePath: string | null = null;
      if (envMode === "worktree") {
        if (!input.baseBranch) {
          return yield* Effect.fail(
            new Error("A base branch is required when starting implementation in a new worktree."),
          );
        }
        if (!workspaceRoot) {
          return yield* Effect.fail(
            new Error("Project workspace root is unavailable; cannot create worktree."),
          );
        }
        const newBranch = buildTemporaryWorktreeBranchName();
        const preparationScript = setupProjectScript(
          snapshot.projects.find((project) => project.id === implementationWorkflow.projectId)
            ?.scripts ?? [],
        );
        const createdWorktree = yield* gitCore
          .createWorktree({
            preparation: {
              owner: `workflow:${implementationWorkflow.id}`,
              runSetupScript: preparationScript !== null,
              setupIdentity: preparationScript?.command ?? null,
            },
            cwd: workspaceRoot,
            branch: input.baseBranch,
            newBranch,
            path: yield* gitCore.allocateWorktreePath({ cwd: workspaceRoot, branch: newBranch }),
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new Error(`Failed to create worktree for implementation: ${String(error)}`),
            ),
          );
        branch = createdWorktree.worktree.branch;
        worktreePath = createdWorktree.worktree.path;
      }

      const implementationThreadId = ThreadId.makeUnsafe(crypto.randomUUID());
      const runtimeMode = input.runtimeMode ?? DEFAULT_RUNTIME_MODE;
      const codeReviewEnabled = input.codeReviewEnabled ?? true;

      const pendingImplementationWorkflow: PlanningWorkflow = {
        ...implementationWorkflow,
        implementation: {
          implementationSlot: {
            provider: input.provider,
            model: input.model,
            ...(input.modelOptions ? { modelOptions: input.modelOptions } : {}),
            ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
          },
          threadId: implementationThreadId,
          branch,
          worktreePath,
          runtimeMode,
          implementationTurnId: null,
          revisionTurnId: null,
          codeReviewEnabled,
          codeReviews: [],
          status: "not_started",
          error: null,
          errorStage: null,
          reviewArtifact: null,
          retryCount: 0,
          lastRetryAt: null,
          updatedAt: now,
        },
        updatedAt: now,
      };
      yield* upsertWorkflow(pendingImplementationWorkflow);
      const latestSnapshot = yield* orchestrationEngine.getReadModel();
      yield* resumeImplementationStart(pendingImplementationWorkflow, latestSnapshot, now);
    });

  const deleteWorkflow: WorkflowServiceShape["deleteWorkflow"] = (
    workflowId,
    deleteThreads = false,
  ) =>
    changeWorkflowArchive.delete(
      workflowId,
      Effect.gen(function* () {
        const workflow = yield* readWorkflow(orchestrationEngine, workflowId).pipe(
          Effect.mapError(
            (error) => new Error(`Failed to load workflow '${workflowId}': ${String(error)}`),
          ),
        );
        if (!workflow) {
          return yield* Effect.fail(new Error(`Workflow '${workflowId}' does not exist.`));
        }

        const result = yield* orchestrationEngine.dispatch({
          type: "project.workflow.delete",
          commandId: CommandId.makeUnsafe(timeOrderedUuid()),
          workflowId,
          deleteThreads,
          projectId: workflow.projectId,
          createdAt: new Date().toISOString(),
        });
        return deleteThreads
          ? { deletedThreadIds: [...(result.deletedThreadIds ?? [])] }
          : undefined;
      }),
    );

  const changeWorkflowArchive = makeWorkflowArchiveLifecycle(orchestrationEngine, "planning");

  const archiveWorkflow: WorkflowServiceShape["archiveWorkflow"] = (workflowId) =>
    changeWorkflowArchive.archive(workflowId);

  const unarchiveWorkflow: WorkflowServiceShape["unarchiveWorkflow"] = (workflowId) =>
    changeWorkflowArchive.unarchive(workflowId, (snapshot) =>
      Effect.gen(function* () {
        const workflow = snapshot.planningWorkflows.find((entry) => entry.id === workflowId);
        if (workflow) yield* reconcileStuckWorkflow(workflow, snapshot);
        const latest = yield* orchestrationEngine.getReadModel();
        const current = latest.planningWorkflows.find((entry) => entry.id === workflowId);
        if (current && isApplyReviewsLifecycle(current)) {
          yield* reconcileApplyReviews(current.id, { recheck: true });
        } else if (current) {
          yield* reconcileWorkflowImplementationLifecycle(current, latest);
        }
      }),
    );

  const retryWorkflow: WorkflowServiceShape["retryWorkflow"] = (input) =>
    Effect.gen(function* () {
      const workflow = yield* readWorkflow(orchestrationEngine, input.workflowId).pipe(
        Effect.mapError(
          (error) => new Error(`Failed to load workflow '${input.workflowId}': ${String(error)}`),
        ),
      );
      if (!workflow) {
        return yield* Effect.fail(new Error(`Workflow '${input.workflowId}' does not exist.`));
      }
      if (isArchivedWorkflow(workflow))
        return yield* Effect.fail(new Error("Restore the workflow before retrying it."));

      if (
        isApplyReviewsLifecycle(workflow) &&
        (workflow.implementation?.status !== "completed" || hasMisattributedRevision(workflow))
      ) {
        return yield* reconcileApplyReviews(workflow.id, {
          retry: "manual",
          allowPossibleDuplicate: input.allowPossibleDuplicate ?? false,
        });
      }

      const updatedAt = new Date().toISOString();
      const failedThreadIds = new Set<ThreadId>();
      if (workflow.readerPass?.status === "error") {
        const threadId =
          workflow.readerPass.errorStage === "reader"
            ? workflow.readerPass.readerThreadId
            : workflow.merge.threadId;
        if (threadId) failedThreadIds.add(threadId);
      }

      for (const branch of planningBranches(workflow)) {
        const stage = planningWorkflowBranchFailureStage(branch);
        if (stage === "authoring" || stage === "revision") {
          failedThreadIds.add(branch.authorThreadId);
        }
        for (const review of branch.reviews) {
          // Pending reviews are not failures: the launcher admits them on its own.
          if (
            review.status === "error" ||
            (stage === "reviews" && review.status !== "completed" && review.status !== "pending")
          ) {
            failedThreadIds.add(review.threadId);
          }
        }
      }
      if (workflow.merge.status === "error" && workflow.merge.threadId) {
        failedThreadIds.add(workflow.merge.threadId);
      }
      if (workflow.implementation?.status === "error") {
        const failedCodeReviews = workflow.implementation.codeReviews.filter(
          (review) => review.status === "error",
        );
        if (failedCodeReviews.length > 0) {
          for (const review of failedCodeReviews) {
            failedThreadIds.add(review.threadId);
          }
        } else if (
          workflow.implementation.errorStage !== "implementation-start" &&
          workflow.implementation.errorStage !== "apply-feedback" &&
          workflow.implementation.errorStage !== "review-setup" &&
          workflow.implementation.threadId
        ) {
          failedThreadIds.add(workflow.implementation.threadId);
        }
      }

      const deliveryStateByThread = new Map<
        ThreadId,
        "pending" | "sending" | "accepted" | "rejected" | "ambiguous"
      >();
      const deliveryCreatedAtByThread = new Map<ThreadId, string>();
      const deliveries =
        providerTurnDeliveryWorker._tag === "Some"
          ? yield* Effect.forEach([...failedThreadIds], (threadId) =>
              providerTurnDeliveryWorker.value.recheck(threadId).pipe(
                Effect.map((delivery) => ({ threadId, delivery })),
                Effect.mapError(
                  (error) =>
                    new Error(
                      `Could not verify provider delivery for thread '${threadId}'. Retry after the provider reconnects.`,
                      { cause: error },
                    ),
                ),
              ),
            )
          : [];
      const snapshot = yield* orchestrationEngine.getReadModel();
      const revisionPlanByThread = new Map<
        ThreadId,
        { turnId: TurnId | null; createdAt: string }
      >();
      for (const branch of planningBranches(workflow)) {
        if (planningWorkflowBranchFailureStage(branch) !== "revision" || !branch.planTurnId)
          continue;
        const plan = snapshot.threads
          .find((thread) => thread.id === branch.authorThreadId)
          ?.proposedPlans.find((plan) => plan.turnId === branch.planTurnId);
        if (plan) revisionPlanByThread.set(branch.authorThreadId, plan);
      }
      for (const { threadId, delivery } of deliveries) {
        if (!delivery || delivery.state === "abandoned") continue;
        const plan = revisionPlanByThread.get(threadId);
        // A delivery that produced or predates the reviewed plan belongs to authoring.
        if (
          plan &&
          (delivery.createdAt < plan.createdAt || delivery.providerTurnId === plan.turnId)
        ) {
          continue;
        }
        deliveryStateByThread.set(threadId, delivery.state);
        deliveryCreatedAtByThread.set(threadId, delivery.createdAt);
      }
      const ambiguousThreadIds = [...deliveryStateByThread]
        .filter(([, state]) => state === "ambiguous")
        .map(([threadId]) => threadId);
      const deliveryMode = (
        threadId: ThreadId | null,
      ): "fresh" | "accepted" | "queued" | "retry" => {
        if (!threadId) return "fresh";
        // Accepted delivery says nothing about artifact validity. A completed invalid
        // capture needs a new turn, rather than waiting on the old accepted delivery.
        if (
          isDocumentWorkflow(workflow) &&
          !hasRunningSessionTurn(snapshot.threads.find((thread) => thread.id === threadId))
        ) {
          const branch = planningBranches(workflow).find(
            (entry) => entry.authorThreadId === threadId,
          );
          const error =
            branch?.status === "error"
              ? branch.error
              : workflow.merge.threadId === threadId && workflow.merge.status === "error"
                ? workflow.merge.error
                : null;
          if (error?.startsWith("Invalid document:")) return "fresh";
        }
        switch (deliveryStateByThread.get(threadId)) {
          case "accepted":
            return "accepted";
          case "pending":
          case "sending":
            return "queued";
          case "rejected":
          case "ambiguous":
            return "retry";
          default:
            return "fresh";
        }
      };
      const acceptedStageRequestedAt = (threadId: ThreadId, fallback: string) =>
        isDocumentWorkflow(workflow)
          ? (deliveryCreatedAtByThread.get(threadId) ??
            snapshot.threads.find((thread) => thread.id === threadId)?.latestTurn?.requestedAt ??
            fallback)
          : updatedAt;
      const markAcceptedMergeStarted = (current: PlanningWorkflow, threadId: ThreadId) => ({
        ...markMergeStarted(
          current,
          threadId,
          acceptedStageRequestedAt(threadId, current.merge.updatedAt),
        ),
        updatedAt,
      });
      let retriedWorkflow = workflow;
      const handledAcceptedThreadIds = new Set<ThreadId>();
      const handledRevisionThreads = new Set<ThreadId>();
      /** Failed reviews requeued for the launcher, with their retry context. */
      const reviewRetries = new Map<ThreadId, WorkflowRetryContext>();
      const setReviewPending = (
        current: PlanningWorkflow,
        branchId: WorkflowBranchId,
        threadId: ThreadId,
      ): PlanningWorkflow => {
        const branch = requirePlanningBranch(current, branchId);
        const nextBranch: WorkflowBranch = {
          ...branch,
          reviews: branch.reviews.map((review) =>
            review.threadId === threadId
              ? {
                  ...review,
                  status: "pending" as const,
                  error: null,
                  retryCount: 0,
                  lastRetryAt: null,
                  // Requeued now: a turn on this thread requested earlier is the failed attempt.
                  updatedAt,
                }
              : review,
          ),
          status: "reviews_requested",
          error: null,
          errorStage: null,
          updatedAt,
        };
        return { ...updatePlanningBranch(current, branchId, () => nextBranch), updatedAt };
      };
      const setReviewRunning = (
        current: PlanningWorkflow,
        branchId: WorkflowBranchId,
        threadId: ThreadId,
      ): PlanningWorkflow => {
        const branch = requirePlanningBranch(current, branchId);
        const nextBranch: WorkflowBranch = {
          ...branch,
          reviews: branch.reviews.map((review) =>
            review.threadId === threadId
              ? {
                  ...review,
                  status: "running" as const,
                  error: null,
                  retryCount: 0,
                  lastRetryAt: null,
                  updatedAt,
                }
              : review,
          ),
          status: "reviews_requested",
          error: null,
          errorStage: null,
          updatedAt,
        };
        return {
          ...updatePlanningBranch(current, branchId, () => nextBranch),
          updatedAt,
        };
      };
      const setCodeReviewRunning = (
        current: PlanningWorkflow,
        threadId: ThreadId,
      ): PlanningWorkflow => {
        if (!current.implementation) return current;
        const reviews = current.implementation.codeReviews.map((review) =>
          review.threadId === threadId
            ? {
                ...review,
                status: "running" as const,
                error: null,
                retryCount: 0,
                lastRetryAt: null,
                updatedAt,
              }
            : review,
        );
        const hasErrors = reviews.some((review) => review.status === "error");
        return {
          ...current,
          implementation: {
            ...current.implementation,
            codeReviews: reviews,
            status: hasErrors ? "error" : "code_reviews_requested",
            error: hasErrors ? current.implementation.error : null,
            updatedAt,
          },
          updatedAt,
        };
      };

      for (const branchId of planningBranchIds(workflow)) {
        const branch = requirePlanningBranch(workflow, branchId);
        const stage = planningWorkflowBranchFailureStage(branch);
        for (const review of branch.reviews) {
          if (
            deliveryMode(review.threadId) !== "accepted" ||
            (review.status !== "error" &&
              !(
                stage === "reviews" &&
                review.status !== "completed" &&
                review.status !== "pending"
              ))
          ) {
            continue;
          }
          const completedWorkflow = yield* maybeAdvancePlanningWorkflowFromCompletedThread(
            retriedWorkflow,
            snapshot,
            review.threadId,
            updatedAt,
          );
          if (completedWorkflow === retriedWorkflow) {
            retriedWorkflow = setReviewRunning(retriedWorkflow, branchId, review.threadId);
            yield* upsertWorkflow(retriedWorkflow);
          } else {
            retriedWorkflow = completedWorkflow;
          }
          handledAcceptedThreadIds.add(review.threadId);
        }

        if (
          (stage === "authoring" || stage === "revision") &&
          deliveryMode(branch.authorThreadId) === "accepted"
        ) {
          const completedWorkflow = yield* maybeAdvancePlanningWorkflowFromCompletedThread(
            retriedWorkflow,
            snapshot,
            branch.authorThreadId,
            updatedAt,
          );
          if (completedWorkflow === retriedWorkflow) {
            const currentBranch = requirePlanningBranch(retriedWorkflow, branchId);
            const nextBranch: WorkflowBranch = {
              ...currentBranch,
              status: stage === "revision" ? "revising" : "authoring",
              error: null,
              errorStage: null,
              retryCount: 0,
              lastRetryAt: null,
              updatedAt:
                stage === "revision"
                  ? (deliveryCreatedAtByThread.get(branch.authorThreadId) ??
                    currentBranch.updatedAt)
                  : acceptedStageRequestedAt(branch.authorThreadId, currentBranch.updatedAt),
            };
            retriedWorkflow = {
              ...updatePlanningBranch(retriedWorkflow, branchId, () => nextBranch),
              updatedAt,
            };
            yield* upsertWorkflow(retriedWorkflow);
          } else {
            retriedWorkflow = completedWorkflow;
          }
          handledAcceptedThreadIds.add(branch.authorThreadId);
          if (stage === "revision") handledRevisionThreads.add(branch.authorThreadId);
        }
      }

      if (
        workflow.merge.status === "error" &&
        workflow.merge.threadId &&
        deliveryMode(workflow.merge.threadId) === "accepted"
      ) {
        const completedWorkflow = yield* maybeAdvancePlanningWorkflowFromCompletedThread(
          retriedWorkflow,
          snapshot,
          workflow.merge.threadId,
          updatedAt,
        );
        if (completedWorkflow === retriedWorkflow) {
          retriedWorkflow = markAcceptedMergeStarted(retriedWorkflow, workflow.merge.threadId);
          yield* upsertWorkflow(retriedWorkflow);
        } else {
          retriedWorkflow = completedWorkflow;
        }
        handledAcceptedThreadIds.add(workflow.merge.threadId);
      }

      if (workflow.implementation?.status === "error") {
        const failedReviews = workflow.implementation.codeReviews.filter(
          (review) => review.status === "error",
        );
        for (const review of failedReviews) {
          if (deliveryMode(review.threadId) !== "accepted") {
            continue;
          }
          const completedWorkflow = yield* maybeAdvanceImplementationLifecycle(
            retriedWorkflow,
            snapshot,
            review.threadId,
            updatedAt,
          );
          if (completedWorkflow === retriedWorkflow) {
            retriedWorkflow = setCodeReviewRunning(retriedWorkflow, review.threadId);
            yield* upsertWorkflow(retriedWorkflow);
          } else {
            retriedWorkflow = completedWorkflow;
          }
          handledAcceptedThreadIds.add(review.threadId);
        }

        if (
          failedReviews.length === 0 &&
          workflow.implementation.errorStage !== "review-setup" &&
          workflow.implementation.threadId &&
          deliveryMode(workflow.implementation.threadId) === "accepted"
        ) {
          const completedWorkflow = yield* maybeAdvanceImplementationLifecycle(
            retriedWorkflow,
            snapshot,
            workflow.implementation.threadId,
            updatedAt,
          );
          if (completedWorkflow === retriedWorkflow && retriedWorkflow.implementation) {
            const implementation = retriedWorkflow.implementation;
            const retryStatus =
              implementation.codeReviews.length > 0 &&
              implementation.codeReviews.every((review) => review.status === "completed")
                ? "applying_reviews"
                : "implementing";
            retriedWorkflow = {
              ...retriedWorkflow,
              implementation: {
                ...implementation,
                status: retryStatus,
                error: null,
                retryCount: 0,
                lastRetryAt: null,
                updatedAt,
              },
              updatedAt,
            };
            yield* upsertWorkflow(retriedWorkflow);
          } else {
            retriedWorkflow = completedWorkflow;
          }
          handledAcceptedThreadIds.add(workflow.implementation.threadId);
        }
      }
      if (ambiguousThreadIds.length > 0 && !input.allowPossibleDuplicate) {
        return {
          status: "confirmation_required" as const,
          threadIds: ambiguousThreadIds,
        };
      }
      const retriesLegacyReviewSetup = planningBranches(workflow).some(
        (branch) =>
          planningWorkflowBranchFailureStage(branch) === "reviews" && branch.reviews.length === 0,
      );

      const willSpend =
        [...failedThreadIds].some((threadId) => {
          const mode = deliveryMode(threadId);
          return mode === "fresh" || mode === "retry";
        }) ||
        retriesLegacyReviewSetup ||
        (workflow.implementation?.status === "error" &&
          workflow.implementation.errorStage === "review-setup") ||
        (workflow.merge.status === "error" &&
          (!workflow.merge.threadId || deliveryMode(workflow.merge.threadId) === "fresh"));
      if (willSpend) {
        const budgetError = workflowBudgetError(workflow);
        if (budgetError) {
          return yield* Effect.fail(new Error(budgetError.message));
        }
      }

      if (isDocumentWorkflow(workflow) && workflow.readerPass?.status === "error") {
        const pass = workflow.readerPass;
        const stage = pass.errorStage ?? "reader";
        const threadId = stage === "reader" ? pass.readerThreadId : workflow.merge.threadId!;
        const mode = deliveryMode(threadId);
        if (mode === "accepted") {
          const advanced = yield* maybeAdvanceDocumentReaderPass(
            workflow,
            snapshot,
            threadId,
            updatedAt,
          );
          if (advanced !== workflow) {
            yield* maybeContinueDocumentReaderPass(advanced);
            return { status: "started" as const };
          }
          if (hasRunningSessionTurn(snapshot.threads.find((entry) => entry.id === threadId)))
            return { status: "started" as const };
        }
        if ((mode === "retry" || mode === "queued") && providerTurnDeliveryWorker._tag === "Some") {
          const resumed: PlanningWorkflow = {
            ...workflow,
            readerPass: {
              ...pass,
              status: stage === "reader" ? "reader_running" : "polishing",
              readerStartedAt:
                stage === "reader"
                  ? (pass.readerStartedAt ??
                    deliveryCreatedAtByThread.get(threadId) ??
                    pass.updatedAt)
                  : pass.readerStartedAt,
              error: null,
              errorStage: null,
              retryCount: 0,
              updatedAt,
            },
            updatedAt,
          };
          yield* upsertWorkflow(resumed);
          yield* providerTurnDeliveryWorker.value
            .retry({ threadId, allowPossibleDuplicate: input.allowPossibleDuplicate ?? false })
            .pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  yield* upsertWorkflow(
                    markReaderPassError(resumed, stage, String(error), new Date().toISOString()),
                  );
                  return yield* Effect.fail(new Error(String(error)));
                }),
              ),
            );
        } else {
          const next: PlanningWorkflow = {
            ...workflow,
            readerPass: {
              ...pass,
              status: stage === "reader" ? "reader_requested" : "reader_saved",
              ...(stage === "reader"
                ? {
                    previousReaderThreadIds: [
                      ...(pass.previousReaderThreadIds ?? []),
                      pass.readerThreadId,
                    ],
                    readerThreadId: ThreadId.makeUnsafe(crypto.randomUUID()),
                    readerStartedAt: null,
                    pinnedTurnId: null,
                    pinnedAssistantMessageId: null,
                    polishRequestedAt: null,
                    polishTurnId: null,
                  }
                : {}),
              error: null,
              errorStage: null,
              retryCount: 0,
              polishFormatRepairAttempts: 0,
              updatedAt,
            },
            updatedAt,
          };
          yield* upsertWorkflow(next);
          yield* maybeContinueDocumentReaderPass(next);
        }
        return { status: "started" as const };
      }
      const planForBranch = (branch: WorkflowBranch) =>
        completedProposedPlanForTurn(
          snapshot,
          branch.authorThreadId,
          branch.planTurnId,
          branch.updatedAt,
          planReplacementFilter(workflow, branch.branchId),
        )?.planMarkdown ?? null;

      if (retriesLegacyReviewSetup) {
        const prospectiveStatuses = planningBranches(workflow).map((branch) =>
          planningWorkflowBranchFailureStage(branch) === "reviews" && branch.reviews.length === 0
            ? "plan_saved"
            : branch.status,
        );
        if (prospectiveStatuses.some((status) => status !== "plan_saved")) {
          return yield* Effect.fail(
            new Error("Review setup cannot be retried until every branch plan is saved."),
          );
        }
        if (planningBranches(workflow).some((branch) => !planForBranch(branch))) {
          return yield* Effect.fail(new Error("Saved branch plans not found for review retry."));
        }
      }

      const revisionFeedback = new Map<
        WorkflowBranchId,
        ReadonlyArray<{
          readonly reviewerLabel: string;
          readonly reviewMarkdown: string;
          readonly source: Parameters<typeof buildRevisionPrompt>[0]["reviews"][number]["source"];
        }>
      >();

      for (const branchId of planningBranchIds(workflow)) {
        const branch = requirePlanningBranch(workflow, branchId);
        const stage = planningWorkflowBranchFailureStage(branch);
        for (const review of branch.reviews) {
          if (
            review.status !== "error" &&
            !(stage === "reviews" && review.status !== "completed" && review.status !== "pending")
          ) {
            continue;
          }
          if (deliveryMode(review.threadId) !== "fresh") {
            continue;
          }
          if (!planForBranch(branch)) {
            return yield* Effect.fail(
              new Error(`Saved plan not found for Branch ${branchId.toUpperCase()} review retry.`),
            );
          }
        }

        if (stage === "revision" && deliveryMode(branch.authorThreadId) === "fresh") {
          const feedback = yield* reviewFeedbackForBranch(workflow, branch, snapshot);
          if (feedback.length === 0) {
            return yield* Effect.fail(
              new Error(`Review feedback not found for Branch ${branchId.toUpperCase()} revision.`),
            );
          }
          revisionFeedback.set(branchId, feedback);
        }
      }

      if (workflow.merge.status === "error" && deliveryMode(workflow.merge.threadId) === "fresh") {
        if (!collectMergeInputs(workflow, snapshot)) {
          return yield* Effect.fail(new Error("Revised plans not found for merge retry."));
        }
      }

      let mergedPlanMarkdown: string | null = null;
      const failedCodeReviews =
        workflow.implementation?.status === "error"
          ? workflow.implementation.codeReviews.filter((review) => review.status === "error")
          : [];
      if (failedCodeReviews.some((review) => deliveryMode(review.threadId) === "fresh")) {
        const mergeThread = snapshot.threads.find(
          (thread) => thread.id === workflow.merge.threadId,
        );
        mergedPlanMarkdown = mergeThread
          ? (resolveApprovedMergedPlan(workflow, mergeThread)?.planMarkdown ?? null)
          : null;
        if (!mergedPlanMarkdown) {
          return yield* Effect.fail(new Error("Merged plan not found for code review retry."));
        }
      }

      let implementationThread: OrchestrationReadModel["threads"][number] | null = null;
      if (
        workflow.implementation?.status === "error" &&
        workflow.implementation.errorStage !== "implementation-start" &&
        workflow.implementation.errorStage !== "apply-feedback" &&
        workflow.implementation.errorStage !== "review-setup" &&
        failedCodeReviews.length === 0
      ) {
        if (!workflow.implementation.threadId) {
          return yield* Effect.fail(new Error("Implementation thread not found for retry."));
        }
        if (deliveryMode(workflow.implementation.threadId) === "fresh") {
          implementationThread =
            snapshot.threads.find((thread) => thread.id === workflow.implementation?.threadId) ??
            null;
          if (!implementationThread) {
            return yield* Effect.fail(new Error("Implementation thread not found for retry."));
          }
          const latestUserMessage = implementationThread.messages
            .toReversed()
            .find((message) => message.role === "user" && !message.streaming);
          if (!latestUserMessage) {
            return yield* Effect.fail(
              new Error(
                `Implementation retry message not found for thread '${implementationThread.id}'.`,
              ),
            );
          }
        }
      }

      // A failed plan-review delivery takes a review slot like any launch. Resends start now
      // while slots are free; the rest are requeued, and the launcher resends each delivery when
      // it admits that review. Legacy branch-level review errors keep the direct resend.
      // Slots are counted from a fresh read inside the launcher gate, and the resends go out
      // before it is released: a resent delivery holds its slot from then on, so a launcher pass
      // that runs meanwhile can't fill the same slot.
      const requeuedReviewDeliveries = new Set<ThreadId>();
      yield* reviewLaunchGate.withPermits(1)(
        Effect.gen(function* () {
          const fresh = yield* orchestrationEngine.getReadModel();
          const current =
            fresh.planningWorkflows.find((entry) => entry.id === workflow.id) ?? workflow;
          const allReviews = planningBranches(current).flatMap((branch) => branch.reviews);
          const resendCandidates = planningBranches(workflow)
            .filter(
              (branch) =>
                !(planningWorkflowBranchFailureStage(branch) === "reviews" && branch.error),
            )
            .flatMap((branch) => branch.reviews)
            .filter(
              (review) =>
                failedThreadIds.has(review.threadId) && deliveryMode(review.threadId) === "retry",
            )
            .map((review) => review.threadId);
          const idempotentStageSetup = resolveWorkflowBehavior({
            runKind: "planning",
            templateId: workflow.templateId,
            templateVersion: workflow.templateVersion,
          }).idempotentStageSetup;
          let activeReviews = 0;
          for (const review of allReviews) {
            if (resendCandidates.includes(review.threadId)) continue;
            if (yield* planReviewHoldsSlot(review, fresh, idempotentStageSetup)) {
              activeReviews += 1;
            }
          }
          for (const threadId of resendCandidates) {
            if (activeReviews < WORKFLOW_MAX_ACTIVE_REVIEW_TURNS) activeReviews += 1;
            else requeuedReviewDeliveries.add(threadId);
          }

          if (providerTurnDeliveryWorker._tag === "Some") {
            yield* Effect.forEach(
              [...failedThreadIds].filter(
                (threadId) =>
                  deliveryMode(threadId) === "retry" && !requeuedReviewDeliveries.has(threadId),
              ),
              (threadId) =>
                providerTurnDeliveryWorker.value.retry({
                  threadId,
                  allowPossibleDuplicate: input.allowPossibleDuplicate ?? false,
                }),
              { discard: true },
            );
          }
        }),
      );

      const preserveLegacyReviewError = (
        current: PlanningWorkflow,
        branchId: WorkflowBranchId,
        threadId: ThreadId,
        legacyError: string,
      ): PlanningWorkflow => {
        const branch = requirePlanningBranch(current, branchId);
        const nextBranch: WorkflowBranch = {
          ...branch,
          reviews: branch.reviews.map((review) =>
            review.threadId === threadId && review.status !== "completed"
              ? { ...review, status: "error" as const, error: review.error ?? legacyError }
              : review,
          ),
          status: "reviews_requested",
          error: null,
          errorStage: null,
          updatedAt,
        };
        return {
          ...updatePlanningBranch(current, branchId, () => nextBranch),
          updatedAt,
        };
      };

      for (const branchId of planningBranchIds(workflow)) {
        const originalBranch = requirePlanningBranch(workflow, branchId);
        const originalStage = planningWorkflowBranchFailureStage(originalBranch);
        if (originalStage === "reviews" && originalBranch.reviews.length === 0) {
          const repairedBranch: WorkflowBranch = {
            ...requirePlanningBranch(retriedWorkflow, branchId),
            status: "plan_saved",
            error: null,
            errorStage: null,
            updatedAt,
          };
          retriedWorkflow = {
            ...updatePlanningBranch(retriedWorkflow, branchId, () => repairedBranch),
            updatedAt,
          };
        }
        for (const review of originalBranch.reviews) {
          if (
            review.status !== "error" &&
            !(
              originalStage === "reviews" &&
              review.status !== "completed" &&
              review.status !== "pending"
            )
          ) {
            continue;
          }
          if (handledAcceptedThreadIds.has(review.threadId)) {
            continue;
          }
          const mode = deliveryMode(review.threadId);
          if (requeuedReviewDeliveries.has(review.threadId)) {
            requeuedPlanReviewDeliveries.set(review.threadId, {
              allowPossibleDuplicate: input.allowPossibleDuplicate ?? false,
            });
            retriedWorkflow = setReviewPending(retriedWorkflow, branchId, review.threadId);
            yield* upsertWorkflow(retriedWorkflow);
            continue;
          }
          if (mode === "queued" || mode === "retry") {
            if (originalStage === "reviews" && originalBranch.error) {
              retriedWorkflow = preserveLegacyReviewError(
                retriedWorkflow,
                branchId,
                review.threadId,
                originalBranch.error,
              );
              yield* upsertWorkflow(retriedWorkflow);
            }
            continue;
          }
          if (mode === "accepted") {
            const completedWorkflow = yield* maybeAdvancePlanningWorkflowFromCompletedThread(
              retriedWorkflow,
              snapshot,
              review.threadId,
              updatedAt,
            );
            if (completedWorkflow !== retriedWorkflow) {
              retriedWorkflow = completedWorkflow;
              continue;
            }
            retriedWorkflow = setReviewRunning(retriedWorkflow, branchId, review.threadId);
            yield* upsertWorkflow(retriedWorkflow);
            continue;
          }
          // Requeue rather than dispatch: the launcher keeps the running-review cap and
          // recreates a review thread that failed before it was created.
          reviewRetries.set(review.threadId, {
            kind: "retry",
            reusedThread: snapshot.threads.some((thread) => thread.id === review.threadId),
            priorFailure: review.error ?? undefined,
          });
          retriedWorkflow = setReviewPending(retriedWorkflow, branchId, review.threadId);
          yield* upsertWorkflow(retriedWorkflow);
        }

        if (originalStage !== "authoring" && originalStage !== "revision") {
          continue;
        }
        if (handledAcceptedThreadIds.has(originalBranch.authorThreadId)) {
          continue;
        }
        const mode = deliveryMode(originalBranch.authorThreadId);
        if (mode === "queued" || mode === "retry") {
          continue;
        }
        if (mode === "accepted") {
          const completedWorkflow = yield* maybeAdvancePlanningWorkflowFromCompletedThread(
            retriedWorkflow,
            snapshot,
            originalBranch.authorThreadId,
            updatedAt,
          );
          if (completedWorkflow !== retriedWorkflow) {
            retriedWorkflow = completedWorkflow;
            continue;
          }
        }
        const nextBranch: WorkflowBranch = {
          ...requirePlanningBranch(retriedWorkflow, branchId),
          status: originalStage === "revision" ? "revising" : "authoring",
          ...(isDocumentWorkflow(workflow)
            ? {
                ...(originalStage === "revision"
                  ? { revisionFormatRepairAttempts: 0 }
                  : { authorFormatRepairAttempts: 0 }),
                ...(originalBranch.error?.startsWith("Invalid document:")
                  ? {
                      rejectedDocumentTurnId:
                        snapshot.threads.find(
                          (thread) => thread.id === originalBranch.authorThreadId,
                        )?.latestTurn?.turnId ??
                        originalBranch.rejectedDocumentTurnId ??
                        null,
                    }
                  : {}),
              }
            : {}),
          error: null,
          errorStage: null,
          retryCount: 0,
          lastRetryAt: null,
          updatedAt,
        };
        if (mode === "accepted") {
          retriedWorkflow = {
            ...updatePlanningBranch(retriedWorkflow, branchId, () => nextBranch),
            updatedAt,
          };
          yield* upsertWorkflow(retriedWorkflow);
          continue;
        }
        if (originalStage === "authoring") {
          yield* startAuthoringTurn({
            orchestrationEngine,
            workflow: retriedWorkflow,
            branch: originalBranch,
            createdAt: updatedAt,
            retry: {
              kind: "retry",
              reusedThread: true,
              ...(isDocumentWorkflow(workflow) &&
              originalBranch.error?.startsWith("Invalid document:")
                ? { formatRepair: true as const }
                : {}),
              priorFailure: originalBranch.error ?? undefined,
            },
          });
        } else {
          const authorThread = snapshot.threads.find(
            (entry) => entry.id === originalBranch.authorThreadId,
          );
          // The reviewed plan is pinned by turn id, as automatic revision setup reads
          // it. A newer unsettled turn (such as a native compaction) can't hide it.
          const pinnedPlan = originalBranch.planTurnId
            ? authorThread?.proposedPlans.find((plan) => plan.turnId === originalBranch.planTurnId)
            : undefined;
          if (
            !pinnedPlan &&
            resolveWorkflowBehavior({
              runKind: "planning",
              templateId: workflow.templateId,
              templateVersion: workflow.templateVersion,
            }).templateVersion === 2
          ) {
            retriedWorkflow = yield* rejectRevision(
              { workflow: retriedWorkflow, branch: originalBranch, createdAt: updatedAt },
              `The reviewed ${isDocumentWorkflow(workflow) ? "draft" : "plan"} for Branch ${branchId.toUpperCase()} could not be found, so the revision was not sent.`,
            );
            continue;
          }
          const revisionOutcome = yield* dispatchRevisionTurn({
            workflow: retriedWorkflow,
            branch: originalBranch,
            originalPlanMarkdown: pinnedPlan?.planMarkdown ?? "# Original plan unavailable",
            ...(pinnedPlan ? { originalPlanCreatedAt: pinnedPlan.createdAt } : {}),
            reviews: revisionFeedback.get(branchId)!,
            ...(authorThread ? { thread: authorThread } : {}),
            createdAt: updatedAt,
            retry: {
              kind: "retry",
              reusedThread: true,
              ...(isDocumentWorkflow(workflow) &&
              originalBranch.error?.startsWith("Invalid document:")
                ? { formatRepair: true as const }
                : {}),
              priorFailure: originalBranch.error ?? undefined,
            },
          });
          if (!revisionOutcome.started) {
            retriedWorkflow = revisionOutcome.workflow;
            continue;
          }
          handledRevisionThreads.add(originalBranch.authorThreadId);
        }
        retriedWorkflow = {
          ...updatePlanningBranch(retriedWorkflow, branchId, () => nextBranch),
          updatedAt,
        };
        yield* upsertWorkflow(retriedWorkflow);
      }

      if (
        (reviewRetries.size > 0 || requeuedReviewDeliveries.size > 0) &&
        !retriesLegacyReviewSetup
      ) {
        yield* maybeStartReviews(retriedWorkflow, snapshot, updatedAt, reviewRetries);
        const refreshed = yield* orchestrationEngine.getReadModel();
        retriedWorkflow =
          refreshed.planningWorkflows.find((entry) => entry.id === retriedWorkflow.id) ??
          retriedWorkflow;
      }

      if (retriesLegacyReviewSetup) {
        // The launcher reads the stored record, so the repaired branches are saved first.
        yield* upsertWorkflow(retriedWorkflow);
        yield* maybeStartReviews(retriedWorkflow, snapshot, updatedAt, reviewRetries);
        const refreshed = yield* orchestrationEngine.getReadModel();
        retriedWorkflow =
          refreshed.planningWorkflows.find((entry) => entry.id === retriedWorkflow.id) ??
          retriedWorkflow;
      }

      if (retriedWorkflow.merge.status === "error") {
        const mode = deliveryMode(retriedWorkflow.merge.threadId);
        if (mode === "accepted" && retriedWorkflow.merge.threadId) {
          const completedWorkflow = yield* maybeAdvancePlanningWorkflowFromCompletedThread(
            retriedWorkflow,
            snapshot,
            retriedWorkflow.merge.threadId,
            updatedAt,
          );
          if (completedWorkflow !== retriedWorkflow) {
            retriedWorkflow = completedWorkflow;
          } else {
            retriedWorkflow = markAcceptedMergeStarted(
              retriedWorkflow,
              retriedWorkflow.merge.threadId,
            );
            yield* upsertWorkflow(retriedWorkflow);
          }
        } else if (
          mode === "fresh" &&
          isDocumentWorkflow(retriedWorkflow) &&
          retriedWorkflow.merge.threadId
        ) {
          const next = markMergeStarted(
            {
              ...retriedWorkflow,
              merge: {
                ...retriedWorkflow.merge,
                formatRepairAttempts: 0,
                ...(retriedWorkflow.merge.error?.startsWith("Invalid document:")
                  ? {
                      rejectedDocumentTurnId:
                        snapshot.threads.find(
                          (thread) => thread.id === retriedWorkflow.merge.threadId,
                        )?.latestTurn?.turnId ??
                        retriedWorkflow.merge.rejectedDocumentTurnId ??
                        null,
                    }
                  : {}),
              },
            },
            retriedWorkflow.merge.threadId,
            updatedAt,
          );
          yield* upsertWorkflow(next);
          yield* startMergeTurn({
            orchestrationEngine,
            workflow: next,
            threadId: next.merge.threadId!,
            plans: collectMergeInputs(next, snapshot)!,
            createdAt: updatedAt,
            retry: {
              kind: "retry",
              reusedThread: true,
              ...(retriedWorkflow.merge.error?.startsWith("Invalid document:")
                ? { formatRepair: true as const }
                : {}),
              priorFailure: retriedWorkflow.merge.error ?? undefined,
            },
          });
          return { status: "started" as const };
        } else if (mode === "fresh") {
          const mergeRetryWorkflow: PlanningWorkflow = {
            ...retriedWorkflow,
            merge: {
              ...retriedWorkflow.merge,
              threadId: null,
              turnId: null,
              outputFilePath: null,
              approvedPlanId: null,
              status: "not_started",
              error: null,
              updatedAt,
            },
            updatedAt,
          };
          yield* maybeStartMerge(mergeRetryWorkflow, snapshot, updatedAt, {
            kind: "retry",
            reusedThread: false,
            priorFailure: retriedWorkflow.merge.error ?? undefined,
          });
          const refreshed = yield* orchestrationEngine.getReadModel();
          retriedWorkflow =
            refreshed.planningWorkflows.find((entry) => entry.id === retriedWorkflow.id) ??
            retriedWorkflow;
        }
      }

      if (retriedWorkflow.implementation?.status === "error") {
        if (retriedWorkflow.implementation.errorStage === "implementation-start") {
          retriedWorkflow = yield* resumeImplementationStart(retriedWorkflow, snapshot, updatedAt);
        } else if (retriedWorkflow.implementation.errorStage === "review-setup") {
          const resumedWorkflow: PlanningWorkflow = {
            ...retriedWorkflow,
            implementation: {
              ...retriedWorkflow.implementation,
              status: "implemented",
              error: null,
              errorStage: null,
              updatedAt,
            },
            updatedAt,
          };
          yield* upsertWorkflow(resumedWorkflow);
          yield* maybeStartCodeReviews(resumedWorkflow, snapshot, updatedAt);
          const refreshed = yield* orchestrationEngine.getReadModel();
          retriedWorkflow =
            refreshed.planningWorkflows.find((entry) => entry.id === resumedWorkflow.id) ??
            resumedWorkflow;
        } else {
          const failedReviews = retriedWorkflow.implementation.codeReviews.filter(
            (review) => review.status === "error",
          );
          if (failedReviews.length > 0) {
            for (const review of failedReviews) {
              const mode = deliveryMode(review.threadId);
              if (mode === "queued" || mode === "retry") {
                continue;
              }
              if (mode === "accepted") {
                const completedWorkflow = yield* maybeAdvanceImplementationLifecycle(
                  retriedWorkflow,
                  snapshot,
                  review.threadId,
                  updatedAt,
                );
                if (completedWorkflow !== retriedWorkflow) {
                  retriedWorkflow = completedWorkflow;
                  continue;
                }
              } else {
                yield* startCodeReviewTurn({
                  orchestrationEngine,
                  workflow: retriedWorkflow,
                  reviewerSlot: review.reviewerSlot,
                  reviewThreadId: review.threadId,
                  mergedPlanMarkdown: mergedPlanMarkdown!,
                  reviewerLabel: review.reviewerLabel,
                  lensBranch: codeReviewLensBranch(retriedWorkflow, review.threadId),
                  reviewArtifact: implementationReviewPromptArtifact(retriedWorkflow),
                  thread: snapshot.threads.find((thread) => thread.id === review.threadId),
                  createdAt: updatedAt,
                  retry: {
                    kind: "retry",
                    reusedThread: true,
                    priorFailure: review.error ?? undefined,
                  },
                });
              }
              retriedWorkflow = setCodeReviewRunning(retriedWorkflow, review.threadId);
              yield* upsertWorkflow(retriedWorkflow);
            }
          } else {
            const implementation = retriedWorkflow.implementation;
            if (!implementation.threadId) {
              return yield* Effect.fail(new Error("Implementation thread not found for retry."));
            }
            const mode = deliveryMode(implementation.threadId);
            if (mode !== "queued" && mode !== "retry") {
              if (mode === "accepted") {
                const completedWorkflow = yield* maybeAdvanceImplementationLifecycle(
                  retriedWorkflow,
                  snapshot,
                  implementation.threadId,
                  updatedAt,
                );
                if (completedWorkflow !== retriedWorkflow) {
                  retriedWorkflow = completedWorkflow;
                } else {
                  const retryStatus =
                    implementation.codeReviews.length > 0 &&
                    implementation.codeReviews.every((review) => review.status === "completed")
                      ? "applying_reviews"
                      : "implementing";
                  retriedWorkflow = {
                    ...retriedWorkflow,
                    implementation: {
                      ...implementation,
                      status: retryStatus,
                      error: null,
                      retryCount: 0,
                      lastRetryAt: null,
                      updatedAt,
                    },
                    updatedAt,
                  };
                  yield* upsertWorkflow(retriedWorkflow);
                }
              } else {
                yield* retryImplementationTurn({
                  workflow: retriedWorkflow,
                  thread: implementationThread!,
                  createdAt: updatedAt,
                });
                const retryStatus =
                  implementation.codeReviews.length > 0 &&
                  implementation.codeReviews.every((review) => review.status === "completed")
                    ? "applying_reviews"
                    : "implementing";
                retriedWorkflow = {
                  ...retriedWorkflow,
                  implementation: {
                    ...implementation,
                    status: retryStatus,
                    error: null,
                    retryCount: 0,
                    lastRetryAt: null,
                    updatedAt,
                  },
                  updatedAt,
                };
                yield* upsertWorkflow(retriedWorkflow);
              }
            }
          }
        }
      }

      const latestSnapshot = yield* orchestrationEngine.getReadModel();
      retriedWorkflow =
        latestSnapshot.planningWorkflows.find((entry) => entry.id === retriedWorkflow.id) ??
        retriedWorkflow;
      yield* maybeContinuePlanningWorkflowLifecycle(
        retriedWorkflow,
        latestSnapshot,
        updatedAt,
        handledRevisionThreads,
      );
      yield* maybeContinueImplementationLifecycle(retriedWorkflow, latestSnapshot, updatedAt);

      return { status: "started" as const };
    }).pipe(
      Effect.mapError((error) =>
        error instanceof Error
          ? error
          : new Error(error === null ? "Workflow retry failed." : String(error)),
      ),
      (effect) => withWorkflowRetryGate(input.workflowId, effect),
    );

  const skipDocumentReaderPass: WorkflowServiceShape["skipDocumentReaderPass"] = (input) =>
    Effect.gen(function* () {
      const snapshot = yield* orchestrationEngine.getReadModel();
      const workflow = snapshot.planningWorkflows.find(
        (entry) => entry.id === input.workflowId && !entry.deletedAt,
      );
      if (!workflow || !isDocumentWorkflow(workflow) || workflow.readerPass?.status !== "error")
        return yield* Effect.fail(new Error("Only a failed document reader pass can be skipped."));
      for (const threadId of [workflow.readerPass.readerThreadId, workflow.merge.threadId]) {
        if (!threadId) continue;
        const thread = snapshot.threads.find((entry) => entry.id === threadId);
        if (hasRunningSessionTurn(thread))
          return yield* Effect.fail(
            new Error("Wait for the active turn to finish before skipping reader review."),
          );
        const delivery = yield* deliveryForStage(
          threadId,
          workflow.readerPass.readerStartedAt ?? workflow.readerPass.updatedAt,
        );
        if (delivery && ["pending", "sending", "ambiguous"].includes(delivery.state))
          return yield* Effect.fail(
            new Error("Resolve the pending provider delivery before skipping reader review."),
          );
        if (
          delivery?.state === "accepted" &&
          !isSessionUnavailableForReconciliation(thread) &&
          (!thread?.latestTurn ||
            thread.latestTurn.requestedAt < delivery.createdAt ||
            thread.latestTurn.state === "running")
        ) {
          return yield* Effect.fail(
            new Error(
              "Wait for the accepted provider turn to finish before skipping reader review.",
            ),
          );
        }
      }
      yield* upsertWorkflow(markReaderPassSkipped(workflow, new Date().toISOString()));
      return { status: "completed" as const };
    });

  const workflowForThread: WorkflowServiceShape["workflowForThread"] = (threadId) =>
    orchestrationEngine.getReadModel().pipe(
      Effect.map((snapshot) => {
        for (const workflow of snapshot.planningWorkflows) {
          if (isDeletedWorkflow(workflow)) {
            continue;
          }
          const match = labelForThread(workflow, threadId);
          if (match) {
            return match;
          }
        }
        return null;
      }),
      Effect.tapError((error) =>
        Effect.logWarning("WorkflowService.workflowForThread: snapshot lookup failed", {
          threadId,
          cause: error,
        }),
      ),
      Effect.orElseSucceed(() => null),
    );

  yield* registerShutdown("planning-workflows-titles", "drain", () => titleGenerationWorker.drain, [
    "provider-ingestion",
  ]);

  yield* Effect.addFinalizer(() => sources.stop);

  return {
    start,
    drain: titleGenerationWorker.drain,
    createWorkflow,
    archiveWorkflow,
    unarchiveWorkflow,
    deleteWorkflow,
    retryWorkflow,
    skipDocumentReaderPass,
    startImplementation,
    workflowForThread,
  } satisfies WorkflowServiceShape;
});

/** Which of the two review lenses an author's reviews use, by roster position parity. */
function lensBranchFor(branchId: WorkflowBranchId): "a" | "b" {
  return workflowParticipantIndex(branchId) % 2 === 0 ? "a" : "b";
}

/** An implementation reviewer's lens, by its position among the code reviews. */
function codeReviewLensBranch(workflow: PlanningWorkflow, threadId: ThreadId): "a" | "b" {
  const index = workflow.implementation?.codeReviews.findIndex(
    (review) => review.threadId === threadId,
  );
  return index !== undefined && index > 0 && index % 2 === 1 ? "b" : "a";
}

function createWorkflowThread({
  orchestrationEngine,
  input,
  threadId,
  suffix,
  slot,
  now,
}: {
  orchestrationEngine: OrchestrationEngineShape;
  input: CreateWorkflowInput;
  threadId: ThreadId;
  suffix: string;
  slot: WorkflowModelSlot;
  now: string;
}) {
  return createWorkflowStageThread({
    orchestrationEngine,
    threadId,
    projectId: input.projectId,
    title: suffix,
    model: slot.model,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: WORKFLOW_PLANNING_INTERACTION_MODE,
    // The lane is not a Git branch; authors work in the project checkout.
    branch: null,
    worktreePath: null,
    createdAt: now,
  });
}

function startAuthoringTurn({
  orchestrationEngine,
  workflow,
  branch,
  createdAt,
  retry,
}: {
  orchestrationEngine: OrchestrationEngineShape;
  workflow: PlanningWorkflow;
  branch: WorkflowBranch;
  createdAt: string;
  retry?: WorkflowRetryContext;
}) {
  const budgetError = workflowBudgetError(workflow);
  if (budgetError) return Effect.fail(budgetError);
  const prompt = (isDocumentWorkflow(workflow) ? buildDocumentAuthorPrompt : buildAuthorPrompt)({
    workflow,
    branch,
    authorSlot: branch.authorSlot,
    retry,
    maxPlanChars: workflowPlanCharBudget(workflow),
  });
  const promptError = workflowPromptInvariant({
    workflow,
    prompt,
    artifacts: [workflow.requirementPrompt],
    targetSlot: branch.authorSlot,
    artifactLabel: "Author requirement",
  });
  if (promptError) return Effect.fail(promptError);
  return orchestrationEngine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe(timeOrderedUuid()),
    threadId: branch.authorThreadId,
    message: {
      messageId: MessageId.makeUnsafe(crypto.randomUUID()),
      role: "user",
      text: prompt,
      attachments: [],
    },
    ...workflowTurnProviderFields(branch.authorSlot),
    titleSourceText: workflow.title,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    ...workflowTurnBehaviorFields({
      runKind: "planning",
      templateId: workflow.templateId,
      templateVersion: workflow.templateVersion,
      stage: "author",
    }),
    createdAt,
  });
}

function createReviewThread({
  orchestrationEngine,
  workflow,
  reviewerSlot,
  reviewedBranchId,
  reviewerBranchId,
  reviewSlot,
  threadId,
  createdAt,
}: {
  orchestrationEngine: OrchestrationEngineShape;
  workflow: PlanningWorkflow;
  reviewerSlot: WorkflowModelSlot;
  reviewedBranchId: WorkflowBranchId;
  reviewerBranchId: WorkflowBranchId;
  reviewSlot: WorkflowReviewSlot;
  threadId: ThreadId;
  createdAt: string;
}) {
  return orchestrationEngine.dispatch({
    type: "thread.create",
    commandId: stableWorkflowCommandId("create-plan-review-thread", workflow.id, threadId),
    threadId,
    projectId: workflow.projectId,
    title:
      reviewSlot === "cross" && workflowUsesMesh(planningBranches(workflow).length)
        ? `Review ${workflowParticipantLabel(reviewedBranchId)} by ${workflowParticipantLabel(reviewerBranchId)}`
        : `Review ${reviewedBranchId.toUpperCase()} ${reviewSlot === "cross" ? "Cross" : "Self"}`,
    model: reviewerSlot.model,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: WORKFLOW_PLANNING_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    createdAt,
  });
}

function startReviewTurn({
  orchestrationEngine,
  workflow,
  reviewerSlot,
  reviewThreadId,
  planMarkdown,
  planTurnId,
  reviewKind,
  reviewedBranchId,
  createdAt,
  retry,
  attempt = 0,
}: {
  orchestrationEngine: OrchestrationEngineShape;
  workflow: PlanningWorkflow;
  reviewerSlot: WorkflowModelSlot;
  reviewThreadId: ThreadId;
  planMarkdown: string;
  planTurnId: string | null;
  reviewKind: WorkflowReviewSlot;
  reviewedBranchId: WorkflowBranchId;
  createdAt: string;
  retry?: WorkflowRetryContext;
  attempt?: number;
}) {
  const budgetError = workflowBudgetError(workflow);
  if (budgetError) return Effect.fail(budgetError);
  const documentType = planningWorkflowDocumentType(workflow);
  const prompt = (documentType ? buildDocumentReviewPrompt : buildReviewPrompt)({
    documentType: documentType ?? "custom",
    requirementPrompt: workflow.requirementPrompt,
    planMarkdown,
    planSource: {
      workflowId: workflow.id,
      stage: "author",
      ...(planTurnId ? { turnId: planTurnId } : {}),
    },
    reviewKind,
    lensBranch: lensBranchFor(reviewedBranchId),
    reviewerSlot,
    retry,
  });
  const promptError = workflowPromptInvariant({
    workflow,
    prompt,
    artifacts: [planMarkdown],
    targetSlot: reviewerSlot,
    artifactLabel: "Plan under review",
  });
  if (promptError) return Effect.fail(promptError);
  const attemptKey = retry?.kind === "retry" ? `retry:${attempt}:${createdAt}` : "initial";
  return orchestrationEngine.dispatch({
    type: "thread.turn.start",
    commandId: stableWorkflowCommandId(
      "start-plan-review",
      workflow.id,
      reviewThreadId,
      attemptKey,
    ),
    threadId: reviewThreadId,
    message: {
      messageId: MessageId.makeUnsafe(
        stableWorkflowUuid("plan-review-message", workflow.id, reviewThreadId, attemptKey),
      ),
      role: "user",
      text: prompt,
      attachments: [],
    },
    ...workflowTurnProviderFields(reviewerSlot),
    titleSourceText: workflow.title,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    ...workflowTurnBehaviorFields({
      runKind: "planning",
      templateId: workflow.templateId,
      templateVersion: workflow.templateVersion,
      stage: "plan-review",
    }),
    createdAt,
  });
}

export function prepareRevisionTurn({
  workflow,
  branch,
  originalPlanMarkdown,
  reviews,
  thread,
  createdAt,
  retry,
  originalPlanCreatedAt,
}: {
  workflow: PlanningWorkflow;
  branch: WorkflowBranch;
  originalPlanMarkdown: string;
  reviews: ReadonlyArray<{
    readonly reviewerLabel: string;
    readonly reviewMarkdown: string;
    readonly source: Parameters<typeof buildRevisionPrompt>[0]["reviews"][number]["source"];
  }>;
  thread?:
    | (WorkflowFitThread & {
        readonly compaction?: { readonly createdAt: string } | null;
      })
    | undefined;
  createdAt: string;
  retry?: WorkflowRetryContext;
  /** When the reviewed plan was produced; a retry resends it only after a later compaction. */
  originalPlanCreatedAt?: string | undefined;
}): { readonly command: ThreadTurnStartCommand } | { readonly rejection: string } {
  const budgetError = workflowBudgetError(workflow);
  if (budgetError) return { rejection: budgetError.detail };
  // Only a manual retry passes the pinned plan's time, and the plan travels again
  // only when the author thread was compacted past it, format retries included.
  // Automatic format repair runs in a thread that still holds the plan.
  const includeOriginalPlan =
    retry?.kind === "retry" &&
    originalPlanCreatedAt !== undefined &&
    !!thread?.compaction &&
    thread.compaction.createdAt > originalPlanCreatedAt;
  const documentType = planningWorkflowDocumentType(workflow);
  const renderRevisionPrompt = (promptReviews: typeof reviews) =>
    (documentType ? buildDocumentRevisionPrompt : buildRevisionPrompt)({
      documentType: documentType ?? "custom",
      requirementPrompt: workflow.requirementPrompt,
      originalPlan: {
        markdown: originalPlanMarkdown,
        source: {
          workflowId: workflow.id,
          stage: `author-${branch.branchId}`,
          ...(branch.planTurnId ? { turnId: branch.planTurnId } : {}),
        },
      },
      reviews: promptReviews,
      targetSlot: branch.authorSlot,
      retry,
      includeOriginalPlan,
      maxPlanChars: workflowPlanCharBudget(workflow),
    });
  let prompt = renderRevisionPrompt(reviews);
  let renderedReviews = reviews;
  if (
    workflowUsesMesh(planningBranches(workflow).length) &&
    prompt.length > WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT
  ) {
    // With three or more authors each revision carries up to four reviews; a retry can't shrink
    // paid reviews, so they share the message and the longest ones are excerpted.
    const budgeted = excerptRevisionReviews(
      reviews,
      WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT -
        renderRevisionPrompt(reviews.map((review) => ({ ...review, reviewMarkdown: "" }))).length,
    );
    if (
      budgeted.smallestExcerpt !== null &&
      budgeted.smallestExcerpt < WORKFLOW_FAN_IN_MIN_ARTIFACT_CHARS
    ) {
      return {
        rejection: `The reviews for Branch ${branch.branchId.toUpperCase()} leave ${budgeted.smallestExcerpt.toLocaleString("en-US")} characters per review in the revision message. Revise it manually in that thread, or restart the workflow with fewer authors.`,
      };
    }
    renderedReviews = budgeted.reviews;
    prompt = renderRevisionPrompt(renderedReviews);
  }
  if (includeOriginalPlan && prompt.length > WORKFLOW_RENDERED_MESSAGE_CHAR_LIMIT) {
    // Compacting again can't shrink this: the plan itself has to travel in the message.
    return {
      rejection: `The reviewed ${documentType ? "draft" : "plan"} and its reviews (${prompt.length.toLocaleString("en-US")} characters) no longer fit in one message now that the Branch ${branch.branchId.toUpperCase()} author conversation was compacted. Revise it manually in that thread, or restart the workflow with shorter reviews.`,
    };
  }
  const promptError = workflowPromptInvariant({
    workflow,
    prompt,
    artifacts: [originalPlanMarkdown, ...renderedReviews.map((review) => review.reviewMarkdown)],
    targetSlot: branch.authorSlot,
    artifactLabel: "Revision inputs",
    artifactBudgetRecovery: `Compact the Branch ${branch.branchId.toUpperCase()} author conversation, then retry.`,
    ...(thread ? { thread } : {}),
  });
  if (promptError) return { rejection: promptError.detail };
  const attemptKey =
    retry?.kind === "retry"
      ? `retry:${branch.retryCount}:${branch.revisionFormatRepairAttempts ?? 0}:${createdAt}`
      : "initial";
  const command: ThreadTurnStartCommand = {
    type: "thread.turn.start",
    commandId: stableWorkflowCommandId(
      "start-plan-revision",
      workflow.id,
      branch.branchId,
      branch.planTurnId,
      attemptKey,
    ),
    threadId: branch.authorThreadId,
    message: {
      messageId: MessageId.makeUnsafe(
        stableWorkflowUuid(
          "plan-revision-message",
          workflow.id,
          branch.branchId,
          branch.planTurnId,
          attemptKey,
        ),
      ),
      role: "user",
      text: prompt,
      attachments: [],
    },
    ...workflowTurnProviderFields(branch.authorSlot),
    titleSourceText: workflow.title,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    ...workflowTurnBehaviorFields({
      runKind: "planning",
      templateId: workflow.templateId,
      templateVersion: workflow.templateVersion,
      stage: "revision",
    }),
    createdAt,
  };
  return { command };
}

function startMergeTurn({
  orchestrationEngine,
  workflow,
  threadId,
  plans,
  createdAt,
  retry,
}: {
  orchestrationEngine: OrchestrationEngineShape;
  workflow: PlanningWorkflow;
  threadId: ThreadId;
  /** Every branch's revised plan, in author order (see `collectMergeInputs`). */
  plans: ReadonlyArray<string>;
  createdAt: string;
  retry?: WorkflowRetryContext;
}) {
  const budgetError = workflowBudgetError(workflow);
  if (budgetError) return Effect.fail(budgetError);
  const prompt = buildWorkflowMergePrompt(workflow, plans, retry);
  const promptError = workflowPromptInvariant({
    workflow,
    prompt,
    artifacts: plans,
    targetSlot: workflow.merge.mergeSlot,
    artifactLabel: "Merge inputs",
  });
  if (promptError) return Effect.fail(promptError);
  const attemptKey =
    retry?.kind === "retry"
      ? `retry:${workflow.merge.formatRepairAttempts ?? 0}:${createdAt}`
      : "initial";
  return orchestrationEngine.dispatch({
    type: "thread.turn.start",
    commandId: stableWorkflowCommandId("start-plan-merge", workflow.id, threadId, attemptKey),
    threadId,
    message: {
      messageId: MessageId.makeUnsafe(
        stableWorkflowUuid("plan-merge-message", workflow.id, threadId, attemptKey),
      ),
      role: "user",
      text: prompt,
      attachments: [],
    },
    ...workflowTurnProviderFields(workflow.merge.mergeSlot),
    titleSourceText: workflow.title,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    ...workflowTurnBehaviorFields({
      runKind: "planning",
      templateId: workflow.templateId,
      templateVersion: workflow.templateVersion,
      stage: "merge",
    }),
    createdAt,
  });
}

function createCodeReviewThread({
  orchestrationEngine,
  workflow,
  reviewerSlot,
  threadId,
  reviewerLabel,
  createdAt,
}: {
  orchestrationEngine: OrchestrationEngineShape;
  workflow: PlanningWorkflow;
  reviewerSlot: WorkflowModelSlot;
  threadId: ThreadId;
  reviewerLabel: string;
  createdAt: string;
}) {
  return orchestrationEngine.dispatch({
    type: "thread.create",
    commandId: CommandId.makeUnsafe(timeOrderedUuid()),
    threadId,
    projectId: workflow.projectId,
    title: `Code Review (${reviewerLabel})`,
    model: reviewerSlot.model,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    createdAt,
  });
}

function implementationReviewPromptArtifact(
  workflow: PlanningWorkflow,
): Parameters<typeof buildCodeReviewPrompt>[0]["reviewArtifact"] {
  const artifact = workflow.implementation?.reviewArtifact;
  return artifact
    ? {
        patchText: artifact.patchText,
        fullPatchHash: artifact.fullPatchHash,
        truncated: artifact.truncated,
        truncationReason: artifact.truncationReason,
        source: {
          workflowId: workflow.id,
          stage: "implementation",
          ...(workflow.implementation?.implementationTurnId
            ? { turnId: workflow.implementation.implementationTurnId }
            : {}),
        },
      }
    : {
        patchText:
          "The implementation delta is in the current workspace. Inspect it with read-only Git commands, including committed, staged, unstaged, and untracked changes. If the workspace contains nested Git repositories, inspect every repository affected by the implementation.",
        source: {
          workflowId: workflow.id,
          stage: "implementation",
          ...(workflow.implementation?.implementationTurnId
            ? { turnId: workflow.implementation.implementationTurnId }
            : {}),
        },
      };
}

function startCodeReviewTurn({
  orchestrationEngine,
  workflow,
  reviewerSlot,
  reviewThreadId,
  mergedPlanMarkdown,
  reviewerLabel,
  lensBranch,
  reviewArtifact,
  createdAt,
  retry,
  preparedPrompt,
  thread,
}: {
  orchestrationEngine: OrchestrationEngineShape;
  workflow: PlanningWorkflow;
  reviewerSlot: WorkflowModelSlot;
  reviewThreadId: ThreadId;
  mergedPlanMarkdown: string;
  reviewerLabel: string;
  lensBranch: "a" | "b";
  reviewArtifact: Parameters<typeof buildCodeReviewPrompt>[0]["reviewArtifact"];
  createdAt: string;
  retry?: WorkflowRetryContext;
  preparedPrompt?: string | undefined;
  thread?: WorkflowFitThread | undefined;
}) {
  const budgetError = workflowBudgetError(workflow);
  if (budgetError) return Effect.fail(budgetError);
  const prepared =
    preparedPrompt === undefined
      ? prepareCodeReviewPrompt({
          mergedPlanMarkdown,
          requirementPrompt: workflow.requirementPrompt,
          reviewArtifact,
          reviewerLabel,
          lensBranch,
          reviewerSlot,
          retry,
          thread,
          enforceArtifactBudget: resolveWorkflowBehavior({
            runKind: "planning",
            templateId: workflow.templateId,
            templateVersion: workflow.templateVersion,
          }).loudAuthoritativeArtifactLimit,
        })
      : { prompt: preparedPrompt };
  if (!("prompt" in prepared)) return Effect.fail(prepared);
  return orchestrationEngine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe(timeOrderedUuid()),
    threadId: reviewThreadId,
    message: {
      messageId: MessageId.makeUnsafe(crypto.randomUUID()),
      role: "user",
      text: prepared.prompt,
      attachments: [],
    },
    ...workflowTurnProviderFields(reviewerSlot),
    titleSourceText: workflow.title,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    ...workflowTurnBehaviorFields({
      runKind: "planning",
      templateId: workflow.templateId,
      templateVersion: workflow.templateVersion,
      stage: "implementation-review",
    }),
    createdAt,
  });
}

function dispatchWorkflowDeleteCompensation(input: {
  orchestrationEngine: OrchestrationEngineShape;
  workflowId: PlanningWorkflowId;
  projectId: CreateWorkflowInput["projectId"];
  createdAt: string;
}) {
  return dispatchWorkflowDeleteCompensationCommand({ kind: "planning", ...input });
}

export const WorkflowServiceLive = Layer.effect(WorkflowService, makeWorkflowService);
