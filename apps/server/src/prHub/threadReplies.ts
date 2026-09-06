import { createHash } from "node:crypto";
import { Effect, Exit, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  PrHubReplyOperation,
  type PrHubReplyInput,
  type PrHubRecoverReplyInput,
} from "@t3tools/contracts";
import { prReplyBody } from "@t3tools/shared/prReview";
import { readReviewThreadPage, type ThreadReaderContext } from "./threadReader.ts";
import type { PrHubDraftOwner } from "./reviewDrafts.ts";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";

const error = (detail: string) =>
  new SourceControlProviderError({
    provider: "github",
    operation: "prHub.reply",
    kind: "generic",
    detail,
  });
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
export function readReplyOperation(owner: PrHubDraftOwner, threadId: string, id?: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      operation_id: string;
      status: string;
      remote_id: string | null;
      payload_json: string;
      payload_hash: string;
    }>`SELECT operation_id, status, remote_id, payload_json, payload_hash FROM pr_hub_operations
      WHERE provider_kind = ${owner.provider} AND host = ${owner.host} AND viewer_id = ${owner.viewerId} AND repo = ${owner.repo} AND number = ${owner.number}
        AND kind = 'reply' AND json_extract(payload_json, '$.threadId') = ${threadId} AND (${id ?? null} IS NULL OR operation_id = ${id ?? null})
      ORDER BY CASE WHEN status IN ('prepared', 'creating', 'outcome_unknown') THEN 0 ELSE 1 END, created_at DESC LIMIT 1`;
    const row = rows[0];
    if (!row) return null;
    if (hash(row.payload_json) !== row.payload_hash)
      return yield* error("The immutable reply payload failed verification.");
    return yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(PrHubReplyOperation)({
          ...JSON.parse(row.payload_json),
          id: row.operation_id,
          status: row.status,
          remoteId: row.remote_id,
        }),
      catch: () => error("The saved reply operation is invalid."),
    });
  });
}
export function reconcileThreadReply(
  owner: PrHubDraftOwner,
  context: ThreadReaderContext,
  threadId: string,
  id?: string,
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const operation = yield* readReplyOperation(owner, threadId, id);
    if (
      !operation ||
      operation.status === "succeeded" ||
      operation.status === "rejected" ||
      operation.status === "abandoned" ||
      operation.status === "prepared"
    )
      return operation;
    let cursor: string | undefined;
    const matches: string[] = [];
    for (let page = 0; page < 20; page++) {
      const result = yield* readReviewThreadPage(context, {
        key: context.key as PrHubReplyInput["key"],
        threadId,
        ...(cursor ? { cursor } : {}),
      });
      for (const comment of result.threads[0]?.comments ?? [])
        if (
          String(comment.authorId) === owner.viewerId &&
          comment.body === prReplyBody(operation.body, operation.id)
        )
          matches.push(comment.id);
      if (!result.pageInfo.hasNextPage) break;
      cursor = result.pageInfo.endCursor ?? undefined;
      if (!cursor || page === 19) return operation;
    }
    if (matches.length === 1) {
      yield* sql`UPDATE pr_hub_operations SET status = 'succeeded', remote_id = ${matches[0]!}, updated_at = ${new Date().toISOString()}
        WHERE provider_kind = ${owner.provider} AND host = ${owner.host} AND viewer_id = ${owner.viewerId} AND operation_id = ${operation.id} AND kind = 'reply'
          AND status IN ('creating', 'outcome_unknown')`;
      return (yield* readReplyOperation(owner, threadId, operation.id))!;
    }
    return operation;
  });
}

