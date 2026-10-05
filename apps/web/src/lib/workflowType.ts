import { isDocumentWorkflow } from "@t3tools/shared/documentWorkflow";
import {
  FileTextIcon,
  GitPullRequestArrowIcon,
  type LucideIcon,
  RocketIcon,
  SearchIcon,
} from "lucide-react";

export const WORKFLOW_TYPE_ORDER = ["planning", "codeReview", "investigation", "document"] as const;
export type WorkflowTypeValue = (typeof WORKFLOW_TYPE_ORDER)[number];

export const WORKFLOW_TYPE_DIALOG_LABEL: Record<WorkflowTypeValue, string> = {
  planning: "Feature",
  document: "Document",
  codeReview: "Code Review",
  investigation: "Investigation",
};

export const WORKFLOW_TYPE_DESCRIPTION: Record<WorkflowTypeValue, string> = {
  planning: "Two models draft competing plans, cross-review them, and merge the best of both.",
  codeReview: "Independent reviewers inspect a branch or PR, then the findings are consolidated.",
  investigation: "Explore a question across the codebase and produce a written answer.",
  document: "Draft a document with an author and a reader review loop.",
};

export const WORKFLOW_TYPE_ICON: Record<WorkflowTypeValue, LucideIcon> = {
  planning: RocketIcon,
  codeReview: GitPullRequestArrowIcon,
  investigation: SearchIcon,
  document: FileTextIcon,
};

/**
 * Type icons are neutral wherever workflows are listed (sidebar, header,
 * workflow page): the status colours there mean "running", "needs you" and so
 * on, so a coloured type icon would read as a status. The icon shape carries
 * the type.
 */
export const WORKFLOW_TYPE_ICON_CLASS: Record<WorkflowTypeValue, string> = {
  planning: "text-muted-foreground",
  codeReview: "text-muted-foreground",
  investigation: "text-muted-foreground",
  document: "text-muted-foreground",
};

/** Tint for the selected type card in the New Workflow dialog only. */
export const WORKFLOW_TYPE_TOGGLE_CLASS: Record<WorkflowTypeValue, string> = {
  document: "data-pressed:bg-attention/10 data-pressed:text-attention-foreground",
  planning: "data-pressed:bg-info/10 data-pressed:text-info-foreground",
  codeReview: "data-pressed:bg-success/10 data-pressed:text-success-foreground",
  investigation: "data-pressed:bg-warning/10 data-pressed:text-warning-foreground",
};

export function workflowDisplayType(
  type: Exclude<WorkflowTypeValue, "document">,
  workflow: { readonly templateId?: string | undefined },
): WorkflowTypeValue {
  return type === "planning" && isDocumentWorkflow(workflow) ? "document" : type;
}
