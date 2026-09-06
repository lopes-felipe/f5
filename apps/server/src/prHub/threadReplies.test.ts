import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { PullRequestKey } from "@t3tools/contracts";
import * as SqliteClient from "../persistence/NodeSqliteClient.ts";
import Migration084 from "../persistence/Migrations/084_PrHubOperations.ts";
import Migration085 from "../persistence/Migrations/085_PrHubActiveReplies.ts";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";
import { readReviewThreadPage, type ThreadReaderContext } from "./threadReader.ts";
import { replyToReviewThread, reconcileThreadReply, recoverThreadReply } from "./threadReplies.ts";

it.layer(SqliteClient.layerMemory())("durable thread replies", (it) => {
  it.effect("holds an uncertain reply and verifies the exact marker and numeric actor", () =>
    Effect.gen(function* () {
      yield* Migration084;
      yield* Migration085;
      const key = PullRequestKey.makeUnsafe("github:github.com/org/repo#1");
      let writes = 0;
      let body = "";
      let actor = 2;
      const context: ThreadReaderContext = {
        key,
        host: "github.com",
        repository: "org/repo",
        number: 1,
        account: "account",
        verifyAccount: Effect.void,
        query: (document, variables) => {
          if (document.includes("mutation F5ThreadReply")) {
            writes++;
            body = String(variables.body);
            return Effect.fail(
              new SourceControlProviderError({
                provider: "github",
                operation: "reply",
                kind: "timeout",
                detail: "response lost",
              }),
            );
          }
          return Effect.succeed({
            data: {
              node: {
                id: "thread",
                isResolved: false,
                viewerCanReply: true,
                pullRequest: {
                  id: "pr",
                  number: 1,
                  state: "OPEN",
                  headRefOid: "head",
                  baseRefOid: "base",
                  headRefName: "topic",
                  baseRefName: "main",
                  repository: { nameWithOwner: "org/repo" },
                },
                comments: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: body
                    ? [
                        {
                          id: "reply",
                          body,
                          bodyText: "Reply",
                          author: { login: "me", databaseId: actor },
                        },
                      ]
                    : [],
                },
              },
            },
          });
        },
      };
      const owner = {
        provider: "github",
        host: "github.com",
        viewerId: "1",
        repo: "org/repo",
        number: 1,
      };
      const page = yield* readReviewThreadPage(context, { key, threadId: "thread" });
      const input = {
        key,
        threadId: "thread",
        id: "reply-operation",
        body: "Reply",
        comparisonVersion: page.comparisonVersion,
      };
      assert.equal((yield* replyToReviewThread(owner, context, input)).status, "outcome_unknown");
      assert.equal((yield* replyToReviewThread(owner, context, input)).status, "outcome_unknown");
      assert.equal(writes, 1);
      actor = 1;
      assert.equal(
        (yield* recoverThreadReply(owner, context, { ...input, action: "link", remoteId: "reply" }))
          .status,
        "succeeded",
      );
      assert.equal(writes, 1);
      actor = 2;
      const second = { ...input, id: "second-operation" };
      assert.equal((yield* replyToReviewThread(owner, context, second)).status, "outcome_unknown");
      assert.equal(
        (yield* recoverThreadReply(owner, context, { ...second, action: "abandon" })).status,
        "abandoned",
      );
      actor = 1;
      assert.equal(
        (yield* reconcileThreadReply(owner, context, "thread", second.id))?.status,
        "abandoned",
      );
      assert.equal((yield* replyToReviewThread(owner, context, second)).status, "abandoned");
      assert.equal(writes, 2);
    }),
  );
});
