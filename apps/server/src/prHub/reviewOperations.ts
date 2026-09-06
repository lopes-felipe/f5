import { createHash, randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { PrHubReviewOperation } from "@t3tools/contracts";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";
import { readPrHubReviewDraft, type PrHubDraftOwner } from "./reviewDrafts.ts";

type OperationStatus = PrHubReviewOperation["status"];
export type ReviewOperation = PrHubReviewOperation;
function invalid(detail: string) {
  return new SourceControlProviderError({
    provider: "github",
    operation: "prHub.reviewOperation",
    kind: "generic",
    detail,
  });
}

export function readReviewOperation(owner: PrHubDraftOwner, id: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      operation_id: string;
      status: string;
      payload_hash: string;
      payload_json: string;
      remote_id: string | null;
      correlation_nonce: string;
    }>`
      SELECT operation_id, status, payload_hash, payload_json, remote_id, correlation_nonce
      FROM pr_hub_operations WHERE provider_kind = ${owner.provider} AND host = ${owner.host}
        AND viewer_id = ${owner.viewerId} AND repo = ${owner.repo} AND number = ${owner.number} AND operation_id = ${id} AND kind = 'review'`;
    const row = rows[0];
    if (!row) return null;
    if (createHash("sha256").update(row.payload_json).digest("hex") !== row.payload_hash)
      return yield* invalid(
        "The stored review payload no longer matches its immutable hash. It cannot be submitted.",
      );
    return yield* Effect.try({
      try: (): ReviewOperation =>
        Schema.decodeUnknownSync(PrHubReviewOperation)({
          id: row.operation_id,
          status: row.status,
          payloadHash: row.payload_hash,
          payload: JSON.parse(row.payload_json),
          remoteId: row.remote_id,
          correlationNonce: row.correlation_nonce,
        }),
      catch: () => invalid("The stored review operation is invalid. It cannot be retried."),
    });
  });
}

/** Prepare only local intent. The returned marked body is the submission preview. */
export function prepareReviewOperation(
  owner: PrHubDraftOwner,
  input: { id: string; expectedVersion: number; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" },
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* readReviewOperation(owner, input.id);
        if (existing) {
          if (
            existing.payload.draft.version !== input.expectedVersion ||
            existing.payload.event !== input.event
          )
            return yield* invalid("The operation ID already belongs to different review content.");
          return existing;
        }
        const draft = yield* readPrHubReviewDraft(owner);
        if (!draft || draft.version !== input.expectedVersion || draft.frozen)
          return yield* invalid(
            "The review draft changed or is already frozen. Reload it before preparing submission.",
          );
        if (draft.comparison.mode !== "current_pr")
          return yield* invalid("Changes-since-review drafts cannot be submitted.");
        if (
          draft.content.comments.some(
            (comment) => !comment.body.trim() || comment.commitOid !== draft.comparison.headOid,
          )
        )
          return yield* invalid(
            "Each inline comment needs text and an anchor pinned to the reviewed commit.",
          );
        if (input.event === "REQUEST_CHANGES" && !draft.content.body.trim())
          return yield* invalid("Explain the requested changes in the review body.");
        if (
          input.event === "COMMENT" &&
          !draft.content.body.trim() &&
          draft.content.comments.length === 0
        )
          return yield* invalid("Write a review body or an inline comment before submitting.");
        const nonce = randomUUID();
        const payload = {
          draft,
          event: input.event,
          body: `${draft.content.body}\n\n<!-- F5 review ${nonce} -->`,
        };
        const payloadJson = JSON.stringify(payload);
        const hash = createHash("sha256").update(payloadJson).digest("hex");
        const now = new Date().toISOString();
        yield* sql`INSERT INTO pr_hub_operations
        (provider_kind, host, viewer_id, repo, number, operation_id, kind, status, payload_hash, payload_json,
          draft_version, correlation_nonce, created_at, updated_at)
        VALUES (${owner.provider}, ${owner.host}, ${owner.viewerId}, ${owner.repo}, ${owner.number}, ${input.id},
          'review', 'prepared', ${hash}, ${payloadJson}, ${draft.version}, ${nonce}, ${now}, ${now})`;
        yield* sql`UPDATE pr_hub_review_drafts SET frozen = 1
        WHERE provider_kind = ${owner.provider} AND host = ${owner.host} AND viewer_id = ${owner.viewerId}
          AND repo = ${owner.repo} AND number = ${owner.number} AND version = ${draft.version}`;
        return {
          id: input.id,
          status: "prepared",
          payloadHash: hash,
          payload,
          remoteId: null,
          correlationNonce: nonce,
        } satisfies ReviewOperation;
      }),
    );
  });
}

const transitions: Readonly<Record<OperationStatus, readonly OperationStatus[]>> = {
  prepared: ["creating", "failed_before_send"],
  creating: ["created", "rejected", "outcome_unknown", "abandoned"],
  created: ["submitting", "outcome_unknown", "abandoned"],
  submitting: ["succeeded", "outcome_unknown", "abandoned"],
  // Unknown acceptance requires explicit, verified reconciliation, never a retry.
  outcome_unknown: ["succeeded", "abandoned"],
  abandoned: [],
  succeeded: [],
  failed_before_send: [],
  rejected: [],
};

/** Compare-and-set prevents two callers from executing the same remote stage. */
export function transitionReviewOperation(
  owner: PrHubDraftOwner,
  input: {
    id: string;
    from: OperationStatus;
    to: OperationStatus;
    remoteId?: string;
  },
) {
  return Effect.gen(function* () {
    if (!transitions[input.from].includes(input.to))
      return yield* invalid("Invalid review operation transition.");
    if (input.to === "created" && !input.remoteId)
      return yield* invalid("The created review must have a remote ID.");
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{ draft_version: number }>`UPDATE pr_hub_operations
        SET status = ${input.to}, remote_id = COALESCE(${input.remoteId ?? null}, remote_id), updated_at = ${new Date().toISOString()}
        WHERE provider_kind = ${owner.provider} AND host = ${owner.host} AND viewer_id = ${owner.viewerId}
          AND repo = ${owner.repo} AND number = ${owner.number} AND operation_id = ${input.id} AND kind = 'review' AND status = ${input.from}
        RETURNING draft_version`;
        if (!rows[0]) return false;
        if (["succeeded", "failed_before_send", "rejected", "abandoned"].includes(input.to)) {
          yield* sql`UPDATE pr_hub_review_drafts SET frozen = 0,
          version = version + CASE WHEN ${input.to} = 'succeeded' THEN 1 ELSE 0 END,
          content_json = CASE WHEN ${input.to} = 'succeeded'
            THEN json_set(content_json, '$.body', '', '$.comments', json('[]')) ELSE content_json END
          WHERE provider_kind = ${owner.provider} AND host = ${owner.host} AND viewer_id = ${owner.viewerId}
            AND repo = ${owner.repo} AND number = ${owner.number} AND version = ${rows[0].draft_version}`;
        }
        return true;
      }),
    );
  });
}
