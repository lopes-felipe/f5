import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { emptyTaskToolTracking } from "./claudeTaskToolProjection";
import {
  reconcileNativeHistoryProjection,
  retainNativeTurnRows,
} from "./nativeHistoryReconciliation";

describe("native history reconciliation", () => {
  it("preserves unrelated providers, current native commands and unlocated rows", () => {
    const rows = [
      { turnId: "other-provider" },
      { turnId: "kept-native" },
      { turnId: "discarded-native" },
      { turnId: "current-native-command" },
      { turnId: null },
      {},
    ];
    expect(retainNativeTurnRows(rows, new Set(["discarded-native"]))).toEqual(
      rows.filter((row) => row.turnId !== "discarded-native"),
    );
    const latestTurn = { turnId: "current-native-command", state: "running" };
    const projected = reconcileNativeHistoryProjection(
      {
        messages: rows,
        activities: rows,
        proposedPlans: rows,
        latestTurn,
        tasks: [
          {
            id: "unlocated",
            description: "Preserve unknown ownership",
            content: "Preserve unknown ownership",
            activeForm: "Preserving",
            status: "in_progress",
          },
        ],
        tasksTurnId: null,
        tasksUpdatedAt: "2026-10-19T00:00:00.000Z",
      },
      new Set(["discarded-native"]),
    );
    expect(projected.latestTurn).toBe(latestTurn);
    expect(projected.messages).toHaveLength(5);
    expect(projected.tasks.map((task) => task.id)).toEqual(["unlocated"]);
  });
  it("suppresses only task ids with proven abandoned turn ownership", () => {
    const projected = reconcileNativeHistoryProjection(
      {
        messages: [],
        activities: [],
        proposedPlans: [],
        latestTurn: null,
        tasks: ["kept", "removed", "unknown"].map((id) => ({
          id,
          description: id,
          content: id,
          activeForm: id,
          status: "pending" as const,
        })),
        tasksTurnId: TurnId.make("removed-turn"),
        tasksUpdatedAt: "2026-10-19T00:00:00.000Z",
        tasksTracking: {
          ...emptyTaskToolTracking(),
          provenance: [
            { taskId: "kept", nativeCallId: "kept", turnId: TurnId.make("other-provider") },
            { taskId: "removed", nativeCallId: "removed", turnId: TurnId.make("removed-turn") },
            { taskId: "unknown", nativeCallId: "unknown", turnId: null },
          ],
        },
      },
      new Set(["removed-turn"]),
    );
    expect(projected.tasks.map((task) => task.id)).toEqual(["kept", "unknown"]);
    expect(projected.tasksTracking?.suppressedTaskIds).toEqual(["removed"]);
    expect(projected.tasksTurnId).toBeNull();
    expect(projected.tasksTracking?.generation).toBe(1);
  });
});
