/**
 * GitHub's GraphQL `PullRequest` has no `viewerCanComment` field. A viewer who
 * can read the PR can comment unless the conversation is locked; a locked
 * conversation still accepts comments from people with write access.
 */
export const PR_COMMENT_PERMISSION_PULL_REQUEST_FIELDS = "state locked";
export const PR_COMMENT_PERMISSION_REPOSITORY_FIELDS = "isArchived viewerPermission";

const LOCKED_CONVERSATION_COMMENTERS = new Set(["WRITE", "MAINTAIN", "ADMIN"]);

export function canViewerCommentOnPullRequest(input: {
  readonly locked: unknown;
  readonly viewerPermission: unknown;
}): boolean {
  return (
    input.locked !== true ||
    (typeof input.viewerPermission === "string" &&
      LOCKED_CONVERSATION_COMMENTERS.has(input.viewerPermission))
  );
}

/** GitHub's first GraphQL error message, so a rejected query explains itself. */
export function graphqlErrorMessage(response: unknown): string | null {
  if (!response || typeof response !== "object" || !("errors" in response)) return null;
  const errors = (response as { readonly errors?: unknown }).errors;
  if (!Array.isArray(errors)) return null;
  const message = (errors[0] as { readonly message?: unknown } | undefined)?.message;
  return typeof message === "string" && message.trim().length > 0 ? message.trim() : null;
}
