import {
  CommandId,
  MessageId,
  type OrchestrationThread,
  type OrchestrationReadModel,
  ProjectId,
  ThreadId,
  type GitCreateWorktreeResult,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect, Layer, Metric, Tracer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitCommandError } from "../git/Errors.ts";
import { makeLocalFileTracer } from "../observability/LocalFileTracer.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectSetupScriptRunnerShape } from "../project/Services/ProjectSetupScriptRunner.ts";
import { dispatchBootstrapTurnStart } from "./bootstrapTurnStart.ts";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const THREAD_ID = ThreadId.makeUnsafe("thread-1");

afterEach(() => {
  vi.restoreAllMocks();
});

function counterValue(
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
): number {
  const snapshot = snapshots.find(
    (entry) =>
      entry.id === id &&
      entry.type === "Counter" &&
      Object.entries(attributes).every(([key, value]) => entry.attributes?.[key] === value),
  );
  return snapshot?.type === "Counter" ? Number(snapshot.state.count) : 0;
}

function makeTurnStartCommand(
  overrides: Partial<Extract<OrchestrationCommand, { type: "thread.turn.start" }>> = {},
): Extract<OrchestrationCommand, { type: "thread.turn.start" }> {
  return {
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe("cmd-turn-start"),
    threadId: THREAD_ID,
    message: {
      messageId: MessageId.makeUnsafe("msg-1"),
      role: "user",
      text: "hello",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeReadModel(input?: {
  branch?: string | null;
  worktreePath?: string | null;
  includeThread?: boolean;
}): OrchestrationReadModel {
  const thread: OrchestrationThread = {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Existing thread",
    model: "gpt-5-codex",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: input?.branch ?? "existing-branch",
    // Default: no worktree. Tests that need a pre-existing worktree (e.g.,
    // to exercise rollback paths that restore prior metadata, or to verify
    // the idempotency guard) must set `worktreePath` explicitly.
    worktreePath: input?.worktreePath === undefined ? null : input.worktreePath,
    latestTurn: null,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastInteractionAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    estimatedContextTokens: null,
    modelContextWindowTokens: null,
    messages: [],
    proposedPlans: [],
    tasks: [],
    tasksTurnId: null,
    tasksUpdatedAt: null,
    compaction: null,
    activities: [],
    checkpoints: [],
    session: null,
  };
  return {
    snapshotSequence: 1,
    projects: [],
    threads: input?.includeThread === false ? [] : [thread],
    planningWorkflows: [],
    codeReviewWorkflows: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeDependencies(input?: {
  dispatch?: OrchestrationEngineShape["dispatch"];
  getReadModel?: OrchestrationEngineShape["getReadModel"];
  createWorktree?: GitCoreShape["createWorktree"];
  removeWorktree?: GitCoreShape["removeWorktree"];
  runForThread?: ProjectSetupScriptRunnerShape["runForThread"];
}) {
  const orchestrationEngine: Pick<OrchestrationEngineShape, "dispatch" | "getReadModel"> = {
    dispatch:
      input?.dispatch ??
      ((command) =>
        Effect.succeed({
          sequence: command.type === "thread.turn.start" ? 2 : 1,
        })),
    getReadModel: input?.getReadModel ?? (() => Effect.succeed(makeReadModel())),
  };
  const git: Pick<GitCoreShape, "createWorktree" | "removeWorktree"> = {
    createWorktree:
      input?.createWorktree ??
      (() =>
        Effect.succeed({
          worktree: {
            branch: "t3code/bootstrap-branch",
            path: "/repo/project/.worktrees/thread-1",
          },
        } satisfies GitCreateWorktreeResult)),
    removeWorktree: input?.removeWorktree ?? (() => Effect.void),
  };
  const projectSetupScriptRunner: Pick<ProjectSetupScriptRunnerShape, "runForThread"> = {
    runForThread:
      input?.runForThread ??
      (() =>
        Effect.succeed({
          status: "started" as const,
          scriptId: "setup",
          scriptName: "Setup",
          terminalId: "setup-setup",
          cwd: "/repo/project/.worktrees/thread-1",
        })),
  };

  return {
    orchestrationEngine,
    git,
    projectSetupScriptRunner,
  };
}

describe("dispatchBootstrapTurnStart", () => {
  it("creates the thread before dispatching the final turn start", async () => {
    const dispatchedCommands: OrchestrationCommand[] = [];
    const dependencies = makeDependencies({
      dispatch: (command) =>
        Effect.sync(() => {
          dispatchedCommands.push(command);
          return { sequence: dispatchedCommands.length };
        }),
    });

    const result = await Effect.runPromise(
      dispatchBootstrapTurnStart({
        ...dependencies,
        command: makeTurnStartCommand({
          bootstrap: {
            createThread: {
              projectId: PROJECT_ID,
              title: "New thread",
              model: "gpt-5-codex",
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: "main",
              worktreePath: null,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          },
        }),
      }),
    );

    expect(result.sequence).toBe(2);
    expect(dispatchedCommands.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.turn.start",
    ]);
    expect(dispatchedCommands[1]).toMatchObject({
      type: "thread.turn.start",
      commandId: "cmd-turn-start",
    });
    expect(
      (dispatchedCommands[1] as Extract<OrchestrationCommand, { type: "thread.turn.start" }>)
        .bootstrap,
    ).toBeUndefined();
  });

  it("prepares a worktree for existing threads before dispatching the final turn start", async () => {
    const dispatchedCommands: OrchestrationCommand[] = [];
    const createWorktree = vi.fn(() =>
      Effect.succeed({
        worktree: {
          branch: "t3code/bootstrap-branch",
          path: "/repo/project/.worktrees/thread-1",
        },
      } satisfies GitCreateWorktreeResult),
    );
    const dependencies = makeDependencies({
      dispatch: (command) =>
        Effect.sync(() => {
          dispatchedCommands.push(command);
          return { sequence: dispatchedCommands.length };
        }),
      // Existing thread with no worktree yet — the client is asking the
      // server to prepare a worktree on the first turn.
      getReadModel: () =>
        Effect.succeed(makeReadModel({ branch: "existing-branch", worktreePath: null })),
      createWorktree,
    });

    await Effect.runPromise(
      dispatchBootstrapTurnStart({
        ...dependencies,
        command: makeTurnStartCommand({
          bootstrap: {
            prepareWorktree: {
              projectCwd: "/repo/project",
              baseBranch: "main",
              branch: "t3code/bootstrap-branch",
            },
            runSetupScript: false,
          },
        }),
      }),
    );

    expect(createWorktree).toHaveBeenCalledWith({
      cwd: "/repo/project",
      branch: "main",
      newBranch: "t3code/bootstrap-branch",
      path: null,
    });
    expect(dispatchedCommands.map((command) => command.type)).toEqual([
      "thread.meta.update",
      "thread.turn.start",
    ]);
    const metaUpdate = dispatchedCommands[0];
    if (metaUpdate?.type !== "thread.meta.update") {
      throw new Error("expected first dispatched command to be thread.meta.update");
    }
    expect(metaUpdate.worktreePath).toBe("/repo/project/.worktrees/thread-1");
  });

  it("skips worktree creation when the thread's read model already has a worktree", async () => {
    // Regression guard: the client may resend `prepareWorktree` on the first
    // send even when its cache shows no worktree, because the cache can lag
    // behind a preloaded read model. The server must short-circuit and
    // honour the existing worktree rather than overwriting it.
    const dispatchedCommands: OrchestrationCommand[] = [];
    const createWorktree = vi.fn(() =>
      Effect.succeed({
        worktree: {
          branch: "t3code/unused",
          path: "/should/not/be/used",
        },
      } satisfies GitCreateWorktreeResult),
    );
    const dependencies = makeDependencies({
      dispatch: (command) =>
        Effect.sync(() => {
          dispatchedCommands.push(command);
          return { sequence: dispatchedCommands.length };
        }),
      getReadModel: () =>
        Effect.succeed(
          makeReadModel({
            branch: "existing-branch",
            worktreePath: "/repo/project/.worktrees/existing-thread",
          }),
        ),
      createWorktree,
    });

    await Effect.runPromise(
      dispatchBootstrapTurnStart({
        ...dependencies,
        command: makeTurnStartCommand({
          bootstrap: {
            prepareWorktree: {
              projectCwd: "/repo/project",
              baseBranch: "main",
              branch: "t3code/bootstrap-branch",
            },
          },
        }),
      }),
    );

    expect(createWorktree).not.toHaveBeenCalled();
    expect(dispatchedCommands.map((command) => command.type)).toEqual(["thread.turn.start"]);
  });

  it("generates a bootstrap worktree branch when one is omitted", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("1234abcd-0000-0000-0000-000000000000");

    const createWorktree = vi.fn(() =>
      Effect.succeed({
        worktree: {
          branch: "t3code/1234abcd",
          path: "/repo/project/.worktrees/thread-1",
        },
      } satisfies GitCreateWorktreeResult),
    );

    await Effect.runPromise(
      dispatchBootstrapTurnStart({
        ...makeDependencies({ createWorktree }),
        command: makeTurnStartCommand({
          bootstrap: {
            prepareWorktree: {
              projectCwd: "/repo/project",
              baseBranch: "main",
            },
          },
        }),
      }),
    );

    expect(createWorktree).toHaveBeenCalledWith({
      cwd: "/repo/project",
      branch: "main",
      newBranch: "t3code/1234abcd",
      path: null,
    });
  });

  it("runs the setup script after combined create-thread and worktree bootstrap", async () => {
    const dispatchedCommands: OrchestrationCommand[] = [];
    const runForThread = vi.fn(() =>
      Effect.succeed({
        status: "started" as const,
        scriptId: "setup",
        scriptName: "Setup",
        terminalId: "setup-setup",
        cwd: "/repo/project/.worktrees/thread-1",
      }),
    );
    const dependencies = makeDependencies({
      dispatch: (command) =>
        Effect.sync(() => {
          dispatchedCommands.push(command);
          return { sequence: dispatchedCommands.length };
        }),
      runForThread,
    });

    await Effect.runPromise(
      dispatchBootstrapTurnStart({
        ...dependencies,
        command: makeTurnStartCommand({
          bootstrap: {
            createThread: {
              projectId: PROJECT_ID,
              title: "New thread",
              model: "gpt-5-codex",
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: "main",
              worktreePath: null,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
            prepareWorktree: {
              projectCwd: "/repo/project",
              baseBranch: "main",
              branch: "t3code/bootstrap-branch",
            },
            runSetupScript: true,
          },
        }),
      }),
    );

    expect(runForThread).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
      projectId: PROJECT_ID,
      projectCwd: "/repo/project",
      worktreePath: "/repo/project/.worktrees/thread-1",
    });
    expect(dispatchedCommands.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.meta.update",
      "thread.turn.start",
    ]);
  });

  it("records bootstrap traces and metrics when a tracer is provided", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-bootstrap-observability-"));
    const tracePath = path.join(tempDir, "traces.ndjson");

    try {
      const tracerLayer = Layer.effect(
        Tracer.Tracer,
        makeLocalFileTracer({
          filePath: tracePath,
          maxBytes: 1024 * 1024,
          maxFiles: 2,
          batchWindowMs: 10,
        }),
      );

      await Effect.runPromise(
        dispatchBootstrapTurnStart({
          ...makeDependencies(),
          command: makeTurnStartCommand({
            bootstrap: {
              createThread: {
                projectId: PROJECT_ID,
                title: "New thread",
                model: "gpt-5-codex",
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt: "2026-01-01T00:00:00.000Z",
              },
              prepareWorktree: {
                projectCwd: "/repo/project",
                baseBranch: "main",
                branch: "t3code/bootstrap-branch",
              },
              runSetupScript: true,
            },
          }),
        }).pipe(Effect.provide(tracerLayer)),
      );

      const snapshots = await Effect.runPromise(Metric.snapshot);
      expect(
        snapshots.some(
          (snapshot) =>
            snapshot.id === "t3_bootstrap_stage_total" &&
            snapshot.attributes?.stage === "thread-create" &&
            snapshot.attributes?.outcome === "success",
        ),
      ).toBe(true);
      expect(
        snapshots.some(
          (snapshot) =>
            snapshot.id === "t3_setup_script_launch_total" &&
            snapshot.attributes?.outcome === "started",
        ),
      ).toBe(true);
      expect(snapshots.some((snapshot) => snapshot.id === "t3_bootstrap_turn_start_duration")).toBe(
        true,
      );

      const traces = fs
        .readFileSync(tracePath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { name: string; attributes: Record<string, unknown> });
      expect(
        traces.some(
          (record) =>
            record.name === "bootstrap.turn.start" &&
            record.attributes["thread.id"] === THREAD_ID &&
            record.attributes["command.id"] === "cmd-turn-start",
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("deletes a bootstrap-created thread when the final turn dispatch fails", async () => {
    const dispatchedCommands: OrchestrationCommand[] = [];
    const dependencies = makeDependencies({
      dispatch: (command) =>
        Effect.gen(function* () {
          dispatchedCommands.push(command);
          if (command.type === "thread.turn.start") {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "turn start failed",
            });
          }
          return { sequence: dispatchedCommands.length };
        }),
    });

    await expect(
      Effect.runPromise(
        dispatchBootstrapTurnStart({
          ...dependencies,
          command: makeTurnStartCommand({
            bootstrap: {
              createThread: {
                projectId: PROJECT_ID,
                title: "New thread",
                model: "gpt-5-codex",
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            },
          }),
        }),
      ),
    ).rejects.toThrow("turn start failed");

    expect(dispatchedCommands.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.turn.start",
      "thread.delete",
    ]);
  });

  it("restores prior thread metadata and removes the created worktree for existing-thread failures", async () => {
    const dispatchedCommands: OrchestrationCommand[] = [];
    const removeWorktree = vi.fn(() => Effect.void);
    let readCount = 0;
    const dependencies = makeDependencies({
      getReadModel: () => {
        readCount += 1;
        // Reads 1 (capture previous metadata) and 2 (idempotency guard) —
        // existing thread with NO worktree yet, so the bootstrap must
        // actually create one. Read 3+ (post meta-update during rollback) —
        // reflects the newly-bound worktree metadata so the rollback path
        // can tell the worktree was freshly created.
        return Effect.succeed(
          readCount <= 2
            ? makeReadModel({ branch: "existing-branch", worktreePath: null })
            : makeReadModel({
                branch: "t3code/bootstrap-branch",
                worktreePath: "/repo/project/.worktrees/thread-1",
              }),
        );
      },
      dispatch: (command) =>
        Effect.gen(function* () {
          dispatchedCommands.push(command);
          if (command.type === "thread.turn.start") {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "turn start failed",
            });
          }
          return { sequence: dispatchedCommands.length };
        }),
      removeWorktree,
    });

    await expect(
      Effect.runPromise(
        dispatchBootstrapTurnStart({
          ...dependencies,
          command: makeTurnStartCommand({
            bootstrap: {
              prepareWorktree: {
                projectCwd: "/repo/project",
                baseBranch: "main",
                branch: "t3code/bootstrap-branch",
              },
            },
          }),
        }),
      ),
    ).rejects.toThrow("turn start failed");

    expect(dispatchedCommands.map((command) => command.type)).toEqual([
      "thread.meta.update",
      "thread.turn.start",
      "thread.meta.update",
    ]);
    expect(dispatchedCommands[2]).toMatchObject({
      type: "thread.meta.update",
      branch: "existing-branch",
      worktreePath: null,
    });
    expect(removeWorktree).toHaveBeenCalledWith({
      cwd: "/repo/project",
      path: "/repo/project/.worktrees/thread-1",
      force: true,
    });
  });

  it("removes the created worktree without restoring metadata when the bootstrap meta update fails", async () => {
    const dispatchedCommands: OrchestrationCommand[] = [];
    const removeWorktree = vi.fn(() => Effect.void);
    const dependencies = makeDependencies({
      dispatch: (command) =>
        Effect.gen(function* () {
          dispatchedCommands.push(command);
          if (command.type === "thread.meta.update") {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "meta update failed",
            });
          }
          return { sequence: dispatchedCommands.length };
        }),
      removeWorktree,
    });

    await expect(
      Effect.runPromise(
        dispatchBootstrapTurnStart({
          ...dependencies,
          command: makeTurnStartCommand({
            bootstrap: {
              prepareWorktree: {
                projectCwd: "/repo/project",
                baseBranch: "main",
                branch: "t3code/bootstrap-branch",
              },
            },
          }),
        }),
      ),
    ).rejects.toThrow("meta update failed");

    expect(dispatchedCommands.map((command) => command.type)).toEqual(["thread.meta.update"]);
    expect(removeWorktree).toHaveBeenCalledWith({
      cwd: "/repo/project",
      path: "/repo/project/.worktrees/thread-1",
      force: true,
    });
  });

  it("skips rollback for ambiguous meta-update dispatch failures", async () => {
    const dispatchedCommands: OrchestrationCommand[] = [];
    const removeWorktree = vi.fn(() => Effect.void);
    const dependencies = makeDependencies({
      dispatch: (command) =>
        Effect.gen(function* () {
          dispatchedCommands.push(command);
          if (command.type === "thread.meta.update") {
            return yield* new PersistenceSqlError({
              operation: "dispatch",
              detail: "projection flush failed",
            });
          }
          return { sequence: dispatchedCommands.length };
        }),
      removeWorktree,
    });

    await expect(
      Effect.runPromise(
        dispatchBootstrapTurnStart({
          ...dependencies,
          command: makeTurnStartCommand({
            bootstrap: {
              prepareWorktree: {
                projectCwd: "/repo/project",
                baseBranch: "main",
                branch: "t3code/bootstrap-branch",
              },
            },
          }),
        }),
      ),
    ).rejects.toThrow("projection flush failed");

    expect(dispatchedCommands.map((command) => command.type)).toEqual(["thread.meta.update"]);
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("deletes the created thread and removes the created worktree when final dispatch fails after worktree bootstrap", async () => {
    const dispatchedCommands: OrchestrationCommand[] = [];
    const removeWorktree = vi.fn(() => Effect.void);
    const dependencies = makeDependencies({
      dispatch: (command) =>
        Effect.gen(function* () {
          dispatchedCommands.push(command);
          if (command.type === "thread.turn.start") {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "turn start failed",
            });
          }
          return { sequence: dispatchedCommands.length };
        }),
      removeWorktree,
    });

    await expect(
      Effect.runPromise(
        dispatchBootstrapTurnStart({
          ...dependencies,
          command: makeTurnStartCommand({
            bootstrap: {
              createThread: {
                projectId: PROJECT_ID,
                title: "New thread",
                model: "gpt-5-codex",
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt: "2026-01-01T00:00:00.000Z",
              },
              prepareWorktree: {
                projectCwd: "/repo/project",
                baseBranch: "main",
                branch: "t3code/bootstrap-branch",
              },
            },
          }),
        }),
      ),
    ).rejects.toThrow("turn start failed");

    expect(dispatchedCommands.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.meta.update",
      "thread.turn.start",
      "thread.delete",
    ]);
    expect(removeWorktree).toHaveBeenCalledWith({
      cwd: "/repo/project",
      path: "/repo/project/.worktrees/thread-1",
      force: true,
    });
  });

  it("skips rollback for ambiguous final turn dispatch failures", async () => {
    const dispatchedCommands: OrchestrationCommand[] = [];
    const removeWorktree = vi.fn(() => Effect.void);
    const dependencies = makeDependencies({
      dispatch: (command) =>
        Effect.gen(function* () {
          dispatchedCommands.push(command);
          if (command.type === "thread.turn.start") {
            return yield* new PersistenceSqlError({
              operation: "dispatch",
              detail: "post-commit publish failed",
            });
          }
          return { sequence: dispatchedCommands.length };
        }),
      removeWorktree,
    });

    await expect(
      Effect.runPromise(
        dispatchBootstrapTurnStart({
          ...dependencies,
          command: makeTurnStartCommand({
            bootstrap: {
              createThread: {
                projectId: PROJECT_ID,
                title: "New thread",
                model: "gpt-5-codex",
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt: "2026-01-01T00:00:00.000Z",
              },
              prepareWorktree: {
                projectCwd: "/repo/project",
                baseBranch: "main",
                branch: "t3code/bootstrap-branch",
              },
            },
          }),
        }),
      ),
    ).rejects.toThrow("post-commit publish failed");

    expect(dispatchedCommands.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.meta.update",
      "thread.turn.start",
    ]);
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("does not restore stale previous metadata when thread metadata changed concurrently", async () => {
    const dispatchedCommands: OrchestrationCommand[] = [];
    const removeWorktree = vi.fn(() => Effect.void);
    let readCount = 0;
    const dependencies = makeDependencies({
      getReadModel: () => {
        readCount += 1;
        // Reads 1 (capture previous metadata) and 2 (idempotency guard):
        // existing thread with no worktree, so prepareWorktree actually
        // runs. Read 3+ (concurrent meta update by another actor):
        // metadata diverged, so the rollback must refuse to stomp it.
        return Effect.succeed(
          readCount <= 2
            ? makeReadModel({ branch: "existing-branch", worktreePath: null })
            : makeReadModel({
                branch: "other-branch",
                worktreePath: "/repo/project/.worktrees/other-thread",
              }),
        );
      },
      dispatch: (command) =>
        Effect.gen(function* () {
          dispatchedCommands.push(command);
          if (command.type === "thread.turn.start") {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "turn start failed",
            });
          }
          return { sequence: dispatchedCommands.length };
        }),
      removeWorktree,
    });

    await expect(
      Effect.runPromise(
        dispatchBootstrapTurnStart({
          ...dependencies,
          command: makeTurnStartCommand({
            bootstrap: {
              prepareWorktree: {
                projectCwd: "/repo/project",
                baseBranch: "main",
                branch: "t3code/bootstrap-branch",
              },
            },
          }),
        }),
      ),
    ).rejects.toThrow("turn start failed");

    expect(dispatchedCommands.map((command) => command.type)).toEqual([
      "thread.meta.update",
      "thread.turn.start",
    ]);
    expect(removeWorktree).toHaveBeenCalledWith({
      cwd: "/repo/project",
      path: "/repo/project/.worktrees/thread-1",
      force: true,
    });
  });

  it("deletes a bootstrap-created thread when worktree creation fails", async () => {
    const dispatchedCommands: OrchestrationCommand[] = [];
    const dependencies = makeDependencies({
      dispatch: (command) =>
        Effect.sync(() => {
          dispatchedCommands.push(command);
          return { sequence: dispatchedCommands.length };
        }),
      createWorktree: () =>
        Effect.fail(
          new GitCommandError({
            operation: "createWorktree",
            command: "git worktree add",
            cwd: "/repo/project",
            detail: "worktree failed",
          }),
        ),
    });

    await expect(
      Effect.runPromise(
        dispatchBootstrapTurnStart({
          ...dependencies,
          command: makeTurnStartCommand({
            bootstrap: {
              createThread: {
                projectId: PROJECT_ID,
                title: "New thread",
                model: "gpt-5-codex",
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt: "2026-01-01T00:00:00.000Z",
              },
              prepareWorktree: {
                projectCwd: "/repo/project",
                baseBranch: "main",
                branch: "t3code/bootstrap-branch",
              },
            },
          }),
        }),
      ),
    ).rejects.toThrow("worktree failed");

    expect(dispatchedCommands.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.delete",
    ]);
  });

  it("appends cleanup failure detail onto the original bootstrap error", async () => {
    const dependencies = makeDependencies({
      dispatch: (command) =>
        Effect.gen(function* () {
          if (command.type === "thread.turn.start") {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "turn start failed",
            });
          }
          return { sequence: 1 };
        }),
      removeWorktree: () =>
        Effect.fail(
          new GitCommandError({
            operation: "removeWorktree",
            command: "git worktree remove --force",
            cwd: "/repo/project",
            detail: "worktree cleanup failed",
          }),
        ),
    });

    let caught: unknown;
    try {
      await Effect.runPromise(
        dispatchBootstrapTurnStart({
          ...dependencies,
          command: makeTurnStartCommand({
            bootstrap: {
              createThread: {
                projectId: PROJECT_ID,
                title: "New thread",
                model: "gpt-5-codex",
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt: "2026-01-01T00:00:00.000Z",
              },
              prepareWorktree: {
                projectCwd: "/repo/project",
                baseBranch: "main",
                branch: "t3code/bootstrap-branch",
              },
            },
          }),
        }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OrchestrationCommandInvariantError);
    expect((caught as Error).message).toContain("turn start failed");
    expect((caught as Error).message).toContain("Cleanup failed during worktree removal");
    expect((caught as OrchestrationCommandInvariantError).detail).toContain(
      "worktree cleanup failed",
    );
  });

  it("does not attempt cleanup when reading previous thread metadata fails", async () => {
    const dispatch = vi.fn(() => Effect.succeed({ sequence: 1 }));
    const removeWorktree = vi.fn(() => Effect.void);

    await expect(
      Effect.runPromise(
        dispatchBootstrapTurnStart({
          ...makeDependencies({
            dispatch,
            removeWorktree,
            getReadModel: () =>
              Effect.sync(() => {
                throw new Error("read model failed");
              }),
          }),
          command: makeTurnStartCommand({
            bootstrap: {
              prepareWorktree: {
                projectCwd: "/repo/project",
                baseBranch: "main",
                branch: "t3code/bootstrap-branch",
              },
            },
          }),
        }),
      ),
    ).rejects.toThrow("read model failed");

    expect(dispatch).not.toHaveBeenCalled();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("treats setup script launch failure as non-fatal", async () => {
    const dispatchedCommands: OrchestrationCommand[] = [];
    const before = await Effect.runPromise(Metric.snapshot);
    const dependencies = makeDependencies({
      dispatch: (command) =>
        Effect.sync(() => {
          dispatchedCommands.push(command);
          return { sequence: dispatchedCommands.length };
        }),
      runForThread: () => Effect.fail(new Error("pty unavailable")),
    });

    const result = await Effect.runPromise(
      dispatchBootstrapTurnStart({
        ...dependencies,
        command: makeTurnStartCommand({
          bootstrap: {
            createThread: {
              projectId: PROJECT_ID,
              title: "New thread",
              model: "gpt-5-codex",
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: "main",
              worktreePath: null,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
            prepareWorktree: {
              projectCwd: "/repo/project",
              baseBranch: "main",
              branch: "t3code/bootstrap-branch",
            },
            runSetupScript: true,
          },
        }),
      }),
    );

    expect(result.sequence).toBe(3);
    expect(dispatchedCommands.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.meta.update",
      "thread.turn.start",
    ]);
    expect(dispatchedCommands.every((command) => command.type !== "thread.delete")).toBe(true);

    const after = await Effect.runPromise(Metric.snapshot);
    expect(
      counterValue(after, "t3_bootstrap_stage_total", {
        stage: "setup-script-launch",
        outcome: "failure",
      }) -
        counterValue(before, "t3_bootstrap_stage_total", {
          stage: "setup-script-launch",
          outcome: "failure",
        }),
    ).toBe(1);
    expect(
      counterValue(after, "t3_setup_script_launch_total", {
        outcome: "failure",
      }) -
        counterValue(before, "t3_setup_script_launch_total", {
          outcome: "failure",
        }),
    ).toBe(1);
  });
});
