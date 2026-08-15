import {
  CheckpointRef,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProjectionCheckpointRepository,
  type ProjectionCheckpoint,
  type ProjectionCheckpointRepositoryShape,
} from "../../persistence/Services/ProjectionCheckpoints.ts";
import {
  ProjectionProjectRepository,
  type ProjectionProject,
  type ProjectionProjectRepositoryShape,
} from "../../persistence/Services/ProjectionProjects.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThread,
  type ProjectionThreadRepositoryShape,
} from "../../persistence/Services/ProjectionThreads.ts";
import { checkpointRefForThreadTurn } from "../Utils.ts";
import { CheckpointDiffQueryLive } from "./CheckpointDiffQuery.ts";
import { CheckpointStore, type CheckpointStoreShape } from "../Services/CheckpointStore.ts";
import { CheckpointDiffQuery } from "../Services/CheckpointDiffQuery.ts";

const notImplemented = () => Effect.die("not implemented in CheckpointDiffQuery test");

function makeThreadRow(input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
}): ProjectionThread {
  return {
    threadId: input.threadId,
    projectId: input.projectId,
    title: "Thread",
    model: "gpt-5-codex",
    modelSelection: null,
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: input.worktreePath,
    latestTurnId: null,
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    compaction: null,
    estimatedContextTokens: null,
    modelContextWindowTokens: null,
    sessionNotes: null,
    threadReferences: [],
    archivedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    snoozedUntil: null,
    snoozedAt: null,
    titleSource: "legacy",
    titleRevision: 0,
    titleUpdatedAt: null,
    titleRegenerationRequestId: null,
    titleRegenerationStartedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastInteractionAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };
}

function makeProjectRow(input: {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
}): ProjectionProject {
  return {
    projectId: input.projectId,
    title: "Project",
    workspaceRoot: input.workspaceRoot,
    defaultModel: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };
}

function makeCheckpointRow(input: {
  readonly threadId: ThreadId;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
}): ProjectionCheckpoint {
  return {
    threadId: input.threadId,
    turnId: TurnId.makeUnsafe(`turn-${input.checkpointTurnCount}`),
    checkpointTurnCount: input.checkpointTurnCount,
    checkpointRef: input.checkpointRef,
    status: "ready",
    files: [],
    assistantMessageId: null,
    completedAt: "2026-01-01T00:00:00.000Z",
  };
}

function buildLayer(input: {
  readonly thread: Option.Option<ProjectionThread>;
  readonly project: Option.Option<ProjectionProject>;
  readonly checkpoints: ReadonlyArray<ProjectionCheckpoint>;
  readonly checkpointStore: CheckpointStoreShape;
}) {
  const threadRepository: ProjectionThreadRepositoryShape = {
    getById: () => Effect.succeed(input.thread),
    upsert: notImplemented,
    listByProjectId: notImplemented,
    deleteById: notImplemented,
  };
  const projectRepository: ProjectionProjectRepositoryShape = {
    getById: () => Effect.succeed(input.project),
    upsert: notImplemented,
    listAll: notImplemented,
    deleteById: notImplemented,
  };
  const checkpointRepository: ProjectionCheckpointRepositoryShape = {
    listByThreadId: () => Effect.succeed(input.checkpoints),
    getByThreadAndTurnCount: ({ checkpointTurnCount }) => {
      const match = input.checkpoints.find(
        (checkpoint) => checkpoint.checkpointTurnCount === checkpointTurnCount,
      );
      return Effect.succeed(match ? Option.some(match) : Option.none());
    },
    upsert: notImplemented,
    deleteByThreadId: notImplemented,
  };

  return CheckpointDiffQueryLive.pipe(
    Layer.provideMerge(Layer.succeed(CheckpointStore, input.checkpointStore)),
    Layer.provideMerge(Layer.succeed(ProjectionThreadRepository, threadRepository)),
    Layer.provideMerge(Layer.succeed(ProjectionProjectRepository, projectRepository)),
    Layer.provideMerge(Layer.succeed(ProjectionCheckpointRepository, checkpointRepository)),
  );
}

