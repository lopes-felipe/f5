import type { TaskItem, ToolCompletionEnvelope, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  emptyTaskToolTracking,
  reduceTaskToolLifecycle,
  revertTaskToolState,
  type TaskToolName,
  type TaskToolState,
} from "./claudeTaskToolProjection";

const TURN_1 = "turn-1" as TurnId;
const TURN_2 = "turn-2" as TurnId;

function completion(
  callId: string,
  toolName: TaskToolName,
  input: unknown,
  output: unknown,
  overrides: Partial<ToolCompletionEnvelope> = {},
): ToolCompletionEnvelope {
  return {
    version: 1,
    nativeCallId: callId,
    nativeSessionId: "session-1",
    toolName,
    input,
    structuredOutput: output,
    transportError: false,
    semanticSuccess: true,
    ...overrides,
  };
}

/** Run a started + completed pair and return the resulting state. */
function call(
  state: TaskToolState,
  callId: string,
  toolName: TaskToolName,
  input: unknown,
  output: unknown,
  options: { turnId?: TurnId; overrides?: Partial<ToolCompletionEnvelope> } = {},
): TaskToolState {
  const turnId = options.turnId ?? TURN_1;
  const started =
    reduceTaskToolLifecycle(state, { phase: "started", nativeCallId: callId, toolName, turnId }) ??
    state;
  return (
    reduceTaskToolLifecycle(started, {
      phase: "completed",
      nativeCallId: callId,
      toolName,
      turnId,
      completion: completion(callId, toolName, input, output, options.overrides),
    }) ?? started
  );
}

const empty: TaskToolState = { tasks: [], tracking: null };

function create(state: TaskToolState, id: string, subject: string, turnId: TurnId = TURN_1) {
  return call(
    state,
    `create-${id}`,
    "TaskCreate",
    { subject, description: `${subject} details`, activeForm: `${subject}ing` },
    { task: { id, subject } },
    { turnId },
  );
}

