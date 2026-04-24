import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { CodeReviewWorkflowService } from "../Services/CodeReviewWorkflowService.ts";
import { CompactionService } from "../Services/CompactionService.ts";
import { ProjectSkillSyncService } from "../Services/ProjectSkillSyncService.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { SessionNotesService } from "../Services/SessionNotesService.ts";
import { OrchestrationReactor } from "../Services/OrchestrationReactor.ts";
import { WorkflowService } from "../Services/WorkflowService.ts";
import { makeOrchestrationReactor } from "./OrchestrationReactor.ts";

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
      ),
    );

    const reactor = await runtime.runPromise(Effect.service(OrchestrationReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start.pipe(Scope.provide(scope)));

    expect(started).toEqual([
      "provider-runtime-ingestion",
      "provider-command-reactor",
      "checkpoint-reactor",
      "compaction-service",
      "project-skill-sync-service",
      "session-notes-service",
      "workflow-service",
      "code-review-workflow-service",
    ]);

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});
