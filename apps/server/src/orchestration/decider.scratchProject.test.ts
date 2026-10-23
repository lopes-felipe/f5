import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-10-22T12:00:00.000Z";
const SCRATCH_ID = ProjectId.makeUnsafe("scratch-project");
const ROOT = "/state/scratch";
const THREAD_ID = ThreadId.makeUnsafe("0f9e8d7c-aaaa-bbbb-cccc-1234567890ab");

let sequence = 0;
async function apply(
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
): Promise<OrchestrationReadModel> {
  const result = await Effect.runPromise(decideOrchestrationCommand({ command, readModel }));
  let next = readModel;
  for (const event of Array.isArray(result) ? result : [result]) {
    sequence += 1;
    next = await Effect.runPromise(
      projectEvent(next, {
        ...event,
        sequence,
        eventId: EventId.makeUnsafe(`event-${sequence}`),
      } as OrchestrationEvent),
    );
  }
  return next;
}

const decide = (readModel: OrchestrationReadModel, command: OrchestrationCommand) =>
  Effect.runPromise(decideOrchestrationCommand({ command, readModel }));

const scratchCreate = (projectId = SCRATCH_ID): OrchestrationCommand => ({
  type: "project.scratch.create",
  commandId: CommandId.makeUnsafe(`scratch-${projectId}`),
  projectId,
  workspaceRoot: ROOT,
  createdAt: NOW,
});

const threadCreate = (
  projectId: ProjectId,
  overrides: Partial<Extract<OrchestrationCommand, { type: "thread.create" }>> = {},
): OrchestrationCommand => ({
  type: "thread.create",
  commandId: CommandId.makeUnsafe(`thread-create-${projectId}`),
  threadId: THREAD_ID,
  projectId,
  title: "New thread",
  model: "gpt-5.5",
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: NOW,
  ...overrides,
});

async function withScratchProject() {
  return apply(createEmptyReadModel(NOW), scratchCreate());
}

describe("decider scratch project", () => {
  it("creates one server-owned scratch project titled No project", async () => {
    const model = await withScratchProject();
    expect(model.projects).toMatchObject([
      { id: SCRATCH_ID, kind: "scratch", title: "No project", workspaceRoot: ROOT },
    ]);
    await expect(decide(model, scratchCreate())).rejects.toThrow("already exists");
    await expect(decide(model, scratchCreate(ProjectId.makeUnsafe("other")))).rejects.toThrow(
      "already has a home",
    );
  });

  it("refuses deleting it or changing its folder, actions, memories or skills", async () => {
    const model = await withScratchProject();
    const commandId = CommandId.makeUnsafe("mutate");
    await expect(
      decide(model, { type: "project.delete", commandId, projectId: SCRATCH_ID }),
    ).rejects.toThrow("cannot change it");
    await expect(
      decide(model, {
        type: "project.meta.update",
        commandId,
        projectId: SCRATCH_ID,
        workspaceRoot: "/elsewhere",
      }),
    ).rejects.toThrow("its folder or actions");
    await expect(
      decide(model, {
        type: "project.meta.update",
        commandId,
        projectId: SCRATCH_ID,
        scripts: [],
      }),
    ).rejects.toThrow("its folder or actions");
    await expect(
      decide(model, {
        type: "project.memory.save",
        commandId,
        projectId: SCRATCH_ID,
        memoryId: "memory-1",
        title: "Note",
        body: "Remember this",
        createdAt: NOW,
      } as unknown as OrchestrationCommand),
    ).rejects.toThrow("memories");
    await expect(
      decide(model, {
        type: "project.skills.replace",
        commandId,
        projectId: SCRATCH_ID,
        skills: [],
        createdAt: NOW,
      } as unknown as OrchestrationCommand),
    ).rejects.toThrow("skills");
  });

  it("creates a scratch thread only with its own folder and no branch or worktree", async () => {
    const model = await withScratchProject();
    await expect(decide(model, threadCreate(SCRATCH_ID))).rejects.toThrow("its own folder");
    await expect(
      decide(model, threadCreate(SCRATCH_ID, { scratchPath: "/state/scratch/../escape" })),
    ).rejects.toThrow("its own folder");
    await expect(
      decide(model, threadCreate(SCRATCH_ID, { scratchPath: "/elsewhere/2026-10-22-x-0f9e8d7c" })),
    ).rejects.toThrow("its own folder");
    await expect(
      decide(
        model,
        threadCreate(SCRATCH_ID, {
          scratchPath: `${ROOT}/2026-10-22-hello-0f9e8d7c`,
          worktreePath: "/repo/.worktrees/x",
        }),
      ),
    ).rejects.toThrow("no branch or worktree");

    const created = await apply(
      model,
      threadCreate(SCRATCH_ID, { scratchPath: `${ROOT}/2026-10-22-hello-0f9e8d7c` }),
    );
    expect(created.threads[0]).toMatchObject({
      id: THREAD_ID,
      scratchPath: `${ROOT}/2026-10-22-hello-0f9e8d7c`,
      worktreePath: null,
    });
  });

  it("keeps scratch folders off threads of ordinary projects", async () => {
    const standard = ProjectId.makeUnsafe("standard");
    const model = await apply(createEmptyReadModel(NOW), {
      type: "project.create",
      commandId: CommandId.makeUnsafe("create-standard"),
      projectId: standard,
      title: "Repo",
      workspaceRoot: "/repo",
      createdAt: NOW,
    });
    expect(model.projects[0]?.kind).toBe("standard");
    await expect(
      decide(model, threadCreate(standard, { scratchPath: `${ROOT}/2026-10-22-x-0f9e8d7c` })),
    ).rejects.toThrow("Only threads without a project");
    const created = await apply(model, threadCreate(standard));
    expect(created.threads[0]?.scratchPath).toBeNull();
  });
});
