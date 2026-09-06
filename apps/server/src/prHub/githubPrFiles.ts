import { prComparisonsEqual } from "@t3tools/shared/prReview";
import { Schema, Effect } from "effect";
import {
  PrHubComparisonIdentity,
  type PrHubFilesPage,
  type PrHubChangedFile,
} from "@t3tools/contracts";
import type { GitHubApiResponse } from "../git/githubApi.ts";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";

const Ref = Schema.Struct({
  ref: Schema.String,
  sha: Schema.String,
  repo: Schema.Struct({ full_name: Schema.String }),
});
const Pull = Schema.Struct({ base: Ref, head: Ref, changed_files: Schema.Number });
const Comparison = Schema.Struct({ merge_base_commit: Schema.Struct({ sha: Schema.String }) });
const File = Schema.Struct({
  filename: Schema.String,
  previous_filename: Schema.optional(Schema.String),
  sha: Schema.String,
  status: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  patch: Schema.optional(Schema.String),
});
const Cursor = Schema.Struct({
  account: Schema.String,
  key: Schema.String,
  comparison: PrHubComparisonIdentity,
  page: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 2, maximum: 30 })),
});

function refsIdentity(value: typeof Pull.Type) {
  return {
    baseRepository: value.base.repo.full_name,
    baseRef: value.base.ref,
    baseOid: value.base.sha,
    headRepository: value.head.repo.full_name,
    headRef: value.head.ref,
    headOid: value.head.sha,
  };
}

/** REST supplies hunks without file headers. Preserve paths using Git's quoted format. */
export function normalizeGitHubFile(file: typeof File.Type): PrHubChangedFile {
  const types: Readonly<Record<string, PrHubChangedFile["changeType"]>> = {
    added: "added",
    removed: "deleted",
    modified: "changed",
    renamed: "renamed",
    copied: "copied",
    changed: "changed",
  };
  const changeType = types[file.status] ?? "unknown";
  const previousPath = file.previous_filename ?? null;
  const oldPath = JSON.stringify(`a/${previousPath ?? file.filename}`);
  const newPath = JSON.stringify(`b/${file.filename}`);
  const lines = file.patch?.split("\n") ?? [];
  const complete =
    lines.filter((line) => line.startsWith("+")).length === file.additions &&
    lines.filter((line) => line.startsWith("-")).length === file.deletions;
  const patch = file.patch
    ? `diff --git ${oldPath} ${newPath}\n--- ${changeType === "added" ? "/dev/null" : oldPath}\n+++ ${changeType === "deleted" ? "/dev/null" : newPath}\n${file.patch}\n`
    : null;
  return {
    path: file.filename,
    previousPath,
    blobOid: file.sha || null,
    additions: file.additions,
    deletions: file.deletions,
    changeType,
    patch,
    patchStatus: patch ? (complete ? "available" : "truncated") : "unavailable",
  };
}