describe("CheckpointDiffQueryLive", () => {
  it("computes diffs using canonical turn-0 checkpoint refs", async () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
    const hasCheckpointRefCalls: Array<CheckpointRef> = [];
    const diffCheckpointsCalls: Array<{
      readonly fromCheckpointRef: CheckpointRef;
      readonly toCheckpointRef: CheckpointRef;
      readonly cwd: string;
      readonly ignoreWhitespace?: boolean;
    }> = [];

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      hasCheckpointRef: ({ checkpointRef }) =>
        Effect.sync(() => {
          hasCheckpointRefCalls.push(checkpointRef);
          return true;
        }),
      restoreCheckpoint: () => Effect.succeed(true),
      diffCheckpoints: ({ fromCheckpointRef, toCheckpointRef, cwd, options }) =>
        Effect.sync(() => {
          diffCheckpointsCalls.push({
            fromCheckpointRef,
            toCheckpointRef,
            cwd,
            ...(options?.ignoreWhitespace !== undefined
              ? { ignoreWhitespace: options.ignoreWhitespace }
              : {}),
          });
          return "diff patch";
        }),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = buildLayer({
      thread: Option.some(makeThreadRow({ threadId, projectId, worktreePath: null })),
      project: Option.some(makeProjectRow({ projectId, workspaceRoot: "/tmp/workspace" })),
      checkpoints: [
        makeCheckpointRow({ threadId, checkpointTurnCount: 1, checkpointRef: toCheckpointRef }),
      ],
      checkpointStore,
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
        });
      }).pipe(Effect.provide(layer)),
    );

    const expectedFromRef = checkpointRefForThreadTurn(threadId, 0);
    expect(hasCheckpointRefCalls).toEqual([expectedFromRef, toCheckpointRef]);
    expect(diffCheckpointsCalls).toEqual([
      {
        cwd: "/tmp/workspace",
        fromCheckpointRef: expectedFromRef,
        toCheckpointRef,
        ignoreWhitespace: undefined,
      },
    ]);
    expect(result).toEqual({
      threadId,
      fromTurnCount: 0,
      toTurnCount: 1,
      diff: "diff patch",
    });
  });

  it("forwards whitespace diff options to checkpoint storage", async () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
    const diffCheckpointsCalls: Array<{ readonly ignoreWhitespace?: boolean }> = [];

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      diffCheckpoints: ({ options }) =>
        Effect.sync(() => {
          diffCheckpointsCalls.push(
            options?.ignoreWhitespace !== undefined
              ? { ignoreWhitespace: options.ignoreWhitespace }
              : {},
          );
          return "diff patch";
        }),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = buildLayer({
      thread: Option.some(makeThreadRow({ threadId, projectId, worktreePath: null })),
      project: Option.some(makeProjectRow({ projectId, workspaceRoot: "/tmp/workspace" })),
      checkpoints: [
        makeCheckpointRow({ threadId, checkpointTurnCount: 1, checkpointRef: toCheckpointRef }),
      ],
      checkpointStore,
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        yield* query.getFullThreadDiff({
          threadId,
          toTurnCount: 1,
          options: { ignoreWhitespace: true },
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(diffCheckpointsCalls).toEqual([{ ignoreWhitespace: true }]);
  });

  it("resolves diffs for turns older than the read-model retention window", async () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const threadId = ThreadId.makeUnsafe("thread-1");
    // An old turn (3) plus a much newer turn (750): the read model would have
    // evicted turn 3 from its retained window, but the checkpoint projection
    // table still holds it, so the diff must still resolve.
    const oldCheckpointRef = checkpointRefForThreadTurn(threadId, 3);
    const diffCheckpointsCalls: Array<{
      readonly fromCheckpointRef: CheckpointRef;
      readonly toCheckpointRef: CheckpointRef;
    }> = [];

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      diffCheckpoints: ({ fromCheckpointRef, toCheckpointRef }) =>
        Effect.sync(() => {
          diffCheckpointsCalls.push({ fromCheckpointRef, toCheckpointRef });
          return "old diff patch";
        }),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = buildLayer({
      thread: Option.some(makeThreadRow({ threadId, projectId, worktreePath: null })),
      project: Option.some(makeProjectRow({ projectId, workspaceRoot: "/tmp/workspace" })),
      checkpoints: [
        makeCheckpointRow({ threadId, checkpointTurnCount: 3, checkpointRef: oldCheckpointRef }),
        makeCheckpointRow({
          threadId,
          checkpointTurnCount: 750,
          checkpointRef: checkpointRefForThreadTurn(threadId, 750),
        }),
      ],
      checkpointStore,
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 3,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(diffCheckpointsCalls).toEqual([
      {
        fromCheckpointRef: checkpointRefForThreadTurn(threadId, 0),
        toCheckpointRef: oldCheckpointRef,
      },
    ]);
    expect(result.diff).toBe("old diff patch");
  });

  it("fails when the thread is missing", async () => {
    const threadId = ThreadId.makeUnsafe("thread-missing");

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      diffCheckpoints: () => Effect.succeed(""),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = buildLayer({
      thread: Option.none(),
      project: Option.none(),
      checkpoints: [],
      checkpointStore,
    });

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const query = yield* CheckpointDiffQuery;
          return yield* query.getTurnDiff({
            threadId,
            fromTurnCount: 0,
            toTurnCount: 1,
          });
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow("Thread 'thread-missing' not found.");
  });
});
