import type { ScheduledTaskConfiguration } from "@t3tools/contracts";
/** Execution-affecting fields, shared by admission validation and metadata-only UI edits. */
export function scheduledExecutionConfiguration(value: ScheduledTaskConfiguration) {
  return {
    prompt: value.prompt,
    modelSelection: value.modelSelection,
    runtimeMode: value.runtimeMode,
    workspace: value.workspace,
    cron: value.cron,
    timezone: value.timezone,
    maxRuns: value.maxRuns,
    oneShotAt: value.oneShotAt,
  };
}
