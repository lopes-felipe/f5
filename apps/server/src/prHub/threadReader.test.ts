import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { PullRequestKey } from "@t3tools/contracts";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";
import {
  readReviewThreadPage,
  setReviewThreadResolved,
  type ThreadReaderContext,
} from "./threadReader.ts";

const key = PullRequestKey.makeUnsafe("github:github.com/org/repo#1");
export function threadHarness() {
  const state = {
    resolved: false,
    head: "head",
    writes: 0,
    timeout: false,
    comments: [] as unknown[],
    hasNext: false,
    foreign: false,
  };
  const context: ThreadReaderContext = {
    key,
    host: "github.com",
    repository: "org/repo",
    number: 1,
    account: "account",
    verifyAccount: Effect.void,
    query: (document) => {
      if (document.includes("mutation F5ThreadState")) {
        state.writes++;
        state.resolved = !document.includes("unresolveReviewThread");
        if (state.timeout)
          return Effect.fail(
            new SourceControlProviderError({
              provider: "github",
              operation: "query",
              kind: "timeout",
              detail: "response lost",
            }),
          );
      }
      const pr = {
        id: "pr",
        number: state.foreign ? 2 : 1,
        state: "OPEN",
        headRefOid: state.head,
        baseRefOid: "base",
        headRefName: "topic",
        baseRefName: "main",
        repository: { nameWithOwner: "org/repo" },
      };
      const thread = {
        id: "thread",
        isResolved: state.resolved,
        viewerCanResolve: true,
        viewerCanUnresolve: true,
        viewerCanReply: true,
        isOutdated: false,
        path: "a.ts",
        line: 1,
        pullRequest: pr,
        comments: {
          nodes: state.comments,
          totalCount: state.comments.length,
          pageInfo: { hasNextPage: state.hasNext, endCursor: state.hasNext ? "next" : null },
        },
      };
      return Effect.succeed(
        document.includes("query F5ReviewThreads(")
          ? {
              data: {
                repository: {
                  pullRequest: {
                    ...pr,
                    reviewThreads: {
                      nodes: [thread],
                      totalCount: 1,
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              },
            }
          : { data: { node: thread } },
      );
    },
  };
  return { state, context };
}
it.effect("qualifies comment cursors by account, thread and comparison", () =>
  Effect.gen(function* () {
    const { state, context } = threadHarness();
    state.hasNext = true;
    const page = yield* readReviewThreadPage(context, { key });
    const cursor = page.threads[0]!.commentsPageInfo!.endCursor!;
    assert.equal(
      (yield* Effect.exit(
        readReviewThreadPage({ ...context, account: "other" }, { key, threadId: "thread", cursor }),
      ))._tag,
      "Failure",
    );
    state.head = "new-head";
    assert.equal(
      (yield* Effect.exit(readReviewThreadPage(context, { key, threadId: "thread", cursor })))._tag,
      "Failure",
    );
    state.foreign = true;
    assert.equal(
      (yield* Effect.exit(readReviewThreadPage(context, { key, threadId: "thread" })))._tag,
      "Failure",
    );
  }),
);
it.effect("reconciles resolution after timeout without repeating the mutation", () =>
  Effect.gen(function* () {
    const { state, context } = threadHarness();
    state.timeout = true;
    assert.equal((yield* setReviewThreadResolved(context, "thread", true)).isResolved, true);
    yield* setReviewThreadResolved(context, "thread", true);
    assert.equal(state.writes, 1);
  }),
);
