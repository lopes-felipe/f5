export function isArchivedWorkflow(workflow: { readonly archivedAt: string | null }): boolean {
  return workflow.archivedAt !== null;
}

export function isDeletedWorkflow(workflow: { readonly deletedAt: string | null }): boolean {
  return workflow.deletedAt !== null;
}

export function isActiveWorkflow(workflow: {
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
}): boolean {
  return !isDeletedWorkflow(workflow) && !isArchivedWorkflow(workflow);
}

export function partitionWorkflowsByArchive<T extends { readonly archivedAt: string | null }>(
  workflows: ReadonlyArray<T>,
): {
  readonly activeWorkflows: T[];
  readonly archivedWorkflows: T[];
} {
  const activeWorkflows: T[] = [];
  const archivedWorkflows: T[] = [];

  for (const workflow of workflows) {
    if (isArchivedWorkflow(workflow)) {
      archivedWorkflows.push(workflow);
    } else {
      activeWorkflows.push(workflow);
    }
  }

  return { activeWorkflows, archivedWorkflows };
}
