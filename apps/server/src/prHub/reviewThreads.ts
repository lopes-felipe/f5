import type { PrHubReviewThread } from "@t3tools/contracts";
export type ReviewThreadFact = PrHubReviewThread;
export type ReviewCommentFact = PrHubReviewThread["comments"][number];

export const GITHUB_REVIEW_COMMENT_FIELDS = `id body bodyText url author { login ... on User { databaseId } } createdAt updatedAt outdated diffHunk`;
export const GITHUB_REVIEW_THREAD_FIELDS = `id isResolved isOutdated path line originalLine diffSide startLine originalStartLine startDiffSide viewerCanReply viewerCanResolve viewerCanUnresolve`;
export const GITHUB_REVIEW_THREADS_SELECTION = `
  reviewThreads(first:100) {
    totalCount
    nodes {
      ${GITHUB_REVIEW_THREAD_FIELDS}
      comments(first:20) {
        totalCount
        nodes { ${GITHUB_REVIEW_COMMENT_FIELDS} }
      }
    }
  }
`;

export const GITHUB_UNRESOLVED_THREADS_QUERY = `query PrHubReviewThreads($owner:String!,$repo:String!,$number:Int!) {
  repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
    ${GITHUB_REVIEW_THREADS_SELECTION}
  } }
}`;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : null;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function nodeArray(connection: unknown): Record<string, unknown>[] {
  return asArray(asRecord(connection)?.nodes)
    .map(asRecord)
    .filter((node): node is Record<string, unknown> => node !== null);
}

export function parseReviewThreads(connection: unknown): ReviewThreadFact[] {
  return nodeArray(connection).map((thread) => ({
    id: stringValue(thread.id) ?? "",
    isResolved: booleanValue(thread.isResolved),
    path: stringValue(thread.path),
    line: numberValue(thread.line),
    originalLine: numberValue(thread.originalLine),
    ...(typeof thread.isOutdated === "boolean" ? { isOutdated: thread.isOutdated } : {}),
    ...(typeof thread.viewerCanReply === "boolean"
      ? { viewerCanReply: thread.viewerCanReply }
      : {}),
    ...(typeof thread.viewerCanResolve === "boolean"
      ? { viewerCanResolve: thread.viewerCanResolve }
      : {}),
    ...(typeof thread.viewerCanUnresolve === "boolean"
      ? { viewerCanUnresolve: thread.viewerCanUnresolve }
      : {}),
    ...(thread.diffSide === "LEFT" || thread.diffSide === "RIGHT"
      ? { diffSide: thread.diffSide }
      : {}),
    ...(thread.startDiffSide === "LEFT" || thread.startDiffSide === "RIGHT"
      ? { startDiffSide: thread.startDiffSide }
      : {}),
    ...(thread.startLine !== undefined ? { startLine: numberValue(thread.startLine) } : {}),
    ...(thread.originalStartLine !== undefined
      ? { originalStartLine: numberValue(thread.originalStartLine) }
      : {}),
    comments: nodeArray(thread.comments).map((comment) => ({
      id: stringValue(comment.id) ?? "",
      url: stringValue(comment.url) ?? "",
      author: stringValue(asRecord(comment.author)?.login),
      bodyText: stringValue(comment.bodyText) ?? "",
      ...(typeof comment.body === "string" ? { body: comment.body } : {}),
      createdAt: stringValue(comment.createdAt),
      updatedAt: stringValue(comment.updatedAt),
      outdated: booleanValue(comment.outdated),
      diffHunk: stringValue(comment.diffHunk),
      ...(asRecord(comment.author)?.databaseId !== undefined
        ? { authorId: numberValue(asRecord(comment.author)?.databaseId) }
        : {}),
    })),
  }));
}

export function decodeUnresolvedThreads(response: unknown) {
  const root = asRecord(response);
  if (Array.isArray(root?.errors) && root.errors.length > 0)
    throw new Error("GitHub returned incomplete review threads.");
  const pr = asRecord(asRecord(asRecord(root?.data)?.repository)?.pullRequest);
  const connection = asRecord(pr?.reviewThreads);
  if (!connection || !Array.isArray(connection.nodes))
    throw new Error("GitHub returned invalid review threads.");
  const nodes = nodeArray(connection);
  // Count omitted resolved threads too: an unseen page may contain actionable feedback.
  let omittedCount = Math.max(
    0,
    (numberValue(connection.totalCount) ?? nodes.length) - nodes.length,
  );
  for (const thread of nodes) {
    omittedCount += Math.max(
      0,
      (numberValue(asRecord(thread.comments)?.totalCount) ?? 0) - nodeArray(thread.comments).length,
    );
  }
  return {
    threads: parseReviewThreads(connection).filter((thread) => !thread.isResolved),
    truncated: omittedCount > 0,
    omittedCount,
  };
}
