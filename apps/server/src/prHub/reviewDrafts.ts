import { prComparisonsEqual } from "@t3tools/shared/prReview";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  PrHubReviewDraft,
  type PrHubReviewDraftResult,
  type PrHubSaveReviewDraftInput,
} from "@t3tools/contracts";

export interface PrHubDraftOwner {
  readonly provider: string;
  readonly host: string;
  readonly viewerId: string;
  readonly repo: string;
  readonly number: number;
}

export function readPrHubReviewDraft(owner: PrHubDraftOwner) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      version: number;
      comparison_json: string;
      content_json: string;
      updated_at: string;
      frozen: number;
    }>`
      SELECT version, comparison_json, content_json, updated_at, frozen FROM pr_hub_review_drafts
      WHERE provider_kind = ${owner.provider} AND host = ${owner.host} AND viewer_id = ${owner.viewerId}
        AND repo = ${owner.repo} AND number = ${owner.number}`;
    const row = rows[0];
    if (!row) return null;
    return yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(PrHubReviewDraft)({
          version: row.version,
          comparison: JSON.parse(row.comparison_json),
          content: JSON.parse(row.content_json),
          updatedAt: row.updated_at,
          frozen: row.frozen !== 0,
        }),
      catch: (cause) =>
        new SourceControlProviderError({
          provider: "github",
          operation: "prHub.reviewDraft.read",
          kind: "invalid_response",
          detail: "Stored review draft is invalid.",
          cause,
        }),
    });
  });
}

export function savePrHubReviewDraft(owner: PrHubDraftOwner, input: PrHubSaveReviewDraftInput) {
  return Effect.gen(function* () {
    if (Buffer.byteLength(JSON.stringify(input.content), "utf8") > 1024 * 1024)
      return yield* Effect.fail(
        new SourceControlProviderError({
          provider: "github",
          operation: "prHub.reviewDraft.save",
          kind: "generic",
          detail: "Review drafts must fit within 1 MiB.",
        }),
      );
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const previous = yield* readPrHubReviewDraft(owner);
        if (previous?.frozen)
          return { status: "frozen", draft: previous } satisfies PrHubReviewDraftResult;
        if ((previous?.version ?? 0) !== input.expectedVersion)
          return { status: "version_conflict", draft: previous } satisfies PrHubReviewDraftResult;
        // Saving text never translates existing anchors to a different comparison.
        // Revalidation is a separate, explicit operation.
        if (
          previous &&
          !input.revalidate &&
          !prComparisonsEqual(previous.comparison, input.comparison)
        )
          return { status: "version_conflict", draft: previous } satisfies PrHubReviewDraftResult;
        const ids = new Set<string>();
        for (const comment of input.content.comments) {
          if (
            !comment.id ||
            ids.has(comment.id) ||
            !comment.path ||
            !Number.isSafeInteger(comment.line) ||
            comment.line < 1 ||
            comment.commitOid !== input.comparison.headOid ||
            (comment.startLine !== undefined &&
              (!Number.isSafeInteger(comment.startLine) ||
                comment.startLine < 1 ||
                comment.startLine > comment.line ||
                comment.startSide !== comment.side)) ||
            (comment.startSide !== undefined && comment.startLine === undefined)
          ) {
            return yield* new SourceControlProviderError({
              provider: "github",
              operation: "prHub.reviewDraft.save",
              kind: "invalid_response",
              detail:
                "Review comments require unique IDs and valid anchors pinned to the draft comparison.",
            });
          }
          ids.add(comment.id);
        }
        const draft: PrHubReviewDraft = {
          version: input.expectedVersion + 1,
          comparison: input.comparison,
          content: input.content,
          updatedAt: new Date().toISOString(),
          frozen: false,
        };
        yield* sql`INSERT INTO pr_hub_review_drafts
        (provider_kind, host, viewer_id, repo, number, version, comparison_json, content_json, updated_at)
        VALUES (${owner.provider}, ${owner.host}, ${owner.viewerId}, ${owner.repo}, ${owner.number},
          ${draft.version}, ${JSON.stringify(draft.comparison)}, ${JSON.stringify(draft.content)}, ${draft.updatedAt})
        ON CONFLICT(provider_kind, host, viewer_id, repo, number) DO UPDATE SET
          version = excluded.version, comparison_json = excluded.comparison_json,
          content_json = excluded.content_json, updated_at = excluded.updated_at`;
        return { status: "ok", draft } satisfies PrHubReviewDraftResult;
      }),
    );
  });
}
