import { Effect, Exit, Schema } from "effect";
import type { GitHubApiResponse } from "../git/githubApi.ts";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";
import {
  readReviewOperation,
  transitionReviewOperation,
  type ReviewOperation,
} from "./reviewOperations.ts";
import type { PrHubDraftOwner } from "./reviewDrafts.ts";

const RemoteReview = Schema.Struct({
  id: Schema.Number.check(Schema.isInt()),
  user: Schema.Struct({ id: Schema.Number.check(Schema.isInt()) }),
  body: Schema.String,
  state: Schema.String,
  commit_id: Schema.NullOr(Schema.String),
});
type RemoteReview = typeof RemoteReview.Type;
export interface ReviewSubmissionDependencies {
  readonly request: (
    method: "GET" | "POST",
    endpoint: string,
    body?: unknown,
    query?: Readonly<Record<string, string | number | boolean>>,
  ) => Effect.Effect<GitHubApiResponse, SourceControlProviderError>;
  /** Recheck the captured account, lifecycle, permissions, comparison and anchors before each write. */
  readonly verify: (operation: ReviewOperation) => Effect.Effect<void, SourceControlProviderError>;
}
function failure(detail: string) {
  return new SourceControlProviderError({
    provider: "github",
    operation: "prHub.submitReview",
    kind: "generic",
    detail,
  });
}
const endpoint = (owner: PrHubDraftOwner) =>
  `repos/${owner.repo.split("/").map(encodeURIComponent).join("/")}/pulls/${owner.number}/reviews`;
const matches = (review: RemoteReview, owner: PrHubDraftOwner, operation: ReviewOperation) =>
  String(review.user.id) === owner.viewerId &&
  review.body.includes(`<!-- F5 review ${operation.correlationNonce} -->`) &&
  review.commit_id === operation.payload.draft.comparison.headOid &&
  (operation.remoteId === null || String(review.id) === operation.remoteId);
