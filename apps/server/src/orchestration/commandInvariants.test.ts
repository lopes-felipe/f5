import { describe, expect, it } from "vitest";
import {
  MessageId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";

import {
  findThreadById,
  listThreadsByProjectId,
  requireNonNegativeInteger,
  requireThreadArchived,
  requireThreadNotArchived,
  requireThread,
  requireThreadAbsent,
} from "./commandInvariants.ts";

const now = new Date().toISOString();

const readModel: OrchestrationReadModel = {
  snapshotSequence: 2,
  updatedAt: now,
  projects: [
    {
      id: ProjectId.makeUnsafe("project-a"),
      title: "Project A",
      workspaceRoot: "/tmp/project-a",
      defaultModel: "gpt-5-codex",
      scripts: [],
      memories: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: ProjectId.makeUnsafe("project-b"),
      title: "Project B",
      workspaceRoot: "/tmp/project-b",
      defaultModel: "gpt-5-codex",
      scripts: [],
      memories: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ],
  planningWorkflows: [],
  codeReviewWorkflows: [],
  threads: [
    {
      id: ThreadId.makeUnsafe("thread-1"),
      projectId: ProjectId.makeUnsafe("project-a"),
      title: "Thread A",
      model: "gpt-5-codex",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      archivedAt: null,
      lastInteractionAt: now,
      updatedAt: now,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      tasks: [],
      tasksTurnId: null,
      tasksUpdatedAt: null,
      checkpoints: [],
      compaction: null,
      deletedAt: null,
    },
    {
      id: ThreadId.makeUnsafe("thread-2"),
      projectId: ProjectId.makeUnsafe("project-b"),
      title: "Thread B",
      model: "gpt-5-codex",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      archivedAt: "2026-03-01T00:10:00.000Z",
      lastInteractionAt: now,
      updatedAt: now,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      tasks: [],
      tasksTurnId: null,
      tasksUpdatedAt: null,
      checkpoints: [],
      compaction: null,
      deletedAt: null,
    },
  ],
};

const messageSendCommand: OrchestrationCommand = {
  type: "thread.turn.start",
  commandId: CommandId.makeUnsafe("cmd-1"),
  threadId: ThreadId.makeUnsafe("thread-1"),
  message: {
    messageId: MessageId.makeUnsafe("msg-1"),
    role: "user",
    text: "hello",
    attachments: [],
  },
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "approval-required",
  createdAt: now,
};

describe("commandInvariants", () => {
  it("finds threads by id and project", () => {
    expect(findThreadById(readModel, ThreadId.makeUnsafe("thread-1"))?.projectId).toBe("project-a");
    expect(findThreadById(readModel, ThreadId.makeUnsafe("missing"))).toBeUndefined();
    expect(
      listThreadsByProjectId(readModel, ProjectId.makeUnsafe("project-b")).map(
        (thread) => thread.id,
      ),
    ).toEqual([ThreadId.makeUnsafe("thread-2")]);
  });

  it("requires existing thread", async () => {
    const thread = await Effect.runPromise(
      requireThread({
        readModel,
        command: messageSendCommand,
        threadId: ThreadId.makeUnsafe("thread-1"),
      }),
    );
    expect(thread.id).toBe(ThreadId.makeUnsafe("thread-1"));

    await expect(
      Effect.runPromise(
        requireThread({
          readModel,
          command: messageSendCommand,
          threadId: ThreadId.makeUnsafe("missing"),
        }),
      ),
    ).rejects.toThrow("does not exist");
  });

  it("requires missing thread for create flows", async () => {
    await Effect.runPromise(
      requireThreadAbsent({
        readModel,
        command: {
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-2"),
          threadId: ThreadId.makeUnsafe("thread-3"),
          projectId: ProjectId.makeUnsafe("project-a"),
          title: "new",
          model: "gpt-5-codex",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        threadId: ThreadId.makeUnsafe("thread-3"),
      }),
    );

    await expect(
      Effect.runPromise(
        requireThreadAbsent({
          readModel,
          command: {
            type: "thread.create",
            commandId: CommandId.makeUnsafe("cmd-3"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            projectId: ProjectId.makeUnsafe("project-a"),
            title: "dup",
            model: "gpt-5-codex",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
          threadId: ThreadId.makeUnsafe("thread-1"),
        }),
      ),
    ).rejects.toThrow("already exists");
  });

  it("requires threads to be unarchived before archiving", async () => {
    const thread = await Effect.runPromise(
      requireThreadNotArchived({
        readModel,
        command: {
          type: "thread.archive",
          commandId: CommandId.makeUnsafe("cmd-archive"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          createdAt: now,
        },
        threadId: ThreadId.makeUnsafe("thread-1"),
      }),
    );
    expect(thread.id).toBe(ThreadId.makeUnsafe("thread-1"));

    await expect(
      Effect.runPromise(
        requireThreadNotArchived({
          readModel,
          command: {
            type: "thread.archive",
            commandId: CommandId.makeUnsafe("cmd-archive-dup"),
            threadId: ThreadId.makeUnsafe("thread-2"),
            createdAt: now,
          },
          threadId: ThreadId.makeUnsafe("thread-2"),
        }),
      ),
    ).rejects.toThrow("already archived");
  });

  it("requires threads to be archived before unarchiving", async () => {
    const thread = await Effect.runPromise(
      requireThreadArchived({
        readModel,
        command: {
          type: "thread.unarchive",
          commandId: CommandId.makeUnsafe("cmd-unarchive"),
          threadId: ThreadId.makeUnsafe("thread-2"),
          createdAt: now,
        },
        threadId: ThreadId.makeUnsafe("thread-2"),
      }),
    );
    expect(thread.id).toBe(ThreadId.makeUnsafe("thread-2"));

    await expect(
      Effect.runPromise(
        requireThreadArchived({
          readModel,
          command: {
            type: "thread.unarchive",
            commandId: CommandId.makeUnsafe("cmd-unarchive-missing"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            createdAt: now,
          },
          threadId: ThreadId.makeUnsafe("thread-1"),
        }),
      ),
    ).rejects.toThrow("is not archived");
  });

  it("requires non-negative integers", async () => {
    await Effect.runPromise(
      requireNonNegativeInteger({
        commandType: "thread.checkpoint.revert",
        field: "turnCount",
        value: 0,
      }),
    );

    await expect(
      Effect.runPromise(
        requireNonNegativeInteger({
          commandType: "thread.checkpoint.revert",
          field: "turnCount",
          value: -1,
        }),
      ),
    ).rejects.toThrow("greater than or equal to 0");
  });
});
