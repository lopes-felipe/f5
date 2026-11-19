import type {
  OrchestrationProject,
  OrchestrationThread,
  WorkflowTurnExecutionProfile,
} from "@t3tools/contracts";
import { isScratchProject } from "@t3tools/shared/scratchProject";
import type { SharedInstructionInput } from "../provider/sharedAssistantContract.ts";
import { buildThreadResumeContext } from "./compactionService.ts";

export function deriveThreadTurnCount(thread: OrchestrationThread): number {
  const turnIds = new Set<string>();
  if (thread.latestTurn) turnIds.add(thread.latestTurn.turnId);
  for (const message of thread.messages) {
    if (message.turnId) turnIds.add(message.turnId);
  }
  for (const activity of thread.activities) {
    if (activity.turnId) turnIds.add(activity.turnId);
  }
  return thread.checkpoints.reduce(
    (count, checkpoint) => Math.max(count, checkpoint.checkpointTurnCount),
    turnIds.size,
  );
}

export function buildThreadInstructionContext(input: {
  readonly thread: OrchestrationThread;
  readonly project?: OrchestrationProject | undefined;
  readonly cwd?: string | undefined;
  readonly workflowExecutionProfile?: WorkflowTurnExecutionProfile | undefined;
}): Partial<SharedInstructionInput> {
  const project = isScratchProject(input.project) ? undefined : input.project;
  const projectMemories = project?.memories.filter((memory) => memory.deletedAt === null);
  return {
    ...(project?.title ? { projectTitle: project.title } : {}),
    ...(projectMemories?.length ? { projectMemories } : {}),
    threadTitle: input.thread.title,
    turnCount: deriveThreadTurnCount(input.thread),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    runtimeMode: input.thread.runtimeMode,
    ...(input.workflowExecutionProfile
      ? { workflowExecutionProfile: input.workflowExecutionProfile }
      : {}),
    ...buildThreadResumeContext(input.thread),
  };
}
