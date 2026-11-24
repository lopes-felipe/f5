import {
  CommandId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { decideOrchestrationCommand } from "./decider";
import { createEmptyReadModel } from "./projector";

it("preserves model instance identity only for internal history import", async () => {
  const now = "2026-11-19T00:00:00Z";
  const projectId = ProjectId.make("project");
  const readModel = {
    ...createEmptyReadModel(now),
    projects: [
      {
        id: projectId,
        kind: "standard" as const,
        title: "Project",
        workspaceRoot: "/project",
        defaultModel: null,
        defaultModelSelection: null,
        defaultEnvMode: null,
        icon: null,
        scripts: [],
        memories: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
  };
  const create: Extract<OrchestrationCommand, { type: "thread.create" }> = {
    type: "thread.create",
    commandId: CommandId.make("create"),
    threadId: ThreadId.make("thread"),
    projectId,
    title: "Thread",
    model: "gpt-6.1-sol",
    modelSelection: { instanceId: ProviderInstanceId.make("codex-personal"), model: "gpt-6.1-sol" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: now,
  };
  const normal = await Effect.runPromise(
    decideOrchestrationCommand({ command: create, readModel }),
  );
  const normalEvents = Array.isArray(normal) ? normal : [normal];
  expect(
    normalEvents.find((event) => event.type === "thread.created")?.payload.modelSelection,
  ).toBeUndefined();
  const imported = await Effect.runPromise(
    decideOrchestrationCommand({
      command: {
        ...create,
        type: "thread.import",
        expectedWorkspaceRoot: "/project",
        messages: [],
      },
      readModel,
    }),
  );
  const importEvents = Array.isArray(imported) ? imported : [imported];
  expect(
    importEvents.find((event) => event.type === "thread.created")?.payload.modelSelection,
  ).toEqual(create.modelSelection);
});
