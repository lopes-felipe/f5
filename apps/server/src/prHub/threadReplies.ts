import { createHash, randomUUID } from "node:crypto";
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
/**
 * Reads the operation together with its stored correlation nonce. The nonce is the
 * published body marker, so reconciliation must use the persisted value rather than
 * re-deriving it: rows written before the nonce became server-generated still carry
 * the operation id there.
 */
function readReplyRow(owner: PrHubDraftOwner, threadId: string, id?: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      operation_id: string;
      status: string;
      remote_id: string | null;
      payload_json: string;
      payload_hash: string;
      correlation_nonce: string;
    }>`SELECT operation_id, status, remote_id, payload_json, payload_hash, correlation_nonce FROM pr_hub_operations
      WHERE provider_kind = ${owner.provider} AND host = ${owner.host} AND viewer_id = ${owner.viewerId} AND repo = ${owner.repo} AND number = ${owner.number}
        AND kind = 'reply' AND json_extract(payload_json, '$.threadId') = ${threadId} AND (${id ?? null} IS NULL OR operation_id = ${id ?? null})
      ORDER BY CASE WHEN status IN ('prepared', 'creating', 'outcome_unknown') THEN 0 ELSE 1 END, created_at DESC LIMIT 1`;
    const row = rows[0];
    if (!row) return null;
    if (hash(row.payload_json) !== row.payload_hash)
      return yield* error("The immutable reply payload failed verification.");
    const operation = yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(PrHubReplyOperation)({
          ...JSON.parse(row.payload_json),
          id: row.operation_id,
          status: row.status,
          remoteId: row.remote_id,
        }),
      catch: () => error("The saved reply operation is invalid."),
    });
    return { operation, nonce: row.correlation_nonce };
  });
}

export function readReplyOperation(owner: PrHubDraftOwner, threadId: string, id?: string) {
  return readReplyRow(owner, threadId, id).pipe(Effect.map((row) => row?.operation ?? null));
}
export function reconcileThreadReply(
  owner: PrHubDraftOwner,
  context: ThreadReaderContext,
  threadId: string,
  id?: string,
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const row = yield* readReplyRow(owner, threadId, id);
    if (
      !row ||
      row.operation.status === "succeeded" ||
      row.operation.status === "rejected" ||
      row.operation.status === "abandoned" ||
      row.operation.status === "prepared"
    )
      return row?.operation ?? null;
    const operation = row.operation;
    const marker = prReplyBody(operation.body, row.nonce);
    let cursor: string | undefined;
    const matches: string[] = [];
    for (let page = 0; page < 20; page++) {
      const result = yield* readReviewThreadPage(context, {
        key: context.key as PrHubReplyInput["key"],
        threadId,
        ...(cursor ? { cursor } : {}),
      });
      for (const comment of result.threads[0]?.comments ?? [])
        if (String(comment.authorId) === owner.viewerId && comment.body === marker)
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
    // A partial unique index allows one active reply per thread. Report the blocking
    // operation instead of letting the INSERT surface a raw constraint violation.
    const blocking = yield* readReplyOperation(owner, input.threadId);
    if (blocking && ["prepared", "creating", "outcome_unknown"].includes(blocking.status))
      return yield* error(
        "Another reply to this thread is still in progress. Resolve or abandon it before sending a new one.",
      );
    yield* context.verifyAccount;
    const payload = JSON.stringify({
      version: 2,
      source: "thread_reply",
      threadId: input.threadId,
      body: input.body,
      comparisonVersion: input.comparisonVersion,
    });
    // The published marker must be unguessable and unique per send. A client-supplied
    // operation id could repeat across sends and make two replies indistinguishable.
    const nonce = randomUUID();
    const markedBody = prReplyBody(input.body, nonce);
    const now = new Date().toISOString();
    // Recording the send and its outcome is one indivisible step; the reads above stay
    // cancellable.
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* sql`INSERT INTO pr_hub_operations(provider_kind, host, viewer_id, repo, number, operation_id, kind, status,
      payload_hash, payload_json, draft_version, correlation_nonce, created_at, updated_at)
      VALUES (${owner.provider}, ${owner.host}, ${owner.viewerId}, ${owner.repo}, ${owner.number}, ${input.id}, 'reply', 'creating',
        ${hash(payload)}, ${payload}, NULL, ${nonce}, ${now}, ${now})`;
        const sent = yield* Effect.exit(
          context.query(
            `mutation F5ThreadReply($id:ID!,$body:String!) {
      addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}) { comment { id body author { ... on User { databaseId } } } }
    }`,
            { id: input.threadId, body: markedBody },
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
          comment.body === markedBody;
        yield* sql`UPDATE pr_hub_operations SET status = ${confirmed ? "succeeded" : "outcome_unknown"}, remote_id = COALESCE(${confirmed ? comment.id : null}, remote_id), updated_at = ${new Date().toISOString()}
      WHERE provider_kind = ${owner.provider} AND host = ${owner.host} AND viewer_id = ${owner.viewerId} AND repo = ${owner.repo} AND number = ${owner.number} AND operation_id = ${input.id} AND kind = 'reply' AND status = 'creating'`;
      }),
    );
    return (yield* readReplyOperation(owner, input.threadId, input.id))!;
  });
}