const submitted = (review: RemoteReview, operation: ReviewOperation) =>
  review.state ===
  ({ APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" } as const)[
    operation.payload.event
  ];

function reviews(
  owner: PrHubDraftOwner,
  dependencies: ReviewSubmissionDependencies,
  operation?: ReviewOperation,
) {
  return Effect.gen(function* () {
    const result: RemoteReview[] = [];
    for (let page = 1; page <= 20; page++) {
      const response = yield* dependencies.request("GET", endpoint(owner), undefined, {
        per_page: 100,
        page,
      });
      if (response.status !== 200)
        return yield* failure("GitHub reviews could not be verified. No write was attempted.");
      const items = yield* Schema.decodeUnknownEffect(Schema.Array(RemoteReview))(
        response.body,
      ).pipe(Effect.mapError(() => failure("GitHub returned incomplete review data.")));
      result.push(
        ...items.filter(
          (item) =>
            String(item.user.id) === owner.viewerId &&
            (item.state === "PENDING" || (operation && matches(item, owner, operation))),
        ),
      );
      if (result.length > 20)
        return yield* failure("Too many matching reviews to reconcile safely.");
      if (!response.links.next) return result;
    }
    return yield* failure(
      "Review pagination exceeded the verification budget. No write was attempted.",
    );
  });
}

function acceptReviewResult(
  owner: PrHubDraftOwner,
  operation: ReviewOperation,
  remote: RemoteReview,
) {
  return Effect.gen(function* () {
    if (operation.status !== "outcome_unknown")
      yield* transitionReviewOperation(owner, {
        id: operation.id,
        from: operation.status,
        to: "outcome_unknown",
      });
    yield* transitionReviewOperation(owner, {
      id: operation.id,
      from: "outcome_unknown",
      to: "succeeded",
      remoteId: String(remote.id),
    });
  });
}

/** A user-supplied remote ID is accepted only with the same exact correlation evidence. */
export function linkReviewSubmission(
  owner: PrHubDraftOwner,
  id: string,
  remoteId: string,
  dependencies: ReviewSubmissionDependencies,
) {
  return Effect.gen(function* () {
    const operation = yield* readReviewOperation(owner, id);
    if (
      !operation ||
      !["creating", "created", "submitting", "outcome_unknown"].includes(operation.status)
    )
      return yield* failure("This review does not require result recovery.");
    if (!/^[0-9]+$/.test(remoteId)) return yield* failure("Enter a numeric GitHub review ID.");
    const response = yield* dependencies.request("GET", `${endpoint(owner)}/${remoteId}`);
    if (response.status !== 200) return yield* failure("The linked review could not be verified.");
    const remote = yield* Schema.decodeUnknownEffect(RemoteReview)(response.body).pipe(
      Effect.mapError(() => failure("GitHub returned incomplete review data.")),
    );
    if (
      String(remote.id) !== remoteId ||
      !matches(remote, owner, operation) ||
      !submitted(remote, operation)
    )
      return yield* failure(
        "The linked review does not match this account, PR, revision, outcome and F5 marker.",
      );
    yield* acceptReviewResult(owner, operation, remote);
    return (yield* readReviewOperation(owner, id))!;
  });
}

/** Reads only: an absent marker is never evidence that a previous write failed. */
export function reconcileReviewSubmission(
  owner: PrHubDraftOwner,
  id: string,
  dependencies: ReviewSubmissionDependencies,
) {
  return Effect.gen(function* () {
    const operation = yield* readReviewOperation(owner, id);
    if (!operation) return yield* failure("Review operation not found for this account and PR.");
    if (!["creating", "created", "submitting", "outcome_unknown"].includes(operation.status))
      return operation;
    const candidates = (yield* reviews(owner, dependencies, operation)).filter((item) =>
      matches(item, owner, operation),
    );
    if (candidates.length === 1 && submitted(candidates[0]!, operation))
      yield* acceptReviewResult(owner, operation, candidates[0]!);
    return (yield* readReviewOperation(owner, id))!;
  });
}

/** Each stage is claimed durably before sending. Re-entering an uncertain stage reads only. */
export function submitPreparedReview(
  owner: PrHubDraftOwner,
  id: string,
  dependencies: ReviewSubmissionDependencies,
) {
  return Effect.gen(function* () {
    let operation = yield* readReviewOperation(owner, id);
    if (!operation) return yield* failure("Review operation not found for this account and PR.");
    if (["creating", "submitting", "outcome_unknown"].includes(operation.status))
      return yield* reconcileReviewSubmission(owner, id, dependencies);
    if (operation.status !== "prepared" && operation.status !== "created") return operation;
    if (operation.status === "prepared") {
      // These reads happen before claiming a send, so failures leave the preview editable by cancelling it.
      yield* dependencies.verify(operation);
      if (
        (yield* reviews(owner, dependencies)).some(
          (review) => String(review.user.id) === owner.viewerId && review.state === "PENDING",
        )
      )
        return yield* failure(
          "You already have a pending review on GitHub. Finish it there before submitting this draft.",
        );
      yield* dependencies.verify(operation);
      const claimed = yield* transitionReviewOperation(owner, {
        id,
        from: "prepared",
        to: "creating",
      });
      if (!claimed) return (yield* readReviewOperation(owner, id))!;
      const { draft, body } = operation.payload;
      const creation = yield* Effect.exit(
        dependencies.request("POST", endpoint(owner), {
          commit_id: draft.comparison.headOid,
          body,
          comments: draft.content.comments.map((comment) => ({
            path: comment.path,
            side: comment.side,
            line: comment.line,
            body: comment.body,
            ...(comment.startLine === undefined
              ? {}
              : { start_line: comment.startLine, start_side: comment.startSide }),
          })),
        }),
      );
      if (Exit.isFailure(creation)) {
        yield* transitionReviewOperation(owner, { id, from: "creating", to: "outcome_unknown" });
        return (yield* readReviewOperation(owner, id))!;
      }
      if ([400, 401, 403, 404, 422].includes(creation.value.status)) {
        yield* transitionReviewOperation(owner, { id, from: "creating", to: "rejected" });
        return (yield* readReviewOperation(owner, id))!;
      }
      const remote = yield* Effect.exit(
        Schema.decodeUnknownEffect(RemoteReview)(creation.value.body),
      );
      if (
        creation.value.status < 200 ||
        creation.value.status >= 300 ||
        Exit.isFailure(remote) ||
        !matches(remote.value, owner, operation) ||
        remote.value.state !== "PENDING"
      ) {
        yield* transitionReviewOperation(owner, { id, from: "creating", to: "outcome_unknown" });
        return (yield* readReviewOperation(owner, id))!;
      }
      yield* transitionReviewOperation(owner, {
        id,
        from: "creating",
        to: "created",
        remoteId: String(remote.value.id),
      });
      operation = (yield* readReviewOperation(owner, id))!;
    }
    const verified = yield* Effect.exit(
      Effect.gen(function* () {
        yield* dependencies.verify(operation);
        const pending = yield* dependencies.request(
          "GET",
          `${endpoint(owner)}/${operation.remoteId}`,
        );
        const remote = yield* Schema.decodeUnknownEffect(RemoteReview)(pending.body);
        if (
          pending.status !== 200 ||
          !matches(remote, owner, operation) ||
          remote.state !== "PENDING" ||
          remote.body !== operation.payload.body
        )
          return yield* failure(
            "The pending GitHub review changed. Inspect it on GitHub before continuing.",
          );
        const comments = yield* dependencies.request(
          "GET",
          `${endpoint(owner)}/${operation.remoteId}/comments`,
          undefined,
          { per_page: 100 },
        );
        const rows = yield* Schema.decodeUnknownEffect(
          Schema.Array(
            Schema.Struct({
              body: Schema.String,
              path: Schema.String,
              line: Schema.Number,
              side: Schema.String,
              start_line: Schema.optional(Schema.NullOr(Schema.Number)),
              start_side: Schema.optional(Schema.NullOr(Schema.String)),
              user: Schema.Struct({ id: Schema.Number }),
              commit_id: Schema.String,
            }),
          ),
        )(comments.body);
        const actual = rows
          .map((comment) =>
            JSON.stringify([
              comment.path,
              comment.body,
              comment.side,
              comment.line,
              comment.start_side ?? null,
              comment.start_line ?? null,
            ]),
          )
          .sort();
        const expected = operation.payload.draft.content.comments
          .map((comment) =>
            JSON.stringify([
              comment.path,
              comment.body,
              comment.side,
              comment.line,
              comment.startSide ?? null,
              comment.startLine ?? null,
            ]),
          )
          .sort();
        if (
          comments.status !== 200 ||
          comments.links.next ||
          rows.some(
            (comment) =>
              String(comment.user.id) !== owner.viewerId ||
              comment.commit_id !== operation.payload.draft.comparison.headOid,
          ) ||
          JSON.stringify(actual) !== JSON.stringify(expected)
        )
          return yield* failure(
            "The pending inline comments changed. Inspect them on GitHub before continuing.",
          );
      }),
    );
    if (Exit.isFailure(verified)) {
      yield* transitionReviewOperation(owner, { id, from: "created", to: "outcome_unknown" });
      return (yield* readReviewOperation(owner, id))!;
    }
    if (!(yield* transitionReviewOperation(owner, { id, from: "created", to: "submitting" })))
      return (yield* readReviewOperation(owner, id))!;
    const result = yield* Effect.exit(
      dependencies.request("POST", `${endpoint(owner)}/${operation.remoteId}/events`, {
        event: operation.payload.event,
        body: operation.payload.body,
      }),
    );
    const remote =
      Exit.isSuccess(result) && result.value.status === 200
        ? yield* Effect.exit(Schema.decodeUnknownEffect(RemoteReview)(result.value.body))
        : null;
    const confirmed =
      remote &&
      Exit.isSuccess(remote) &&
      matches(remote.value, owner, operation) &&
      submitted(remote.value, operation);
    yield* transitionReviewOperation(owner, {
      id,
      from: "submitting",
      to: confirmed ? "succeeded" : "outcome_unknown",
    });
    return (yield* readReviewOperation(owner, id))!;
  }).pipe(Effect.uninterruptible);
}
