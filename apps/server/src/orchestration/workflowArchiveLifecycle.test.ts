import { CommandId, MessageId, ThreadId, PlanningWorkflow } from "@t3tools/contracts";
import { withEventBase } from "./eventBase";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { applyArchiveTestCommand, workflowArchiveFixture } from "./workflowArchive.testUtils.ts";
import {
  decideWorkflowDelete,
  reconcileWorkflowArchives,
  retainedWorkflowThreadIds,
  workflowEntries,
} from "./workflowArchiveLifecycle.ts";
import {
  summarizePlanningWorkflow,
  summarizeCodeReviewWorkflow,
  summarizeInvestigationWorkflow,
} from "@t3tools/shared/workflowSummary";

describe.each(["planning", "codeReview", "investigation"] as const)(
  "workflow archive (%s)",
  (kind) => {
    it("deletes children atomically, preserves record-only compatibility and refuses shared ownership", () => {
      const fixture = workflowArchiveFixture(kind);
      const command = fixture.archive();
      const event = {
        type: "thread.deleted" as const,
        ...withEventBase({
          commandId: command.commandId,
          aggregateKind: "thread",
          aggregateId: fixture.a,
          occurredAt: "2026-11-14T12:00:00.000Z",
        }),
        payload: { threadId: fixture.a, deletedAt: "2026-11-14T12:00:00.000Z" },
      };
      const decide = (deleteThreads: boolean, readModel = fixture.model) =>
        Effect.runSync(
          decideWorkflowDelete({
            entry: fixture.entry,
            readModel,
            command,
            deleteThreads,
            event,
          }),
        );
      expect(decide(false)).toMatchObject({ type: "thread.deleted" });
      const events = decide(true);
      expect(
        Array.isArray(events) && events.filter((item) => item.type === "thread.deleted"),
      ).toHaveLength(3);
      const other = workflowArchiveFixture(kind === "planning" ? "codeReview" : "planning");
      const shared = {
        ...fixture.model,
        ...(other.entry.kind === "planning"
          ? { planningWorkflows: [other.entry.workflow] }
          : other.entry.kind === "codeReview"
            ? { codeReviewWorkflows: [other.entry.workflow] }
            : {}),
      };
      expect(() => decide(true, shared)).toThrow("another workflow");
      expect(
        fixture.model.threads.every(
          (thread) => thread.deletedAt === null && thread.archivedAt === null,
        ),
      ).toBe(true);
    });
    it("does not create a new owner for a deleted thread", () => {
      const fixture = workflowArchiveFixture(kind);
      const entry = fixture.entry;
      const base = {
        commandId: CommandId.makeUnsafe("create-after-deletion"),
        projectId: entry.workflow.projectId,
        title: entry.workflow.title,
        slug: entry.workflow.slug,
        createdAt: entry.workflow.createdAt,
      };
      const slot = { provider: "codex" as const, model: "gpt-5-codex" };
      const command =
        entry.kind === "planning"
          ? {
              ...base,
              type: "project.workflow.create" as const,
              workflowId: entry.workflow.id,
              requirementPrompt: "Plan",
              plansDirectory: "/repo/plans",
              selfReviewEnabled: false,
              authorThreadIdA: fixture.a,
              authorThreadIdB: fixture.b,
              branchA: slot,
              branchB: slot,
              merge: slot,
            }
          : entry.kind === "codeReview"
            ? {
                ...base,
                type: "project.code-review-workflow.create" as const,
                workflowId: entry.workflow.id,
                reviewPrompt: "Review",
                branch: null,
                reviewerThreadIdA: fixture.a,
                reviewerThreadIdB: fixture.b,
                reviewerA: slot,
                reviewerB: slot,
                consolidation: slot,
              }
            : {
                ...base,
                type: "project.investigation-workflow.create" as const,
                workflowId: entry.workflow.id,
                problemPrompt: "Investigate",
                branch: null,
                selfReviewEnabled: false,
                investigationThreadIdA: fixture.a,
                investigationThreadIdB: fixture.b,
                investigatorA: slot,
                investigatorB: slot,
                synthesis: slot,
              };
      const model = {
        ...fixture.model,
        planningWorkflows: [],
        codeReviewWorkflows: [],
        investigationWorkflows: [],
        threads: fixture.model.threads.map((thread) => ({
          ...thread,
          deletedAt: "2026-10-19T10:00:00.000Z",
        })),
      };
      expect(() => applyArchiveTestCommand(model, command)).toThrow(
        "Cannot attach a deleted thread",
      );
    });

    it("releases retention when the parent project is deleted", () => {
      const fixture = workflowArchiveFixture(kind);
      expect(retainedWorkflowThreadIds(fixture.model).has(fixture.a)).toBe(true);
      const model = {
        ...fixture.model,
        projects: fixture.model.projects.map((project) => ({
          ...project,
          deletedAt: "2026-10-19T10:00:00.000Z",
        })),
        threads: fixture.model.threads.map((thread) => ({
          ...thread,
          archivedAt: "2026-10-19T10:00:00.000Z",
        })),
      };
      expect(retainedWorkflowThreadIds(model).size).toBe(0);
      expect(() =>
        applyArchiveTestCommand(model, {
          type: "thread.delete",
          commandId: CommandId.makeUnsafe("purge-deleted-project"),
          threadId: fixture.a,
          expectedArchivedAt: "2026-10-19T10:00:00.000Z",
        }),
      ).not.toThrow();
    });

    it("archives children and restores only unchanged children archived by the workflow", () => {
      const fixture = workflowArchiveFixture(kind);
      let model = applyArchiveTestCommand(fixture.model, {
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("independent"),
        threadId: fixture.b,
        createdAt: "2026-10-10T10:00:00.000Z",
      }).model;
      const result = applyArchiveTestCommand(model, fixture.archive());
      model = result.model;
      expect(result.events.map((event) => event.type)).toEqual([
        workflowEntries(model)[0]!.kind === "planning"
          ? "project.workflow-upserted"
          : kind === "codeReview"
            ? "project.code-review-workflow-upserted"
            : "project.investigation-workflow-upserted",
        "thread.archived",
      ]);
      expect(workflowEntries(model)[0]!.workflow.archiveRestorations).toEqual([
        { threadId: fixture.a, archivedAt: "2026-10-19T10:00:00.000Z" },
      ]);
      expect(applyArchiveTestCommand(model, fixture.archive()).events).toHaveLength(1);
      expect(() =>
        applyArchiveTestCommand(model, {
          type: "thread.unarchive",
          commandId: CommandId.makeUnsafe("direct"),
          threadId: fixture.a,
          createdAt: "2026-10-19T10:01:00.000Z",
        }),
      ).toThrow("Restore the owning workflow");
      model = applyArchiveTestCommand(model, fixture.archive(true)).model;
      expect(model.threads.find((thread) => thread.id === fixture.a)?.archivedAt).toBeNull();
      expect(model.threads.find((thread) => thread.id === fixture.b)?.archivedAt).toBe(
        "2026-10-10T10:00:00.000Z",
      );
      expect(workflowEntries(model)[0]!.workflow.archiveRestorations).toEqual([]);
    });

    it("preserves independent later archives and skips deleted children", () => {
      const fixture = workflowArchiveFixture(kind);
      let model = applyArchiveTestCommand(fixture.model, fixture.archive()).model;
      model = {
        ...model,
        threads: model.threads.map((thread) =>
          thread.id === fixture.a
            ? { ...thread, archivedAt: "2026-10-20T10:00:00.000Z" }
            : { ...thread, deletedAt: "2026-10-20T10:00:00.000Z" },
        ),
      };
      const result = applyArchiveTestCommand(model, fixture.archive(true));
      expect(result.events).toHaveLength(1);
      expect(result.model.threads[0]!.archivedAt).toBe("2026-10-20T10:00:00.000Z");
    });

    it("rejects ownership conflicts before producing any changes", () => {
      const fixture = workflowArchiveFixture(kind);
      const other = workflowArchiveFixture(kind === "codeReview" ? "investigation" : "codeReview");
      const model = {
        ...fixture.model,
        codeReviewWorkflows: [
          ...fixture.model.codeReviewWorkflows,
          ...other.model.codeReviewWorkflows,
        ],
        investigationWorkflows: [
          ...fixture.model.investigationWorkflows,
          ...other.model.investigationWorkflows,
        ],
      };
      expect(() => applyArchiveTestCommand(model, fixture.archive())).toThrow(
        "ownership conflicts",
      );
      expect(model.threads.every((thread) => thread.archivedAt === null)).toBe(true);
    });

    it("repairs legacy archives through commands and a second repair does no work", async () => {
      const fixture = workflowArchiveFixture(kind);
      let model = applyArchiveTestCommand(fixture.model, fixture.archive()).model;
      model = {
        ...model,
        threads: model.threads.map((thread) => ({ ...thread, archivedAt: null })),
      };
      const commands: unknown[] = [];
      const engine = {
        getReadModel: () => Effect.succeed(model),
        dispatch: (command: Parameters<typeof applyArchiveTestCommand>[1]) =>
          Effect.sync(() => {
            commands.push(command);
            model = applyArchiveTestCommand(model, command).model;
            return { sequence: model.snapshotSequence };
          }),
      };
      await Effect.runPromise(reconcileWorkflowArchives(engine as never));
      await Effect.runPromise(reconcileWorkflowArchives(engine as never));
      expect(commands).toHaveLength(1);
      expect(model.threads.every((thread) => thread.archivedAt !== null)).toBe(true);
    });
  },
);

