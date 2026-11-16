import type { OrchestrationEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { affectsWorktreeInventory } from "./worktreeInventoryInvalidation";

describe("worktree inventory invalidation", () => {
  it.each([
    [{ model: "model" }, false],
    [{ titleState: "provisional" }, false],
    [{ branch: null }, true],
    [{ worktreePath: null }, true],
    [{ title: "Renamed conversation" }, true],
  ])("only refreshes metadata used by inventory: %j", (payload, expected) => {
    const event = { type: "thread.meta-updated", payload } as OrchestrationEvent;
    expect(affectsWorktreeInventory(event)).toBe(expected);
  });

  it.each([
    ["thread.archived", true],
    ["thread.title-regenerated", true],
    ["thread.deleted", true],
    ["project.deleted", true],
    ["thread.message-sent", false],
  ])("handles %s", (type, expected) => {
    expect(affectsWorktreeInventory({ type } as OrchestrationEvent)).toBe(expected);
  });
});
