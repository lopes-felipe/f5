import type { OrchestrationEvent } from "@t3tools/contracts";

const inventoryEvents = new Set<OrchestrationEvent["type"]>([
  "thread.created",
  "thread.deleted",
  "thread.archived",
  "thread.unarchived",
  "thread.title-regenerated",
  "project.created",
  "project.meta-updated",
  "project.deleted",
]);

export function affectsWorktreeInventory(event: OrchestrationEvent): boolean {
  if (event.type === "thread.meta-updated")
    return (
      event.payload.branch !== undefined ||
      event.payload.worktreePath !== undefined ||
      event.payload.title !== undefined
    );
  return inventoryEvents.has(event.type);
}
