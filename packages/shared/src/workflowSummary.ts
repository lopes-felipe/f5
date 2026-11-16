/** Projection and client summaries share the same omission rules. Generics also
 * accept encoded repository rows without throwing away their decoded brands. */
export function summarizePlanningWorkflow<
  T extends {
    requirementPrompt: string;
    plansDirectory: string;
    archiveRestorations?: unknown;
    implementation?: { reviewArtifact?: unknown } | null | undefined;
  },
>(
  workflow: T,
): Omit<T, "requirementPrompt" | "plansDirectory" | "implementation" | "archiveRestorations"> & {
  implementation: Omit<NonNullable<T["implementation"]>, "reviewArtifact"> | null;
} {
  const {
    requirementPrompt: _prompt,
    plansDirectory: _directory,
    archiveRestorations: _restorations,
    implementation,
    ...summary
  } = workflow;
  if (!implementation) return { ...summary, implementation: null };
  const { reviewArtifact: _artifact, ...stage } = implementation;
  return {
    ...summary,
    implementation: stage as Omit<NonNullable<T["implementation"]>, "reviewArtifact">,
  };
}
export function summarizeCodeReviewWorkflow<
  T extends { reviewPrompt: string; archiveRestorations?: unknown },
>({ reviewPrompt: _prompt, archiveRestorations: _restorations, ...summary }: T) {
  return summary;
}
export function summarizeInvestigationWorkflow<
  T extends { problemPrompt: string; archiveRestorations?: unknown },
>({ problemPrompt: _prompt, archiveRestorations: _restorations, ...summary }: T) {
  return summary;
}