describe("reduceTaskToolLifecycle", () => {
  it("records a pending call on start and applies a successful TaskCreate", () => {
    const started = reduceTaskToolLifecycle(empty, {
      phase: "started",
      nativeCallId: "call-1",
      toolName: "TaskCreate",
      turnId: TURN_1,
    });
    expect(started?.tracking.pendingCalls).toEqual([
      { nativeCallId: "call-1", toolName: "TaskCreate", generation: 0, turnId: TURN_1 },
    ]);
    const state = create(empty, "1", "Run tests");
    expect(state.tasks).toEqual<TaskItem[]>([
      {
        id: "1",
        content: "Run tests",
        activeForm: "Run testsing",
        status: "pending",
        description: "Run tests details",
      },
    ]);
    expect(state.tracking?.pendingCalls).toEqual([]);
    expect(state.tracking?.syncState).toBe("synced");
    expect(state.tracking?.nativeSessionId).toBe("session-1");
    expect(state.tracking?.provenance).toEqual([
      { taskId: "1", nativeCallId: "create-1", turnId: TURN_1 },
    ]);
  });

  it("falls back to the subject when activeForm is absent", () => {
    const state = call(
      empty,
      "c",
      "TaskCreate",
      { subject: "Lint" },
      { task: { id: "7", subject: "Lint" } },
    );
    expect(state.tasks[0]).toMatchObject({ id: "7", content: "Lint", activeForm: "Lint" });
  });

  it("is idempotent per native call id (duplicate replay)", () => {
    const state = create(empty, "1", "Run tests");
    const replay = reduceTaskToolLifecycle(state, {
      phase: "completed",
      nativeCallId: "create-1",
      toolName: "TaskCreate",
      turnId: TURN_1,
      completion: completion(
        "create-1",
        "TaskCreate",
        { subject: "Run tests" },
        { task: { id: "1", subject: "Run tests" } },
      ),
    });
    expect(replay).toBeUndefined();
    expect(
      reduceTaskToolLifecycle(state, {
        phase: "started",
        nativeCallId: "create-1",
        toolName: "TaskCreate",
        turnId: TURN_1,
      }),
    ).toBeUndefined();
  });

  it("applies TaskUpdate fields, merges dependencies and removes deleted tasks", () => {
    let state = create(create(empty, "1", "Build"), "2", "Ship");
    state = call(
      state,
      "u1",
      "TaskUpdate",
      { taskId: "1", status: "in_progress", owner: "main", addBlocks: ["2"] },
      { success: true, taskId: "1", updatedFields: ["status"] },
    );
    state = call(
      state,
      "u2",
      "TaskUpdate",
      { taskId: "2", status: "in_progress", addBlockedBy: ["1"] },
      { success: true, taskId: "2", updatedFields: ["status"] },
    );
    // Several tasks may be in progress at once.
    expect(state.tasks.map((task) => task.status)).toEqual(["in_progress", "in_progress"]);
    expect(state.tasks[0]).toMatchObject({ owner: "main", blocks: ["2"] });
    expect(state.tasks[1]).toMatchObject({ blockedBy: ["1"] });
    state = call(
      state,
      "u3",
      "TaskUpdate",
      { taskId: "1", status: "deleted" },
      { success: true, taskId: "1", updatedFields: [] },
    );
    expect(state.tasks.map((task) => task.id)).toEqual(["2"]);
    expect(state.tracking?.provenance.map((entry) => entry.taskId)).toEqual(["2"]);
  });

  it("ignores a semantically failed TaskUpdate without fabricating changes", () => {
    const base = create(empty, "1", "Build");
    const state = call(
      base,
      "u1",
      "TaskUpdate",
      { taskId: "1", status: "completed" },
      { success: false, taskId: "1", updatedFields: [], error: "blocked" },
      { overrides: { semanticSuccess: false, semanticError: "blocked" } },
    );
    expect(state.tasks).toEqual(base.tasks);
    expect(state.tracking?.handledCallIds).toContain("u1");
    expect(state.tracking?.syncState).toBe("synced");
  });

  it("marks sync required for unknown ids and unmatched results, never inventing tasks", () => {
    const base = create(empty, "1", "Build");
    const unknown = call(
      base,
      "u1",
      "TaskUpdate",
      { taskId: "99", status: "completed" },
      { success: true, taskId: "99", updatedFields: ["status"] },
    );
    expect(unknown.tasks).toEqual(base.tasks);
    expect(unknown.tracking?.syncState).toBe("sync-required");

    const unmatched = reduceTaskToolLifecycle(base, {
      phase: "completed",
      nativeCallId: "never-started",
      toolName: "TaskUpdate",
      turnId: TURN_1,
      completion: completion(
        "never-started",
        "TaskUpdate",
        { taskId: "1", status: "completed" },
        {
          success: true,
          taskId: "1",
          updatedFields: ["status"],
        },
      ),
    });
    expect(unmatched?.tracking.syncState).toBe("sync-required");
    expect(unmatched?.tasks[0]?.status).toBe("completed");
  });

  it("reconciles TaskList by id, preserving fields the read omits, and clears sync-required", () => {
    let state = create(create(empty, "1", "Build"), "2", "Ship");
    state = call(state, "u", "TaskUpdate", { taskId: "1", owner: "main" }, { success: true });
    state = { ...state, tracking: { ...state.tracking!, syncState: "sync-required" } };
    state = call(
      state,
      "list",
      "TaskList",
      {},
      {
        tasks: [
          { id: "1", subject: "Build it", status: "completed", blockedBy: [] },
          {
            id: "3",
            subject: "Native only",
            status: "pending",
            owner: "agent-a",
            blockedBy: ["1"],
          },
        ],
      },
    );
    expect(state.tasks).toEqual<TaskItem[]>([
      {
        id: "1",
        content: "Build it",
        activeForm: "Building",
        status: "completed",
        description: "Build details",
        owner: "main",
        blockedBy: [],
      },
      {
        id: "3",
        content: "Native only",
        activeForm: "Native only",
        status: "pending",
        owner: "agent-a",
        blockedBy: ["1"],
      },
    ]);
    expect(state.tracking?.syncState).toBe("synced");
    expect(state.tracking?.provenance.map((entry) => entry.taskId)).toEqual(["1"]);
  });

  it("reconciles TaskGet and removes a task the runtime reports missing", () => {
    let state = create(empty, "1", "Build");
    state = call(
      state,
      "get",
      "TaskGet",
      { taskId: "1" },
      {
        task: {
          id: "1",
          subject: "Build",
          description: "new details",
          status: "in_progress",
          blocks: ["2"],
          blockedBy: [],
        },
      },
    );
    expect(state.tasks[0]).toMatchObject({
      status: "in_progress",
      description: "new details",
      activeForm: "Building",
      blocks: ["2"],
    });
    state = call(state, "get-missing", "TaskGet", { taskId: "1" }, { task: null });
    expect(state.tasks).toEqual([]);
  });

  it("handles interleaved concurrent calls independently", () => {
    let state = create(empty, "1", "Build");
    for (const callId of ["a", "b"]) {
      state =
        reduceTaskToolLifecycle(state, {
          phase: "started",
          nativeCallId: callId,
          toolName: "TaskUpdate",
          turnId: TURN_1,
        }) ?? state;
    }
    expect(state.tracking?.pendingCalls.map((entry) => entry.nativeCallId)).toEqual(["a", "b"]);
    for (const [callId, status] of [
      ["b", "completed"],
      ["a", "in_progress"],
    ] as const) {
      state =
        reduceTaskToolLifecycle(state, {
          phase: "completed",
          nativeCallId: callId,
          toolName: "TaskUpdate",
          turnId: TURN_1,
          completion: completion(callId, "TaskUpdate", { taskId: "1", status }, { success: true }),
        }) ?? state;
    }
    expect(state.tasks[0]?.status).toBe("in_progress");
    expect(state.tracking?.pendingCalls).toEqual([]);
    expect(state.tracking?.syncState).toBe("synced");
  });

  it("applies a result whose call started before a restart (pending call persisted)", () => {
    const started = reduceTaskToolLifecycle(create(empty, "1", "Build"), {
      phase: "started",
      nativeCallId: "u-restart",
      toolName: "TaskUpdate",
      turnId: TURN_1,
    })!;
    // Simulate persistence: the state survives as plain JSON.
    const restored = JSON.parse(JSON.stringify(started)) as TaskToolState;
    const completed = reduceTaskToolLifecycle(restored, {
      phase: "completed",
      nativeCallId: "u-restart",
      toolName: "TaskUpdate",
      turnId: TURN_1,
      completion: completion(
        "u-restart",
        "TaskUpdate",
        { taskId: "1", status: "completed" },
        {
          success: true,
        },
      ),
    });
    expect(completed?.tasks[0]?.status).toBe("completed");
    expect(completed?.tracking.syncState).toBe("synced");
  });

  it("does not trust outputs it could not retain", () => {
    const state = call(empty, "list", "TaskList", {}, undefined, {
      overrides: {
        structuredOutput: undefined,
        outputOmission: { reason: "too-large", bytes: 70_000 },
      },
    });
    expect(state.tasks).toEqual([]);
    expect(state.tracking?.syncState).toBe("sync-required");
  });

  it("keeps the last valid snapshot when bounds overflow", () => {
    let state: TaskToolState = { tasks: [], tracking: emptyTaskToolTracking() };
    for (let index = 0; index < 64; index += 1) {
      state = reduceTaskToolLifecycle(state, {
        phase: "started",
        nativeCallId: `p-${index}`,
        toolName: "TaskList",
        turnId: TURN_1,
      })!;
    }
    const overflow = reduceTaskToolLifecycle(state, {
      phase: "started",
      nativeCallId: "p-64",
      toolName: "TaskList",
      turnId: TURN_1,
    });
    expect(overflow?.tracking.syncState).toBe("overflow");
    expect(overflow?.tracking.pendingCalls).toHaveLength(64);

    const many = {
      tasks: Array.from({ length: 513 }, (_, index) => ({
        id: String(index),
        subject: "t",
        status: "pending",
        blockedBy: [],
      })),
    };
    const base = create(empty, "keep", "Keep");
    const listed = call(base, "big-list", "TaskList", {}, many);
    expect(listed.tasks).toEqual(base.tasks);
    expect(listed.tracking?.syncState).toBe("overflow");
  });
});

