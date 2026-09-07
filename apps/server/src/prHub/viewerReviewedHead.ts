import { Effect, Schema } from "effect";
import type { GitHubApiResponse } from "../git/githubApi.ts";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";
import { viewerLatestReview } from "./discoveryModel.ts";

const Reviews = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    user: Schema.NullOr(Schema.Struct({ id: Schema.Number })),
    state: Schema.String,
    commit_id: Schema.NullOr(Schema.String),
  }),
);

/** Traverse the viewer's complete review history; never interpret a capped page as absence. */
export function readViewerReviewedHead(
  viewerId: number,
  read: (page: number) => Effect.Effect<GitHubApiResponse, SourceControlProviderError>,
) {
  const fail = () =>
    new SourceControlProviderError({
      provider: "github",
      operation: "prHub.reviewedHead",
      kind: "invalid_response",
      detail: "Review history could not be completely verified. Retry changes since review.",
    });
  return Effect.gen(function* () {
    let oid: string | null = null;
    const seen = new Set<number>();
    for (let page = 1; page <= 30; page++) {
      const response = yield* read(page);
      if (response.status !== 200 || !Schema.is(Reviews)(response.body)) return yield* fail();
      for (const review of response.body) {
        if (seen.has(review.id)) return yield* fail();
        seen.add(review.id);
      }
      const latest = viewerLatestReview(
        {
          latestReviews: {
            nodes: response.body.map((review) => ({
              author: { login: review.user?.id === viewerId ? "viewer" : "other" },
              state: review.state,
              commit: { oid: review.commit_id },
            })),
          },
        },
        "viewer",
      );
      if (latest) oid = (latest.commit as { oid: string | null }).oid;
      if (!response.links.next) return oid;
      if (response.body.length === 0) return yield* fail();
    }
    return yield* fail();
  });
}
