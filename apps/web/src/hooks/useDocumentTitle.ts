import { useEffect } from "react";

import { useWindowTitleDetail } from "../appSettings";
import { setDocumentPageTitle } from "../lib/documentTitle";
import { useStore } from "../store";

/** Sets the page part of the document title while the calling route is mounted. */
export function useDocumentTitle(title: string | null | undefined): void {
  const normalized = title?.trim() || null;
  useEffect(() => {
    setDocumentPageTitle(normalized);
  }, [normalized]);
  useEffect(() => () => setDocumentPageTitle(null), []);
}

/**
 * Thread and workflow pages show their project unless the user opted into
 * detailed titles, which can expose thread names in window switchers.
 */
export function resolveContextTitle(
  detail: "project" | "thread",
  input: { readonly projectName?: string | null; readonly itemTitle?: string | null },
): string | null {
  const projectName = input.projectName?.trim() || null;
  const itemTitle = input.itemTitle?.trim() || null;
  return detail === "thread" ? (itemTitle ?? projectName) : projectName;
}

export function useContextDocumentTitle(input: {
  readonly projectName?: string | null;
  readonly itemTitle?: string | null;
}): void {
  const detail = useWindowTitleDetail();
  useDocumentTitle(resolveContextTitle(detail, input));
}

const WORKFLOW_COLLECTIONS = {
  planning: "planningWorkflows",
  "code-review": "codeReviewWorkflows",
  investigation: "investigationWorkflows",
} as const;

export function useWorkflowDocumentTitle(
  kind: keyof typeof WORKFLOW_COLLECTIONS,
  workflowId: string,
): void {
  const collection = WORKFLOW_COLLECTIONS[kind];
  // Primitive selections keep unrelated store updates from rerendering the route.
  const itemTitle = useStore(
    (store) => store[collection].find((workflow) => workflow.id === workflowId)?.title ?? null,
  );
  const projectName = useStore((store) => {
    const projectId = store[collection].find((workflow) => workflow.id === workflowId)?.projectId;
    return projectId
      ? (store.projects.find((project) => project.id === projectId)?.name ?? null)
      : null;
  });
  useContextDocumentTitle({ projectName, itemTitle });
}
