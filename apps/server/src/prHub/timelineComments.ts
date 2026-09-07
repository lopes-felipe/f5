import { createHash, randomUUID } from "node:crypto";
import { Effect, Exit, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { PrHubCommentOperation } from "@t3tools/contracts";
import type { PrHubDraftOwner } from "./reviewDrafts.ts";
import type { ReviewSubmissionDependencies } from "./submitReview.ts";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";

const fail = (detail: string) =>
  new SourceControlProviderError({
    provider: "github",
    operation: "prHub.commentOperation",
    kind: "generic",
    detail,
  });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const endpoint = (owner: PrHubDraftOwner) =>
  `repos/${owner.repo.split("/").map(encodeURIComponent).join("/")}/issues/${owner.number}/comments`;
const Comment = Schema.Struct({
  id: Schema.Number,
  body: Schema.String,
  user: Schema.Struct({ id: Schema.Number }),
});
type Request = ReviewSubmissionDependencies["request"];
export function readCommentOperation(owner: PrHubDraftOwner, id?: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      operation_id: string;
      status: string;
      payload_hash: string;
      payload_json: string;
      remote_id: string | null;
    }>`SELECT operation_id,status,payload_hash,payload_json,remote_id FROM pr_hub_operations
      WHERE provider_kind=${owner.provider} AND host=${owner.host} AND viewer_id=${owner.viewerId} AND repo=${owner.repo} AND number=${owner.number} AND kind='comment' AND (${id ?? null} IS NULL OR operation_id=${id ?? null})
      ORDER BY CASE WHEN status IN ('prepared','creating','outcome_unknown') THEN 0 ELSE 1 END,created_at DESC LIMIT 1`;
    const row = rows[0];
    if (!row) return null;
    if (hash(row.payload_json) !== row.payload_hash)
      return yield* fail("The saved comment payload failed verification.");
    return yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(PrHubCommentOperation)({
          id: row.operation_id,
          status: row.status,
          payloadHash: row.payload_hash,
          payload: JSON.parse(row.payload_json),
          remoteId: row.remote_id,
        }),
      catch: () => fail("The saved comment operation is invalid."),
    });
  });
}
export function prepareCommentOperation(
  owner: PrHubDraftOwner,
  input: { id: string; body: string },
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const previous = yield* readCommentOperation(owner, input.id);
        if (previous) {
          if (previous.payload.body !== input.body)
            return yield* fail("This operation ID belongs to different comment text.");
          return previous;
        }
        if (!input.body.trim()) return yield* fail("Write a comment before preparing it.");
        const nonce = randomUUID();
        const payload = JSON.stringify({
          version: 2,
          source: "timeline_comment",
          body: input.body,
          markedBody: `${input.body}\n\n<!-- F5 comment ${nonce} -->`,
        });
        const now = new Date().toISOString();
        yield* sql`INSERT INTO pr_hub_operations(provider_kind,host,viewer_id,repo,number,operation_id,kind,status,payload_hash,payload_json,draft_version,correlation_nonce,created_at,updated_at)
        VALUES(${owner.provider},${owner.host},${owner.viewerId},${owner.repo},${owner.number},${input.id},'comment','prepared',${hash(payload)},${payload},NULL,${nonce},${now},${now})`;
        return (yield* readCommentOperation(owner, input.id))!;
      }),
    );
  });
}
function transition(
  owner: PrHubDraftOwner,
  operation: PrHubCommentOperation,
  status: PrHubCommentOperation["status"],
  remoteId?: string,
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      yield* sql`UPDATE pr_hub_operations SET status=${status}, remote_id=COALESCE(${remoteId ?? null},remote_id), updated_at=${new Date().toISOString()}
      WHERE provider_kind=${owner.provider} AND host=${owner.host} AND viewer_id=${owner.viewerId} AND repo=${owner.repo} AND number=${owner.number} AND operation_id=${operation.id} AND kind='comment' AND status=${operation.status} RETURNING operation_id`;
    return rows.length === 1;
  });
}
export function reconcileCommentOperation(owner: PrHubDraftOwner, request: Request, id?: string) {
  return Effect.gen(function* () {
    let operation = yield* readCommentOperation(owner, id);
    if (!operation || !["creating", "outcome_unknown"].includes(operation.status)) return operation;
    // A crash leaves creating behind. Reconciliation can only prove success, never authorize resend.
    if (operation.status === "creating") {
      yield* transition(owner, operation, "outcome_unknown");
      operation = (yield* readCommentOperation(owner, operation.id))!;
    }
    const matches = new Set<string>();
    for (let page = 1; page <= 30; page++) {
      const response = yield* request("GET", endpoint(owner), undefined, { per_page: 100, page });
      if (response.status !== 200) return operation;
      const comments = yield* Schema.decodeUnknownEffect(Schema.Array(Comment))(response.body).pipe(
        Effect.mapError(() =>
          fail("GitHub returned an invalid comment page. The outcome remains unknown."),
        ),
      );
      for (const comment of comments)
        if (
          String(comment.user.id) === owner.viewerId &&
          comment.body === operation.payload.markedBody
        )
          matches.add(String(comment.id));
      if (!response.links.next && comments.length < 100) {
        if (matches.size === 1) yield* transition(owner, operation, "succeeded", [...matches][0]!);
        return (yield* readCommentOperation(owner, operation.id))!;
      }
    }
    return operation;
  });
}
export function submitCommentOperation(
  owner: PrHubDraftOwner,
  input: { id: string; payloadHash: string },
  request: Request,
  verify: Effect.Effect<void, SourceControlProviderError>,
) {
  return Effect.gen(function* () {
    const operation = yield* readCommentOperation(owner, input.id);
    if (!operation || operation.payloadHash !== input.payloadHash)
      return yield* fail("Reload the prepared comment preview before submitting.");
    if (operation.status !== "prepared") return operation;
    yield* verify;
    if (!(yield* transition(owner, operation, "creating")))
      return (yield* readCommentOperation(owner, input.id))!;
    const creating = { ...operation, status: "creating" as const };
    const sent = yield* Effect.exit(
      request("POST", endpoint(owner), { body: operation.payload.markedBody }),
    );
    let status: PrHubCommentOperation["status"] = "outcome_unknown";
    let remoteId: string | undefined;
    if (Exit.isSuccess(sent)) {
      const response = sent.value;
      if (
        response.status === 201 &&
        Schema.is(Comment)(response.body) &&
        String(response.body.user.id) === owner.viewerId &&
        response.body.body === operation.payload.markedBody
      ) {
        status = "succeeded";
        remoteId = String(response.body.id);
      } else if ([400, 401, 403, 404, 410, 422].includes(response.status)) status = "rejected";
    }
    yield* transition(owner, creating, status, remoteId);
    return (yield* readCommentOperation(owner, input.id))!;
  });
}
export function recoverCommentOperation(
  owner: PrHubDraftOwner,
  input: {
    id: string;
    payloadHash: string;
    action: "cancel" | "link" | "abandon";
    remoteId?: string | undefined;
  },
  request: Request,
) {
  return Effect.gen(function* () {
    const operation = yield* readCommentOperation(owner, input.id);
    if (!operation || operation.payloadHash !== input.payloadHash)
      return yield* fail("Reload the saved comment operation.");
    if (input.action === "link") {
      const result = yield* reconcileCommentOperation(owner, request, input.id);
      if (!input.remoteId || result?.status !== "succeeded" || result.remoteId !== input.remoteId)
        return yield* fail(
          "The comment could not be verified against its exact body, marker, numeric actor and PR.",
        );
      return result;
    }
    if (input.action === "cancel" && operation.status === "prepared")
      yield* transition(owner, operation, "failed_before_send");
    else if (
      input.action === "abandon" &&
      ["creating", "outcome_unknown"].includes(operation.status)
    )
      yield* transition(owner, operation, "abandoned");
    else return yield* fail("This comment is not in a recoverable state.");
    return (yield* readCommentOperation(owner, input.id))!;
  });
}
