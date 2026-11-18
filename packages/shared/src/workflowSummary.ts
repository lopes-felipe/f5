/** Projection and client summaries share the same omission rules. Generics also
 * accept encoded repository rows without throwing away their decoded brands. */
export function summarizePlanningWorkflow<
  T extends {
    requirementPrompt: string;
    plansDirectory: string;
    archiveRestorations?: unknown;
    implementation?:
      | {
          reviewArtifact?: unknown;
          revisionAttempt?: unknown;
          revisionDispatchCommandId?: unknown;
          codeReviews: ReadonlyArray<object>;
        }
      | null
      | undefined;
  },
>(
  workflow: T,
): Omit<T, "requirementPrompt" | "plansDirectory" | "implementation" | "archiveRestorations"> & {
  implementation:
    | (Omit<
        NonNullable<T["implementation"]>,
        "reviewArtifact" | "revisionAttempt" | "revisionDispatchCommandId" | "codeReviews"
      > & {
        codeReviews: ReadonlyArray<
          Omit<
            NonNullable<T["implementation"]>["codeReviews"][number],
            "pinnedTurnId" | "pinnedAssistantMessageId"
          >
        >;
      })
    | null;
} {
  const {
    requirementPrompt: _prompt,
    plansDirectory: _directory,
    archiveRestorations: _restorations,
    implementation,
    ...summary
  } = workflow;
  if (!implementation) return { ...summary, implementation: null };
  const {
    reviewArtifact: _artifact,
    revisionAttempt: _attempt,
    revisionDispatchCommandId: _dispatch,
    codeReviews,
    ...stage
  } = implementation;
  return {
    ...summary,
    implementation: {
      ...stage,
      codeReviews: codeReviews.map(
        ({
          pinnedTurnId: _turn,
          pinnedAssistantMessageId: _message,
          ...review
        }: NonNullable<T["implementation"]>["codeReviews"][number] & {
          pinnedTurnId?: unknown;
          pinnedAssistantMessageId?: unknown;
        }) => review,
      ),
    } as NonNullable<ReturnType<typeof summarizePlanningWorkflow<T>>["implementation"]>,
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
