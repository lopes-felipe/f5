import {
  CommandId,
  MessageId,
  PlanningWorkflowId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import { markDocumentMergeDrafted } from "./documentReaderPass.ts";
const now = "2026-04-01T00:00:00.000Z";
const projectId = ProjectId.makeUnsafe("project");
const slot = { provider: "codex" as const, model: "gpt-5-codex" };
const create = {
  type: "project.workflow.create" as const,
  commandId: CommandId.makeUnsafe("create"),
  workflowId: PlanningWorkflowId.makeUnsafe("workflow"),
  projectId,
  title: "Doc",
  slug: "doc",
  templateId: "builtin.document.dual",
  templateVersion: 2,
  requirementPrompt: "Brief",
  plansDirectory: "plans",
  selfReviewEnabled: true,
  documentType: "rfc" as const,
  readerReviewEnabled: true,
  readerSlot: slot,
  authorThreadIdA: ThreadId.makeUnsafe("a"),
  authorThreadIdB: ThreadId.makeUnsafe("b"),
  branchA: slot,
  branchB: { provider: "claudeAgent" as const, model: "claude-sonnet-4-5" },
  merge: slot,
  createdAt: now,
};
async function setup() {
  let readModel = createEmptyReadModel(now);
  const apply = async (command: OrchestrationCommand) => {
    const result = await Effect.runPromise(decideOrchestrationCommand({ readModel, command }));
    for (const event of Array.isArray(result) ? result : [result])
      readModel = await Effect.runPromise(
        projectEvent(readModel, { ...event, sequence: readModel.snapshotSequence + 1 }),
      );
    return result;
  };
  await apply({
    type: "project.create",
    commandId: CommandId.makeUnsafe("project"),
    projectId,
    title: "Project",
    workspaceRoot: "/tmp/project",
    createdAt: now,
  });
  return {
    apply,
    get: () => readModel,
    set: (next: typeof readModel) => {
      readModel = next;
    },
  };
}
describe("document workflow decider", () => {
  it("rejects invalid template/type pairs and oversized briefs", async () => {
    for (const patch of [
      { documentType: undefined },
      { templateId: "builtin.planning.dual" },
      { requirementPrompt: "x".repeat(24_001) },
      { templateId: "builtin.planning.dual", documentType: undefined, readerReviewEnabled: false },
    ]) {
      const h = await setup();
      await expect(h.apply({ ...create, ...patch })).rejects.toThrow();
      expect(h.get().threads).toHaveLength(0);
    }
  });
  it("persists document fields and enforces read-only follow-ups in every document thread", async () => {
    const h = await setup();
    await h.apply(create);
    let workflow = h.get().planningWorkflows[0]!;
    expect(workflow).toMatchObject({
      documentType: "rfc",
      readerReviewEnabled: true,
      readerSlot: slot,
      readerPass: null,
    });
    workflow = markDocumentMergeDrafted(
      {
        ...workflow,
        merge: { ...workflow.merge, threadId: ThreadId.makeUnsafe("merge") },
        branchA: {
          ...workflow.branchA,
          reviews: [
            {
              slot: "cross",
              threadId: ThreadId.makeUnsafe("review"),
              status: "completed",
              outputFilePath: null,
              error: null,
              retryCount: 0,
              lastRetryAt: null,
              updatedAt: now,
            },
          ],
        },
      },
      {
        turnId: "draft",
        draftPlanId: "plan",
        readerThreadId: ThreadId.makeUnsafe("reader"),
        updatedAt: now,
      },
    );
    workflow = {
      ...workflow,
      readerPass: {
        ...workflow.readerPass!,
        previousReaderThreadIds: [ThreadId.makeUnsafe("previous-reader")],
      },
    };
    h.set({ ...h.get(), planningWorkflows: [workflow] });
    for (const id of ["a", "b", "merge", "review", "reader", "previous-reader"]) {
      const threadId = ThreadId.makeUnsafe(id);
      await h.apply({
        type: "thread.create",
        commandId: CommandId.makeUnsafe(`create-${id}`),
        threadId,
        projectId,
        title: id,
        model: slot.model,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });
      for (const profile of [undefined, "unattended-readonly"] as const) {
        const result = await Effect.runPromise(
          decideOrchestrationCommand({
            readModel: h.get(),
            command: {
              type: "thread.turn.start",
              commandId: CommandId.makeUnsafe(`start-${id}`),
              threadId,
              message: {
                messageId: MessageId.makeUnsafe(`msg-${id}`),
                role: "user",
                text: "Refine",
                attachments: [],
              },
              provider: "codex",
              model: slot.model,
              runtimeMode: "full-access",
              interactionMode: "default",
              ...(profile ? { workflowExecutionProfile: profile } : {}),
              createdAt: now,
            },
          }),
        );
        expect(
          (Array.isArray(result) ? result : [result]).find(
            (event) => event.type === "thread.turn-start-requested",
          )?.payload,
        ).toMatchObject({ workflowExecutionProfile: profile ?? "attended-readonly" });
      }
      for (const [instanceName, driver, reject] of [
        ["custom-research", "grok", true],
        ["grok-named-codex", "codex", false],
      ] as const) {
        const instanceId = ProviderInstanceId.makeUnsafe(instanceName);
        const decision = Effect.runPromise(
          decideOrchestrationCommand({
            readModel: h.get(),
            providerInstances: [{ instanceId, driver: ProviderDriverKind.make(driver) }],
            command: {
              type: "thread.turn.start",
              commandId: CommandId.makeUnsafe(`instance-${id}-${driver}`),
              threadId,
              message: {
                messageId: MessageId.makeUnsafe(`instance-message-${id}-${driver}`),
                role: "user",
                text: "Refine",
                attachments: [],
              },
              modelSelection: { instanceId, model: slot.model },
              runtimeMode: "full-access",
              interactionMode: "default",
              createdAt: now,
            },
          }),
        );
        if (reject) await expect(decision).rejects.toThrow("read-only");
        else await expect(decision).resolves.toBeDefined();
      }
      await expect(
        h.apply({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`grok-${id}`),
          threadId,
          message: {
            messageId: MessageId.makeUnsafe(`grok-msg-${id}`),
            role: "user",
            text: "Refine",
            attachments: [],
          },
          provider: "grok",
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        }),
      ).rejects.toThrow("read-only");
    }
  });
});
