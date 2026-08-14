import { Effect, Exit, Layer, ManagedRuntime, Scope, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { CodeReviewWorkflowService } from "../Services/CodeReviewWorkflowService.ts";
import { CompactionService } from "../Services/CompactionService.ts";
import { InvestigationWorkflowService } from "../Services/InvestigationWorkflowService.ts";
import { ProjectSkillSyncService } from "../Services/ProjectSkillSyncService.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { SessionNotesService } from "../Services/SessionNotesService.ts";
import { OrchestrationReactor } from "../Services/OrchestrationReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { WorkflowService } from "../Services/WorkflowService.ts";
import { makeOrchestrationReactor } from "./OrchestrationReactor.ts";
import { NextTurnQueueDispatcher } from "../../nextTurnQueue/Services/NextTurnQueueDispatcher.ts";
import { ProviderTurnDeliveryWorker } from "../Services/ProviderTurnDeliveryWorker.ts";
import { createEmptyReadModel } from "../projector.ts";

describe("OrchestrationReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<OrchestrationReactor, never> | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  it("starts provider ingestion, provider command, and checkpoint reactors", async () => {
    const started: string[] = [];

    runtime = ManagedRuntime.make(
      Layer.effect(OrchestrationReactor, makeOrchestrationReactor).pipe(
        Layer.provideMerge(
          Layer.succeed(OrchestrationEngineService, {
            getReadModel: () => Effect.succeed(createEmptyReadModel(new Date(0).toISOString())),
            readEvents: () => Stream.empty,
            dispatch: () => Effect.die("unsupported"),
            acquireMaintenanceLock: () => Effect.die("unsupported"),
            streamDomainEvents: Stream.empty,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ProviderTurnDeliveryWorker, {
            start: Effect.sync(() => {
              started.push("provider-turn-delivery-worker");
            }),
            drain: Effect.void,
            outcomes: Stream.empty,
            acknowledgeOutcome: () => Effect.void,
            recheck: () => Effect.succeed(null),
            retry: () => Effect.die("unsupported"),
            discard: () => Effect.die("unsupported"),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(NextTurnQueueDispatcher, {
            start: Effect.sync(() => {
              started.push("next-turn-queue-dispatcher");
            }),
            notify: () => Effect.void,
            drain: Effect.void,
            submitAndSettle: () => Effect.die("unsupported"),
            getSnapshot: () => Effect.die("unsupported"),
            getSummary: Effect.die("unsupported"),
            promote: () => Effect.die("unsupported"),
            refreshGate: () => Effect.die("unsupported"),
            handleDeliveryOutcome: () => Effect.void,
            changes: Stream.empty,
            summaryChanges: Stream.empty,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ProviderRuntimeIngestionService, {
            start: Effect.sync(() => {
              started.push("provider-runtime-ingestion");
            }),
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ProviderCommandReactor, {
            start: Effect.sync(() => {
              started.push("provider-command-reactor");
            }),
            drain: Effect.void,
            deliverTurnStart: () => Effect.die("unsupported"),
            recordTurnStartFailure: () => Effect.void,
            applyMcpConfigToLiveSessions: (_input) =>
              Effect.die(new Error("unused in OrchestrationReactor tests")),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(CheckpointReactor, {
            start: Effect.sync(() => {
              started.push("checkpoint-reactor");
            }),
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(CompactionService, {
            start: Effect.sync(() => {
              started.push("compaction-service");
            }),
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ProjectSkillSyncService, {
            start: Effect.sync(() => {
              started.push("project-skill-sync-service");
            }),
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(SessionNotesService, {
            start: Effect.sync(() => {
              started.push("session-notes-service");
            }),
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(WorkflowService, {
            start: Effect.sync(() => {
              started.push("workflow-service");
            }),
            drain: Effect.void,
            createWorkflow: () => Effect.die("unsupported"),
            archiveWorkflow: () => Effect.die("unsupported"),
            unarchiveWorkflow: () => Effect.die("unsupported"),
            deleteWorkflow: () => Effect.die("unsupported"),
            retryWorkflow: () => Effect.die("unsupported"),
            startImplementation: () => Effect.die("unsupported"),
            workflowForThread: () => Effect.succeed(null),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(CodeReviewWorkflowService, {
            start: Effect.sync(() => {
              started.push("code-review-workflow-service");
            }),
            drain: Effect.void,
            createWorkflow: () => Effect.die("unsupported"),
            archiveWorkflow: () => Effect.die("unsupported"),
            unarchiveWorkflow: () => Effect.die("unsupported"),
            deleteWorkflow: () => Effect.die("unsupported"),
            retryWorkflow: () => Effect.die("unsupported"),
            workflowForThread: () => Effect.succeed(null),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(InvestigationWorkflowService, {
            start: Effect.sync(() => {
              started.push("investigation-workflow-service");
            }),
            drain: Effect.void,
            createWorkflow: () => Effect.die("unsupported"),
            archiveWorkflow: () => Effect.die("unsupported"),
            unarchiveWorkflow: () => Effect.die("unsupported"),
            deleteWorkflow: () => Effect.die("unsupported"),
            retryWorkflow: () => Effect.die("unsupported"),
            workflowForThread: () => Effect.succeed(null),
          }),
        ),
      ),
    );

    const reactor = await runtime.runPromise(Effect.service(OrchestrationReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start.pipe(Scope.provide(scope)));

    expect(started).toEqual([
      "provider-runtime-ingestion",
      "provider-command-reactor",
      "provider-turn-delivery-worker",
      "checkpoint-reactor",
      "compaction-service",
      "project-skill-sync-service",
      "session-notes-service",
      "workflow-service",
      "code-review-workflow-service",
      "investigation-workflow-service",
      "next-turn-queue-dispatcher",
    ]);

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});