it("rejects standalone archived turn admission before saving the message or intent", () => {
  const fixture = workflowArchiveFixture("codeReview");
  const model = applyArchiveTestCommand(
    { ...fixture.model, codeReviewWorkflows: [] },
    {
      type: "thread.archive",
      commandId: CommandId.makeUnsafe("archive"),
      threadId: fixture.a,
      createdAt: "2026-10-19T10:00:00.000Z",
    },
  ).model;
  expect(() =>
    applyArchiveTestCommand(model, {
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe("unsent"),
      threadId: fixture.a,
      message: {
        messageId: MessageId.makeUnsafe("unsent"),
        role: "user",
        text: "hello",
        attachments: [],
      },
      interactionMode: "default",
      runtimeMode: "full-access",
      createdAt: "2026-10-19T11:00:00.000Z",
    }),
  ).toThrow("archived");
  expect(model.threads[0]!.messages).toEqual([]);
});

it("continues legacy reconciliation after a failed workflow and retries it on the next sweep", async () => {
  const a = workflowArchiveFixture("planning");
  const b = workflowArchiveFixture("codeReview");
  const model = {
    ...a.model,
    planningWorkflows: [
      { ...a.model.planningWorkflows[0]!, archivedAt: "2026-10-19T10:00:00.000Z" },
    ],
    codeReviewWorkflows: [
      { ...b.model.codeReviewWorkflows[0]!, archivedAt: "2026-10-19T10:00:00.000Z" },
    ],
  };
  const attempts: string[] = [];
  const engine = {
    getReadModel: () => Effect.succeed(model),
    dispatch: (command: { workflowKind: string }) => {
      attempts.push(command.workflowKind);
      return command.workflowKind === "planning"
        ? Effect.fail(new Error("ownership conflict"))
        : Effect.succeed({ sequence: 1 });
    },
  };
  await Effect.runPromise(reconcileWorkflowArchives(engine as never));
  await Effect.runPromise(reconcileWorkflowArchives(engine as never));
  expect(attempts).toEqual(["planning", "codeReview", "planning", "codeReview"]);
});