describe("revertTaskToolState", () => {
  it("clears TodoWrite snapshots that have no tracking", () => {
    expect(
      revertTaskToolState(
        {
          tasks: [{ id: "todo:1", content: "x", activeForm: "x", status: "pending" }],
          tracking: null,
        },
        new Set([TURN_1]),
      ),
    ).toEqual({ tasks: [], tracking: null });
  });

  it("drops and suppresses discarded-turn tasks so TaskList cannot resurrect them", () => {
    let state = create(empty, "1", "Keep", TURN_1);
    state = create(state, "2", "Discard", TURN_2);
    const reverted = revertTaskToolState(state, new Set([TURN_1]));
    expect(reverted.tasks.map((task) => task.id)).toEqual(["1"]);
    expect(reverted.tracking?.generation).toBe(1);
    expect(reverted.tracking?.suppressedTaskIds).toEqual(["2"]);
    expect(reverted.tracking?.syncState).toBe("sync-required");

    const listed = call(
      reverted,
      "list",
      "TaskList",
      {},
      {
        tasks: [
          { id: "1", subject: "Keep", status: "completed", blockedBy: [] },
          { id: "2", subject: "Discard", status: "in_progress", blockedBy: [] },
        ],
      },
    );
    expect(listed.tasks.map((task) => task.id)).toEqual(["1"]);
    expect(listed.tracking?.syncState).toBe("synced");

    // Updates to a suppressed task are expected noise, not a sync failure.
    const updated = call(
      listed,
      "u",
      "TaskUpdate",
      { taskId: "2", status: "completed" },
      {
        success: true,
      },
    );
    expect(updated.tracking?.syncState).toBe("synced");
  });

  it("invalidates pending calls so their late results are ignored", () => {
    const base = create(empty, "1", "Build");
    const pending = reduceTaskToolLifecycle(base, {
      phase: "started",
      nativeCallId: "late",
      toolName: "TaskUpdate",
      turnId: TURN_2,
    })!;
    const reverted = revertTaskToolState(pending, new Set([TURN_1]));
    expect(reverted.tracking?.pendingCalls).toEqual([]);
    expect(reverted.tracking?.invalidatedCallIds).toEqual(["late"]);
    const late = reduceTaskToolLifecycle(reverted, {
      phase: "completed",
      nativeCallId: "late",
      toolName: "TaskUpdate",
      turnId: TURN_2,
      completion: completion(
        "late",
        "TaskUpdate",
        { taskId: "1", status: "completed" },
        {
          success: true,
        },
      ),
    });
    expect(late?.tasks).toEqual(reverted.tasks);
    expect(late?.tracking.invalidatedCallIds).toEqual([]);
    expect(late?.tracking.handledCallIds).toContain("late");
  });

  it("treats an unknown retained set as discarding every attributed task", () => {
    const reverted = revertTaskToolState(create(empty, "1", "Build"), undefined);
    expect(reverted.tasks).toEqual([]);
    expect(reverted.tracking?.suppressedTaskIds).toEqual(["1"]);
  });
});
