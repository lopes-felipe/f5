import { Effect, Option, Schema } from "effect";
import type { PrHubChangeBreakdown } from "@t3tools/contracts";
import { classifyChangedFile } from "@t3tools/shared/changedFileKind";
import type { GitHubApiResponse } from "../git/githubApi";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider";

export const PR_FILE_STATS_QUERY = `query PrFileStats($owner:String!, $repo:String!, $number:Int!, $cursor:String) {
  repository(owner:$owner, name:$repo) { pullRequest(number:$number) {
    headRefOid baseRefOid changedFiles
    files(first:100, after:$cursor) { nodes { path additions deletions }
      pageInfo { hasNextPage endCursor } }
  } }
}`;
const Page = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      pullRequest: Schema.Struct({
        headRefOid: Schema.String,
        baseRefOid: Schema.String,
        changedFiles: Schema.Number,
        files: Schema.Struct({
          nodes: Schema.Array(
            Schema.Struct({
              path: Schema.String,
              additions: Schema.Number,
              deletions: Schema.Number,
            }),
          ),
          pageInfo: Schema.Struct({
            hasNextPage: Schema.Boolean,
            endCursor: Schema.NullOr(Schema.String),
          }),
        }),
      }),
    }),
  }),
});
export function gitHubStatsComparison(response: GitHubApiResponse): string | null {
  if (response.graphqlErrors.length) return null;
  const page = Schema.decodeUnknownOption(Page)(response.body);
  if (Option.isNone(page)) return null;
  const pr = page.value.data.repository.pullRequest;
  return JSON.stringify([pr.headRefOid, pr.baseRefOid, pr.changedFiles]);
}

/** One stats-only GraphQL read per page; refuse moving refs, duplicates and provider caps. */
export function readGitHubFileStats(
  read: (cursor: string | null) => Effect.Effect<GitHubApiResponse, SourceControlProviderError>,
): Effect.Effect<PrHubChangeBreakdown | null, SourceControlProviderError> {
  return Effect.gen(function* () {
    const totals: Record<keyof PrHubChangeBreakdown, { additions: number; deletions: number }> = {
      code: { additions: 0, deletions: 0 },
      tests: { additions: 0, deletions: 0 },
      mocks: { additions: 0, deletions: 0 },
      generated: { additions: 0, deletions: 0 },
      docs: { additions: 0, deletions: 0 },
    };
    const paths = new Set<string>(),
      cursors = new Set<string>();
    let cursor: string | null = null,
      comparison: string | undefined;
    for (let index = 0; index < 30; index++) {
      const response: GitHubApiResponse = yield* read(cursor);
      if (response.graphqlErrors.length) return null;
      const decoded: (typeof Page.Type)["data"]["repository"]["pullRequest"] = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(Page)(response.body).data.repository.pullRequest,
        catch: () =>
          new SourceControlProviderError({
            provider: "github",
            operation: "prHub.getChangeBreakdown",
            kind: "invalid_response",
            detail: "GitHub returned invalid file statistics.",
          }),
      });
      const revision = JSON.stringify([
        decoded.headRefOid,
        decoded.baseRefOid,
        decoded.changedFiles,
      ]);
      if (comparison !== undefined && comparison !== revision) return null;
      comparison = revision;
      for (const file of decoded.files.nodes) {
        if (paths.has(file.path) || file.additions < 0 || file.deletions < 0) return null;
        paths.add(file.path);
        const bucket = totals[classifyChangedFile(file.path)];
        bucket.additions += file.additions;
        bucket.deletions += file.deletions;
      }
      if (!decoded.files.pageInfo.hasNextPage)
        return paths.size === decoded.changedFiles ? totals : null;
      cursor = decoded.files.pageInfo.endCursor;
      if (!cursor || cursors.has(cursor)) return null;
      cursors.add(cursor);
    }
    return null;
  });
}