it("preserves the stage timestamp and prevents newly attaching deleted threads", () => {
  const fixture = workflowArchiveFixture("codeReview");
  const original = fixture.model.codeReviewWorkflows[0]!;
  const command = {
    type: "project.code-review-workflow.upsert" as const,
    commandId: CommandId.makeUnsafe("stage"),
    projectId: original.projectId,
    updatedAt: "2026-10-19T11:00:00.000Z",
    workflow: original,
  };
  const result = applyArchiveTestCommand(fixture.model, command);
  expect(result.model.codeReviewWorkflows[0]!.updatedAt).toBe(original.updatedAt);
  const deletedId = ThreadId.makeUnsafe("deleted-unowned");
  const model = {
    ...fixture.model,
    threads: [
      ...fixture.model.threads,
      {
        ...fixture.model.threads[0]!,
        id: deletedId,
        deletedAt: "2026-10-19T10:00:00.000Z",
      },
    ],
  };
  expect(() =>
    applyArchiveTestCommand(model, {
      ...command,
      workflow: { ...original, consolidation: { ...original.consolidation, threadId: deletedId } },
    }),
  ).toThrow("Cannot attach a deleted thread");
});

it("preserves archive ownership across stale stage upserts and archives new children", () => {
  const fixture = workflowArchiveFixture("codeReview");
  let model = applyArchiveTestCommand(fixture.model, fixture.archive()).model;
  const newId = ThreadId.makeUnsafe("consolidation");
  model = {
    ...model,
    threads: [...model.threads, { ...model.threads[0]!, id: newId, archivedAt: null }],
  };
  const original = fixture.model.codeReviewWorkflows[0]!;
  model = applyArchiveTestCommand(model, {
    type: "project.code-review-workflow.upsert",
    commandId: CommandId.makeUnsafe("stale"),
    projectId: original.projectId,
    updatedAt: "2026-10-19T11:00:00.000Z",
    workflow: { ...original, consolidation: { ...original.consolidation, threadId: newId } },
  }).model;
  expect(model.codeReviewWorkflows[0]!.archivedAt).not.toBeNull();
  expect(model.codeReviewWorkflows[0]!.archiveRestorations).toHaveLength(3);
  expect(model.threads.find((thread) => thread.id === newId)?.archivedAt).not.toBeNull();
  const stale = model.codeReviewWorkflows[0]!;
  model = applyArchiveTestCommand(model, fixture.archive(true)).model;
  model = applyArchiveTestCommand(model, {
    type: "project.code-review-workflow.upsert",
    commandId: CommandId.makeUnsafe("stale-after-restore"),
    projectId: stale.projectId,
    workflow: stale,
    updatedAt: "2026-10-19T12:00:00.000Z",
  }).model;
  expect(model.codeReviewWorkflows[0]!.archivedAt).toBeNull();
  expect(model.codeReviewWorkflows[0]!.archiveRestorations).toEqual([]);
});

