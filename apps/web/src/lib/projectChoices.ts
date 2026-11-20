/** Stable grouping preserves a user's existing project order within each group. */
export function projectChoices<T extends { pinned?: boolean; archived?: boolean }>(
  projects: readonly T[],
): T[] {
  return projects
    .filter((project) => !project.archived)
    .toSorted((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
}
