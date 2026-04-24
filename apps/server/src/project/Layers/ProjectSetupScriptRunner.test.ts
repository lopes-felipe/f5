import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  type OrchestrationReadModel,
  type TerminalSessionSnapshot,
} from "@t3tools/contracts";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import { TerminalManager, type TerminalManagerShape } from "../../terminal/Services/Manager.ts";
import { ProjectSetupScriptRunner } from "../Services/ProjectSetupScriptRunner.ts";
import { ProjectSetupScriptRunnerLive } from "./ProjectSetupScriptRunner.ts";

function makeReadModel(withSetupScript: boolean): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModel: "gpt-5-codex",
        scripts: withSetupScript
          ? [
              {
                id: "setup",
                name: "Setup",
                command: "bun install",
                icon: "configure",
                runOnWorktreeCreate: true,
              },
            ]
          : [],
        memories: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      },
    ],
    planningWorkflows: [],
    codeReviewWorkflows: [],
    threads: [
      {
        id: ThreadId.makeUnsafe("thread-1"),
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Thread",
        model: "gpt-5-codex",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        archivedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastInteractionAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
        messages: [],
        activities: [],
        proposedPlans: [],
        tasks: [],
        tasksTurnId: null,
        tasksUpdatedAt: null,
        checkpoints: [],
        compaction: null,
        session: null,
      },
    ],
  };
}

function makeTerminalManagerMocks() {
  const open = vi.fn((input) =>
    Effect.succeed({
      threadId: input.threadId,
      terminalId: input.terminalId ?? "default",
      cwd: input.cwd,
      status: "running",
      pid: 1234,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    } satisfies TerminalSessionSnapshot),
  );
  const write = vi.fn(() => Effect.void);

  const terminalManager: TerminalManagerShape = {
    open,
    write,
    resize: () => Effect.void,
    clear: () => Effect.void,
    restart: (input) =>
      Effect.succeed({
        threadId: input.threadId,
        terminalId: input.terminalId ?? "default",
        cwd: input.cwd,
        status: "running",
        pid: 1234,
        history: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    close: () => Effect.void,
    subscribe: () => Effect.succeed(() => undefined),
    dispose: Effect.void,
  };

  return {
    open,
    write,
    terminalManager,
  };
}

function makeOrchestrationEngine(readModel: OrchestrationReadModel): OrchestrationEngineShape {
  return {
    getReadModel: () => Effect.succeed(readModel),
    readEvents: () => Stream.empty,
    dispatch: () => Effect.succeed({ sequence: 1 }),
    streamDomainEvents: Stream.empty,
  };
}

async function runRunner(input: {
  readModel: OrchestrationReadModel;
  threadId?: ThreadId;
  projectId?: ProjectId;
  projectCwd?: string;
  worktreePath: string;
}) {
  const terminal = makeTerminalManagerMocks();
  const layer = ProjectSetupScriptRunnerLive.pipe(
    Layer.provideMerge(
      Layer.succeed(OrchestrationEngineService, makeOrchestrationEngine(input.readModel)),
    ),
    Layer.provideMerge(Layer.succeed(TerminalManager, terminal.terminalManager)),
  );

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner;
      return yield* runner.runForThread({
        threadId: input.threadId ?? ThreadId.makeUnsafe("thread-1"),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.projectCwd ? { projectCwd: input.projectCwd } : {}),
        worktreePath: input.worktreePath,
      });
    }).pipe(Effect.provide(layer)),
  );

  return {
    result,
    terminal,
  };
}

describe("ProjectSetupScriptRunnerLive", () => {
  it("returns no-script when the project has no setup script", async () => {
    const { result, terminal } = await runRunner({
      readModel: makeReadModel(false),
      projectId: ProjectId.makeUnsafe("project-1"),
      worktreePath: "/repo/project/.worktrees/thread-1",
    });

    expect(result).toEqual({
      status: "no-script",
    });
    expect(terminal.open).not.toHaveBeenCalled();
    expect(terminal.write).not.toHaveBeenCalled();
  });

  it("opens the deterministic setup terminal and writes the setup command", async () => {
    const { result, terminal } = await runRunner({
      readModel: makeReadModel(true),
      projectCwd: "/repo/project",
      worktreePath: "/repo/project/.worktrees/thread-1",
    });

    expect(result).toEqual({
      status: "started",
      scriptId: "setup",
      scriptName: "Setup",
      terminalId: "setup-setup",
      cwd: "/repo/project/.worktrees/thread-1",
    });
    expect(terminal.open).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
      terminalId: "setup-setup",
      cwd: "/repo/project/.worktrees/thread-1",
      env: {
        T3CODE_PROJECT_ROOT: "/repo/project",
        T3CODE_WORKTREE_PATH: "/repo/project/.worktrees/thread-1",
      },
    });
    expect(terminal.write).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
      terminalId: "setup-setup",
      data: "bun install\r",
    });
  });
});
