import { createHash } from "node:crypto";
import { Effect, Exit } from "effect";
import type { PrHubThreadsInput, PrHubThreadsPage, PrHubReviewThread } from "@t3tools/contracts";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";
import {
  GITHUB_REVIEW_COMMENT_FIELDS,
  GITHUB_REVIEW_THREAD_FIELDS,
  parseReviewThreads,
} from "./reviewThreads.ts";

const PR_FIELDS = `id number state headRefOid baseRefOid headRefName baseRefName repository { nameWithOwner }`;
const COMMENTS = `totalCount pageInfo { hasNextPage endCursor } nodes { ${GITHUB_REVIEW_COMMENT_FIELDS} }`;
const THREAD_QUERY = `query F5ReviewThread($id:ID!,$cursor:String) {
  node(id:$id) { ... on PullRequestReviewThread { ${GITHUB_REVIEW_THREAD_FIELDS}
    pullRequest { ${PR_FIELDS} } comments(first:100,after:$cursor) { ${COMMENTS} }
  } } rateLimit { cost remaining limit resetAt }
}`;
const THREADS_QUERY = `query F5ReviewThreads($owner:String!,$repo:String!,$number:Int!,$cursor:String) {
  repository(owner:$owner,name:$repo) { pullRequest(number:$number) { ${PR_FIELDS}
    reviewThreads(first:50,after:$cursor) { totalCount pageInfo { hasNextPage endCursor }
      nodes { ${GITHUB_REVIEW_THREAD_FIELDS} comments(first:20) { ${COMMENTS} } }
    }
  } } rateLimit { cost remaining limit resetAt }
}`;
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("GitHub returned incomplete review threads.");
  return value as RecordValue;
}
export interface ThreadReaderContext {
  readonly key: string;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly account: string;
  readonly query: (
    document: string,
    variables: Record<string, string | number | null>,
  ) => Effect.Effect<unknown, SourceControlProviderError>;
  readonly verifyAccount: Effect.Effect<void, SourceControlProviderError>;
}
const failure = (detail: string) =>
  new SourceControlProviderError({
    provider: "github",
    operation: "prHub.reviewThreads",
    kind: "invalid_response",
    detail,
  });
export function readReviewThreadPage(context: ThreadReaderContext, input: PrHubThreadsInput) {
  return Effect.gen(function* () {
    const decode = <A>(fn: () => A) =>
      Effect.try({
        try: fn,
        catch: (cause) =>
          failure(cause instanceof Error ? cause.message : "Invalid review threads."),
      });
    const cursor = input.cursor
      ? yield* decode(() => {
          const value = record(
            JSON.parse(Buffer.from(input.cursor!, "base64url").toString("utf8")),
          );
          if (
            value.account !== context.account ||
            value.key !== context.key ||
            value.threadId !== (input.threadId ?? null) ||
            typeof value.cursor !== "string"
          )
            throw new Error(
              "The review thread cursor belongs to a different account, PR, or thread.",
            );
          return value;
        })
      : null;
    const [owner, repo] = context.repository.split("/");
    const raw = yield* context.query(
      input.threadId ? THREAD_QUERY : THREADS_QUERY,
      input.threadId
        ? { id: input.threadId, cursor: (cursor?.cursor as string) ?? null }
        : {
            owner: owner!,
            repo: repo!,
            number: context.number,
            cursor: (cursor?.cursor as string) ?? null,
          },
    );
    return yield* decode(() => {
      const root = record(raw);
      if (Array.isArray(root.errors) && root.errors.length)
        throw new Error("GitHub returned partial thread data.");
      const data = record(root.data);
      const node = input.threadId ? record(data.node) : null;
      const pr = node ? record(node.pullRequest) : record(record(data.repository).pullRequest);
      if (
        pr.number !== context.number ||
        record(pr.repository).nameWithOwner !== context.repository
      )
        throw new Error("The review thread does not belong to this PR.");
      const revision = createHash("sha256")
        .update(
          JSON.stringify([pr.id, pr.headRefOid, pr.baseRefOid, pr.headRefName, pr.baseRefName]),
        )
        .digest("hex");
      if (cursor && cursor.revision !== revision)
        throw new Error("The PR comparison changed. Reload review threads.");
      const encode = (threadId: string | null, cursor: unknown) => {
        if (typeof cursor !== "string" || !cursor)
          throw new Error("GitHub omitted a review-thread continuation cursor.");
        return Buffer.from(
          JSON.stringify({
            account: context.account,
            key: context.key,
            threadId,
            revision,
            cursor,
          }),
        ).toString("base64url");
      };
      const connection = node ? record(node.comments) : record(pr.reviewThreads);
      const page = record(connection.pageInfo);
      const nodes = node ? [node] : connection.nodes;
      if (!Array.isArray(nodes) || typeof page.hasNextPage !== "boolean")
        throw new Error("GitHub omitted review-thread pagination.");
      for (const value of nodes) {
        const thread = record(value);
        if (
          typeof thread.id !== "string" ||
          typeof thread.isResolved !== "boolean" ||
          !Array.isArray(record(thread.comments).nodes)
        )
          throw new Error("GitHub returned invalid thread facts.");
      }
      const threads = parseReviewThreads({ nodes }).map((thread, index): PrHubReviewThread => {
        const comments = record(record(nodes[index]).comments);
        const page = record(comments.pageInfo);
        if (typeof page.hasNextPage !== "boolean")
          throw new Error("GitHub omitted comment pagination.");
        return {
          ...thread,
          commentsPageInfo: {
            hasNextPage: page.hasNextPage,
            endCursor: page.hasNextPage ? encode(thread.id, page.endCursor) : null,
            truncated: false,
          },
        };
      });
      return {
        threads,
        pageInfo: {
          hasNextPage: page.hasNextPage,
          endCursor: page.hasNextPage ? encode(input.threadId ?? null, page.endCursor) : null,
          truncated: false,
        },
        comparisonVersion: revision,
        refreshedAt: new Date().toISOString(),
        lifecycle: pr.state,
      } satisfies PrHubThreadsPage & { lifecycle: unknown };
    });
  });
}

export function setReviewThreadResolved(
  context: ThreadReaderContext,
  threadId: string,
  resolved: boolean,
) {
  return Effect.gen(function* () {
    const input = { key: context.key as PrHubThreadsInput["key"], threadId };
    const before = yield* readReviewThreadPage(context, input);
    const thread = before.threads[0];
    if (!thread) return yield* failure("Review thread not found.");
    if (thread.isResolved === resolved) return thread;
    if (
      before.lifecycle !== "OPEN" ||
      !(resolved ? thread.viewerCanResolve : thread.viewerCanUnresolve)
    )
      return yield* failure("You cannot change this review thread's resolution.");
    yield* context.verifyAccount;
    const name = resolved ? "resolveReviewThread" : "unresolveReviewThread";
    // A timeout is reconciled by desired state. It never triggers another write.
    const attempt = yield* Effect.exit(
      context.query(
        `mutation F5ThreadState($id:ID!) { ${name}(input:{threadId:$id}) { thread { id isResolved } } }`,
        { id: threadId },
      ),
    );
    const after = yield* readReviewThreadPage(context, input);
    if (after.threads[0]?.isResolved === resolved) return after.threads[0];
    return yield* failure(
      Exit.isFailure(attempt)
        ? "The thread update was interrupted and its desired state could not be verified."
        : "GitHub did not confirm the desired thread state.",
    );
  });
}
