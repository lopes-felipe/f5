export const WORKFLOW_TYPE_ORDER = ["planning", "codeReview", "investigation"] as const;
export type WorkflowTypeValue = (typeof WORKFLOW_TYPE_ORDER)[number];

export const WORKFLOW_TYPE_DIALOG_LABEL: Record<WorkflowTypeValue, string> = {
  planning: "Feature",
  codeReview: "Code Review",
  investigation: "Investigation",
};

export const WORKFLOW_TYPE_TOGGLE_CLASS: Record<WorkflowTypeValue, string> = {
  planning:
    "data-pressed:bg-sky-500/15 data-pressed:text-sky-700 dark:data-pressed:bg-sky-400/10 dark:data-pressed:text-sky-200",
  codeReview:
    "data-pressed:bg-emerald-500/15 data-pressed:text-emerald-700 dark:data-pressed:bg-emerald-400/10 dark:data-pressed:text-emerald-200",
  investigation:
    "data-pressed:bg-amber-500/15 data-pressed:text-amber-700 dark:data-pressed:bg-amber-400/10 dark:data-pressed:text-amber-200",
};

export const WORKFLOW_TYPE_BADGE_CLASS: Record<WorkflowTypeValue, string> = {
  planning: "border-sky-500/40 text-sky-700 dark:text-sky-300",
  codeReview: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
  investigation: "border-amber-500/40 text-amber-700 dark:text-amber-300",
};
