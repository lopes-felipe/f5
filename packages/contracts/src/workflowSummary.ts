import { Schema, Struct } from "effect";
import { PlanningWorkflow, WorkflowImplementation } from "./planningWorkflow";
import { CodeReviewWorkflow } from "./codeReviewWorkflow";
import { InvestigationWorkflow } from "./investigationWorkflow";

// Keep stage identities/statuses for navigation and attention calculations;
// prompts and immutable patch evidence belong only to full run details.
export const PlanningWorkflowSummary = Schema.Struct({
  ...Struct.omit(PlanningWorkflow.fields, [
    "requirementPrompt",
    "plansDirectory",
    "implementation",
    "archiveRestorations",
  ]),
  implementation: Schema.NullOr(
    Schema.Struct(Struct.omit(WorkflowImplementation.fields, ["reviewArtifact"])),
  ).pipe(Schema.withDecodingDefault(() => null)),
});
export type PlanningWorkflowSummary = typeof PlanningWorkflowSummary.Type;
export const CodeReviewWorkflowSummary = Schema.Struct(
  Struct.omit(CodeReviewWorkflow.fields, ["reviewPrompt", "archiveRestorations"]),
);
export type CodeReviewWorkflowSummary = typeof CodeReviewWorkflowSummary.Type;
export const InvestigationWorkflowSummary = Schema.Struct(
  Struct.omit(InvestigationWorkflow.fields, ["problemPrompt", "archiveRestorations"]),
);
export type InvestigationWorkflowSummary = typeof InvestigationWorkflowSummary.Type;

export const WorkflowDetails = Schema.Union([
  Schema.Struct({ runKind: Schema.Literal("planning"), workflow: PlanningWorkflow }),
  Schema.Struct({ runKind: Schema.Literal("codeReview"), workflow: CodeReviewWorkflow }),
  Schema.Struct({ runKind: Schema.Literal("investigation"), workflow: InvestigationWorkflow }),
]);
export type WorkflowDetails = typeof WorkflowDetails.Type;
