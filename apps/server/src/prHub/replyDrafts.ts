import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { PrHubReplyDraft, PrHubSaveReplyDraftInput } from "@t3tools/contracts";
import type { PrHubDraftOwner } from "./reviewDrafts.ts";

export function readReplyDraft(owner: PrHubDraftOwner, threadId: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      version: number;
      body: string;
      comparison_version: string;
      updated_at: string;
    }>`
      SELECT version, body, comparison_version, updated_at FROM pr_hub_reply_drafts
      WHERE provider_kind = ${owner.provider} AND host = ${owner.host} AND viewer_id = ${owner.viewerId}
        AND repo = ${owner.repo} AND number = ${owner.number} AND thread_id = ${threadId}`;
    const row = rows[0];
    return row
      ? ({
          version: row.version,
          body: row.body,
          comparisonVersion: row.comparison_version,
          updatedAt: row.updated_at,
        } satisfies PrHubReplyDraft)
      : null;
  });
}

export function saveReplyDraft(owner: PrHubDraftOwner, input: PrHubSaveReplyDraftInput) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* readReplyDraft(owner, input.threadId);
        if ((current?.version ?? 0) !== input.expectedVersion)
          return { status: "version_conflict" as const, draft: current };
        const draft = {
          version: input.expectedVersion + 1,
          body: input.body,
          comparisonVersion: input.comparisonVersion,
          updatedAt: new Date().toISOString(),
        };
        yield* sql`INSERT INTO pr_hub_reply_drafts(provider_kind, host, viewer_id, repo, number, thread_id, version, body, comparison_version, updated_at)
        VALUES (${owner.provider}, ${owner.host}, ${owner.viewerId}, ${owner.repo}, ${owner.number}, ${input.threadId}, ${draft.version}, ${draft.body}, ${draft.comparisonVersion}, ${draft.updatedAt})
        ON CONFLICT(provider_kind, host, viewer_id, repo, number, thread_id) DO UPDATE SET
          version = excluded.version, body = excluded.body, comparison_version = excluded.comparison_version, updated_at = excluded.updated_at`;
        return { status: "saved" as const, draft };
      }),
    );
  });
}