export function recoverThreadReply(
  owner: PrHubDraftOwner,
  context: ThreadReaderContext,
  input: PrHubRecoverReplyInput,
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (input.action === "link") {
      if (!input.remoteId) return yield* error("Enter the GitHub comment node ID to verify.");
      const result = yield* reconcileThreadReply(owner, context, input.threadId, input.id);
      if (result?.status !== "succeeded" || result.remoteId !== input.remoteId)
        return yield* error(
          "The supplied comment could not be verified against this reply's exact marker, author and thread.",
        );
      return result;
    }
    const operation = yield* readReplyOperation(owner, input.threadId, input.id);
    if (!operation || !["creating", "outcome_unknown"].includes(operation.status))
      return yield* error("This reply does not require recovery.");
    yield* sql`UPDATE pr_hub_operations SET status = 'abandoned', updated_at = ${new Date().toISOString()}
      WHERE provider_kind = ${owner.provider} AND host = ${owner.host} AND viewer_id = ${owner.viewerId}
        AND repo = ${owner.repo} AND number = ${owner.number} AND operation_id = ${input.id} AND kind = 'reply'
        AND status IN ('creating', 'outcome_unknown')`;
    return (yield* readReplyOperation(owner, input.threadId, input.id))!;
  });
}
export function replyToReviewThread(
  owner: PrHubDraftOwner,
  context: ThreadReaderContext,
  input: PrHubReplyInput,
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const existing = yield* readReplyOperation(owner, input.threadId, input.id);
    if (existing) {
      if (existing.body !== input.body || existing.comparisonVersion !== input.comparisonVersion)
        return yield* error("This reply operation already has different immutable content.");
      return (yield* reconcileThreadReply(owner, context, input.threadId, input.id))!;
    }
    const before = yield* readReviewThreadPage(context, {
      key: input.key,
      threadId: input.threadId,
    });
    if (
      !before.threads[0]?.viewerCanReply ||
      before.lifecycle !== "OPEN" ||
      before.comparisonVersion !== input.comparisonVersion
    )
      return yield* error("The thread changed or you cannot reply. Reload it before sending.");
    yield* context.verifyAccount;
    const payload = JSON.stringify({
      threadId: input.threadId,
      body: input.body,
      comparisonVersion: input.comparisonVersion,
    });
    const now = new Date().toISOString();
    yield* sql`INSERT INTO pr_hub_operations(provider_kind, host, viewer_id, repo, number, operation_id, kind, status,
      payload_hash, payload_json, draft_version, correlation_nonce, created_at, updated_at)
      VALUES (${owner.provider}, ${owner.host}, ${owner.viewerId}, ${owner.repo}, ${owner.number}, ${input.id}, 'reply', 'creating',
        ${hash(payload)}, ${payload}, 0, ${input.id}, ${now}, ${now})`;
    const sent = yield* Effect.exit(
      context.query(
        `mutation F5ThreadReply($id:ID!,$body:String!) {
      addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}) { comment { id body author { ... on User { databaseId } } } }
    }`,
        { id: input.threadId, body: prReplyBody(input.body, input.id) },
      ),
    );
    const decoded = Exit.isSuccess(sent)
      ? yield* Effect.exit(
          Schema.decodeUnknownEffect(
            Schema.Struct({
              data: Schema.Struct({
                addPullRequestReviewThreadReply: Schema.Struct({
                  comment: Schema.Struct({
                    id: Schema.String,
                    body: Schema.String,
                    author: Schema.Struct({ databaseId: Schema.Number }),
                  }),
                }),
              }),
            }),
          )(sent.value),
        )
      : null;
    const comment =
      decoded && Exit.isSuccess(decoded)
        ? decoded.value.data.addPullRequestReviewThreadReply.comment
        : null;
    const confirmed =
      comment &&
      String(comment.author.databaseId) === owner.viewerId &&
      comment.body === prReplyBody(input.body, input.id);
    yield* sql`UPDATE pr_hub_operations SET status = ${confirmed ? "succeeded" : "outcome_unknown"}, remote_id = ${confirmed ? comment.id : null}, updated_at = ${new Date().toISOString()}
      WHERE provider_kind = ${owner.provider} AND host = ${owner.host} AND viewer_id = ${owner.viewerId} AND operation_id = ${input.id} AND kind = 'reply'`;
    return (yield* readReplyOperation(owner, input.threadId, input.id))!;
  }).pipe(Effect.uninterruptible);
}
