import {
  CommandId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationUsageLimit,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import type { ProviderTurnDeliveryOutcome } from "../Services/ProviderTurnDeliveryWorker.ts";
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

  it.each([false, true, "newer-session", "projection-failure"] as const)(
    "starts reactors and safely projects usage rejection replay (%s)",
    async (replayLimit) => {
      const started: string[] = [];
      const threadId = ThreadId.makeUnsafe("usage-delivery-thread");
      const deliveryId = CommandId.makeUnsafe("usage-delivery-id");
      const usageLimit: OrchestrationUsageLimit = {
        windows: [],
        resetsAt: "2026-10-02T00:00:00.000Z",
        resetSource: "provider",
        evidence: "typed",
        providerInstanceId: ProviderInstanceId.makeUnsafe("claude-instance"),
        turnId: null,
        deliveryId,
      };
      const outcome: ProviderTurnDeliveryOutcome = {
        threadId,
        deliveryId,
        commandId: deliveryId,
        state: "rejected",
        detail: "Usage limit reached",
        occurredAt: "2026-10-02T00:00:00.000Z",
        usageLimit,
      };
      let session: unknown =
        replayLimit === "newer-session"
          ? {
              status: "ready",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2026-10-03T00:00:00.000Z",
            }
          : null;
      const writes: OrchestrationCommand[] = [];
      let acknowledged = 0;
      let resumes = 0;
      let queueOutcomes = 0;
      let projectionAttempts = 0;

      runtime = ManagedRuntime.make(
        Layer.effect(OrchestrationReactor, makeOrchestrationReactor).pipe(
          Layer.provideMerge(
            Layer.succeed(OrchestrationEngineService, {
              getReadModel: () =>
                Effect.succeed({
                  ...createEmptyReadModel(new Date(0).toISOString()),
                  threads: replayLimit
                    ? [{ id: threadId, session, runtimeMode: "full-access" } as never]
                    : [],
                }),
              readEvents: () => Stream.empty,
              dispatch: (command) =>
                replayLimit === "projection-failure" && projectionAttempts++ === 0
                  ? Effect.fail(new Error("projection unavailable") as never)
                  : Effect.sync(() => {
                      writes.push(command);
                      if (command.type === "thread.session.set") session = command.session;
                      return { sequence: writes.length };
                    }),
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
              outcomes: replayLimit ? Stream.fromIterable([outcome, outcome]) : Stream.empty,
              acknowledgeOutcome: () =>
                Effect.sync(() => {
                  acknowledged += 1;
                }),
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
              scheduleUsageLimitResume: () =>
                Effect.sync(() => {
                  resumes += 1;
                }).pipe(Effect.andThen(Effect.die("Unexpected continue for an unsent message"))),
              cancelUsageLimitResume: () => Effect.die("unsupported"),
              refreshUsageLimitResume: () => Effect.die("unsupported"),
              handleDeliveryOutcome: () =>
                Effect.sync(() => {
                  queueOutcomes += 1;
                }),
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
              skipDocumentReaderPass: () => Effect.succeed({ status: "completed" as const }),
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

      for (let index = 0; index < 20; index += 1) await runtime.runPromise(Effect.yieldNow);
      if (replayLimit === "newer-session") {
        expect(writes).toHaveLength(0);
        expect(acknowledged).toBe(2);
      } else if (replayLimit) {
        expect(writes).toHaveLength(1);
        const write = writes[0];
        expect(write?.type).toBe("thread.session.set");
        if (write?.type === "thread.session.set") {
          expect(write.session.usageLimit).toEqual(usageLimit);
          expect(write.session.activeTurnId).toBeNull();
          expect(write.session.lastError).toBe("Usage limit reached");
        }
        expect(acknowledged).toBe(replayLimit === "projection-failure" ? 1 : 2);
      }
      if (replayLimit) expect(queueOutcomes).toBe(2);
      expect(resumes).toBe(0);
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  );
});