it("omits restoration metadata from all lightweight summaries", () => {
  for (const kind of ["planning", "codeReview", "investigation"] as const) {
    const fixture = workflowArchiveFixture(kind);
    const entry = workflowEntries(
      applyArchiveTestCommand(fixture.model, fixture.archive()).model,
    )[0]!;
    const summary =
      entry.kind === "planning"
        ? summarizePlanningWorkflow(entry.workflow)
        : entry.kind === "codeReview"
          ? summarizeCodeReviewWorkflow(entry.workflow)
          : summarizeInvestigationWorkflow(entry.workflow);
    expect(summary).not.toHaveProperty("archiveRestorations");
  }
});

it("archives implementation, review and reader history exactly once, skipping absent children", () => {
  const fixture = workflowArchiveFixture("planning");
  const ids = ["implementation", "implementation-review", "reader", "previous-reader"].map(
    ThreadId.makeUnsafe,
  );
  const original = fixture.model.planningWorkflows[0]!;
  const workflow = Schema.decodeUnknownSync(PlanningWorkflow)({
    ...original,
    readerPass: {
      status: "completed",
      draftTurnId: "draft",
      draftPlanId: "plan",
      readerThreadId: ids[2],
      previousReaderThreadIds: [ids[3], fixture.a, ThreadId.makeUnsafe("missing")],
      updatedAt: original.updatedAt,
    },
    implementation: {
      implementationSlot: original.branchA.authorSlot,
      threadId: ids[0],
      implementationTurnId: null,
      revisionTurnId: null,
      status: "completed",
      error: null,
      updatedAt: original.updatedAt,
      codeReviews: [
        {
          reviewerLabel: "Reviewer",
          reviewerSlot: original.branchA.authorSlot,
          threadId: ids[1],
          status: "completed",
          error: null,
          updatedAt: original.updatedAt,
        },
      ],
    },
  });
  const model = {
    ...fixture.model,
    planningWorkflows: [workflow],
    threads: [...fixture.model.threads, ...ids.map((id) => ({ ...fixture.model.threads[0]!, id }))],
  };
  const result = applyArchiveTestCommand(model, fixture.archive());
  expect(result.events.filter((event) => event.type === "thread.archived")).toHaveLength(6);
  expect(result.model.planningWorkflows[0]!.archiveRestorations).toHaveLength(6);
  expect(result.model.threads.every((thread) => thread.archivedAt !== null)).toBe(true);
});

it("uses the normal thread archive lifecycle for pins and snoozes", () => {
  const fixture = workflowArchiveFixture("planning");
  const model = {
    ...fixture.model,
    threads: fixture.model.threads.map((thread, index) => ({
      ...thread,
      pinnedAt: "2026-10-18T00:00:00.000Z",
      pinOrderKey: index,
      snoozedAt: "2026-10-18T00:00:00.000Z",
      snoozedUntil: "2026-10-20T00:00:00.000Z",
    })),
  };
  const result = applyArchiveTestCommand(model, fixture.archive());
  expect(result.model.pinRevision).toBe(2);
  expect(
    result.model.threads.every(
      (thread) =>
        thread.pinnedAt === null && thread.snoozedUntil === null && thread.snoozedAt === null,
    ),
  ).toBe(true);
});
