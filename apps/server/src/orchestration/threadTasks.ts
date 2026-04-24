import type { TaskItem } from "@t3tools/contracts";

export function validateThreadTasks(
  tasks: ReadonlyArray<Pick<TaskItem, "id" | "status">>,
): string | null {
  const seenIds = new Set<string>();
  for (const task of tasks) {
    if (seenIds.has(task.id)) {
      return `Task ids must be unique; duplicate id '${task.id}' detected.`;
    }
    seenIds.add(task.id);
  }

  const inProgressCount = tasks.filter((task) => task.status === "in_progress").length;
  const hasIncompleteTask = tasks.some((task) => task.status !== "completed");
  if (inProgressCount > 1) {
    return "Only one task may be in_progress at a time.";
  }
  if (hasIncompleteTask && inProgressCount !== 1) {
    return "An incomplete task list must have exactly one task in_progress.";
  }

  return null;
}