/** A page is accepted only while both refs and the target repository stay unchanged. */
export function fetchGitHubPrFiles(input: {
  readonly account: string;
  readonly key: string;
  readonly repository: string;
  readonly number: number;
  readonly host: string;
  readonly cursor?: string;
  readonly reviewedHeadOid?: string;
  readonly request: (
    endpoint: string,
    query?: Readonly<Record<string, string | number | boolean>>,
  ) => Effect.Effect<GitHubApiResponse, SourceControlProviderError>;
}): Effect.Effect<PrHubFilesPage, SourceControlProviderError> {
  const fail = (detail: string) =>
    new SourceControlProviderError({
      provider: "github",
      host: input.host,
      operation: "prHub.getFiles",
      kind: "invalid_response",
      detail,
    });
  const decode = <A>(read: () => A) =>
    Effect.try({
      try: read,
      catch: (error) =>
        fail(error instanceof Error ? error.message : "Invalid GitHub file response."),
    });
  const request = (endpoint: string, query?: Readonly<Record<string, string | number | boolean>>) =>
    input
      .request(endpoint, query)
      .pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(fail(`GitHub returned HTTP ${response.status} while reading files.`)),
        ),
      );
  return Effect.gen(function* () {
    const cursor = input.cursor
      ? yield* decode(() =>
          Schema.decodeUnknownSync(Cursor)(
            JSON.parse(Buffer.from(input.cursor!, "base64url").toString("utf8")),
          ),
        )
      : null;
    if (cursor && (cursor.account !== input.account || cursor.key !== input.key))
      return yield* fail("The file cursor belongs to a different account or PR. Reload the files.");
    const prefix = `repos/${input.repository.split("/").map(encodeURIComponent).join("/")}`;
    const pullEndpoint = `${prefix}/pulls/${input.number}`;
    const beforeResponse = yield* request(pullEndpoint);
    const before = yield* decode(() => Schema.decodeUnknownSync(Pull)(beforeResponse.body));
    const refs = refsIdentity(before);
    const compareResponse = yield* request(
      `${prefix}/compare/${encodeURIComponent(input.reviewedHeadOid ?? before.base.sha)}...${encodeURIComponent(before.head.sha)}`,
      { per_page: 1 },
    );
    const compare = yield* decode(() => Schema.decodeUnknownSync(Comparison)(compareResponse.body));
    const comparison: PrHubComparisonIdentity = {
      ...refs,
      mergeBaseOid: compare.merge_base_commit.sha,
      mode: input.reviewedHeadOid ? "changes_since_review" : "current_pr",
      ...(input.reviewedHeadOid ? { reviewedHeadOid: input.reviewedHeadOid } : {}),
    };
    if (cursor && !prComparisonsEqual(cursor.comparison, comparison))
      return yield* fail("The PR comparison changed. Reload the files before continuing.");
    const page = cursor?.page ?? 1;
    const response = input.reviewedHeadOid
      ? compareResponse
      : yield* request(`${pullEndpoint}/files`, { per_page: 100, page });
    const files = yield* decode(() =>
      Schema.decodeUnknownSync(Schema.Array(File))(
        input.reviewedHeadOid
          ? Schema.decodeUnknownSync(Schema.Struct({ files: Schema.Array(File) }))(response.body)
              .files
          : response.body,
      ),
    );
    if (files.length > (input.reviewedHeadOid ? 300 : 100))
      return yield* fail("GitHub returned an oversized file page.");
    const afterResponse = yield* request(pullEndpoint);
    const after = yield* decode(() => Schema.decodeUnknownSync(Pull)(afterResponse.body));
    if (JSON.stringify(refs) !== JSON.stringify(refsIdentity(after)))
      return yield* fail(
        "The PR changed while loading files. Reload to inspect its current comparison.",
      );
    const providerCapped = input.reviewedHeadOid
      ? files.length >= 300
      : before.changed_files > 3000;
    const hasNextPage = !input.reviewedHeadOid && page < 30 && Boolean(response.links.next);
    return {
      files: files.map(normalizeGitHubFile),
      comparison,
      providerCapped,
      pageInfo: {
        hasNextPage,
        truncated: providerCapped,
        rateLimit: response.rateLimit,
        endCursor: hasNextPage
          ? Buffer.from(
              JSON.stringify({
                account: input.account,
                key: input.key,
                comparison,
                page: page + 1,
              }),
            ).toString("base64url")
          : null,
      },
      stale: false,
      refreshedAt: new Date().toISOString(),
      ...(input.reviewedHeadOid
        ? {
            warning:
              "Changes since your review are read-only. Switch to the current PR diff to comment." +
              (providerCapped
                ? " GitHub exposes at most 300 files in a commit comparison; additional files may be missing."
                : ""),
          }
        : providerCapped
          ? {
              warning:
                "GitHub exposes at most 3,000 files for this PR. Additional files are not shown.",
            }
          : {}),
    };
  });
}
