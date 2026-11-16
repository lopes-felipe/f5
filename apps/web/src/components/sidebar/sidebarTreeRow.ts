import { createContext, useContext, useId } from "react";

/** The row id of the project a nested sidebar row belongs to, or null outside the tree. */
export const SidebarTreeParentContext = createContext<string | null>(null);

/** Row id of a project header in the sidebar tree. */
export function sidebarProjectRowId(projectId: string): string {
  return `project:${projectId}`;
}

/**
 * Props that make a row inside a project one item of the sidebar tree (see `sidebarTree.ts`).
 * Outside a project the row keeps its own role and Tab stop.
 */
export function useSidebarTreeRowProps(rowId?: string) {
  const parent = useContext(SidebarTreeParentContext);
  const generatedId = useId();
  if (parent === null) return {};
  return {
    role: "treeitem",
    tabIndex: -1,
    "data-sidebar-row": rowId ?? `${parent}:${generatedId}`,
    "data-sidebar-parent": parent,
  } as const;
}
