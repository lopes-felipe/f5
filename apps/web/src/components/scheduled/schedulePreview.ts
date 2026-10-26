import { scheduledExecutionConfiguration } from "@t3tools/shared/scheduledTasks";
import type { SchedulePreview, ScheduledTaskConfiguration } from "@t3tools/contracts";
export type PreviewState =
  | { kind: "unpreviewed" }
  | { kind: "loading"; key: string }
  | { kind: "error"; key: string; message: string }
  | { kind: "ready"; key: string; preview: SchedulePreview };
export function confirmedSchedule(
  state: PreviewState,
  key: string,
  now = Date.now(),
): SchedulePreview | null {
  if (state.kind !== "ready" || state.key !== key) return null;
  if (state.preview.oneShotAt && Date.parse(state.preview.oneShotAt) <= now) return null;
  return state.preview.nextFireTimes.length ? state.preview : null;
}
export function validateScheduledDraft(value: ScheduledTaskConfiguration): string | null {
  if (!value.name.trim() || !value.prompt.trim()) return "Enter a name and prompt.";
  if (/^\s*\/(model|plan|default)(\s|$)/i.test(value.prompt))
    return "Interactive /model, /plan and /default commands cannot be scheduled.";
  if (!value.modelSelection.model) return "Select a model.";
  if (value.workspace.kind === "worktree" && !value.workspace.baseBranch.trim())
    return "Choose a base branch or explicitly use the project root.";
  return null;
}

export function isMetadataOnlyScheduleEdit(
  original: ScheduledTaskConfiguration | undefined,
  next: ScheduledTaskConfiguration,
): boolean {
  return (
    !!original &&
    original.enabled === next.enabled &&
    JSON.stringify(scheduledExecutionConfiguration(original)) ===
      JSON.stringify(scheduledExecutionConfiguration(next))
  );
}
