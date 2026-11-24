import type {
  ThreadTurnStartCommand,
  WorkflowAttribution,
  WorkflowReviewTarget,
  WorkflowRunKind,
} from "@t3tools/contracts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";
import { WORKFLOW_SUBAGENT_FINDING_INSTRUCTIONS } from "./workflowFindingProtocol.ts";

export function dispatchWorkflowTurn(
  engine: OrchestrationEngineShape,
  runKind: WorkflowRunKind,
  workflowId: string,
  taskId: string,
  command: ThreadTurnStartCommand,
  reviewTarget?: WorkflowReviewTarget,
  findingRefs?: readonly string[],
) {
  const workflowAttribution: WorkflowAttribution = {
    runKind,
    workflowId,
    taskId,
    originCommandId: command.commandId,
    ...(reviewTarget ? { reviewTarget } : {}),
    ...(findingRefs ? { findingRefs } : {}),
  };
  return engine.dispatch({ ...command, workflowAttribution });
}

export function structuredReviewPrompt(prompt: string, reader = false): string {
  return [
    prompt,
    "Keep the public report readable. End it with exactly one f5-findings-v1 fenced JSON block. Use [] if there are no findings.",
    reader
      ? "Report problems that prevent the reader from understanding the document or acting on it."
      : "",
    "Each entry must have a unique local id, severity (critical, high, medium or low), title, description, location (a file and line or artifact section, or null) and evidence (text or null).",
    "When available, quote the exact affected line or document passage and name the specific test case and F5 execution that reproduced the issue in evidence.",
    WORKFLOW_SUBAGENT_FINDING_INSTRUCTIONS,
    'Format: a fence labeled f5-findings-v1 containing [{"id":"1","severity":"high","title":"Problem","description":"Impact","location":null,"evidence":null}]. Place it inside the delivered artifact if using a native plan submission.',
  ]
    .filter(Boolean)
    .join("\n\n");
}
