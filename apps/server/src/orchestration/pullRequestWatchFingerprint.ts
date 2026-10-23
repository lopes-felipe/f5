import { createHash } from "node:crypto";
import type { SourceControlPullRequestRef } from "@t3tools/contracts";
import { Effect } from "effect";
import type { GitHubCliShape } from "../git/Services/GitHubCli.ts";
import { GitHubCredentialScope } from "../git/githubApi.ts";
import { GitHubCliError } from "../git/Errors.ts";

/** Aggregate check counts detect failures while another job remains in flight. */
export const PR_WATCH_FINGERPRINT_QUERY = `query F5PrWatchFingerprint($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){pullRequest(number:$number){
    state mergeable headRefOid
    comments(first:100,orderBy:{field:UPDATED_AT,direction:DESC}){totalCount nodes{lastEditedAt}}
    reviews(last:100){totalCount nodes{lastEditedAt}}
    reviewThreads{totalCount}
    commits(last:1){nodes{commit{statusCheckRollup{contexts{
      checkRunCountsByState{state count} statusContextCountsByState{state count}
    }}}}}
  }} rateLimit{cost remaining resetAt}
}`;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface PullRequestWatchFingerprint {
  readonly status: string;
  readonly remarks: string;
}

export function decodeWatchFingerprint(
  value: unknown,
  etag: string | null,
): PullRequestWatchFingerprint {
  const root = record(value);
  const pr = record(record(record(root.data).repository).pullRequest);
  if (
    array(root.errors).length ||
    typeof pr.headRefOid !== "string" ||
    typeof pr.state !== "string"
  )
    throw new Error("Incomplete watch fingerprint");
  const latest = record(array(record(pr.commits).nodes)[0]);
  const contexts = record(record(record(latest.commit).statusCheckRollup).contexts);
  const counts = (value: unknown) =>
    array(value)
      .map(record)
      .map((entry) => [entry.state, entry.count])
      .sort(([left], [right]) => String(left).localeCompare(String(right)));
  const edits = (value: unknown) => {
    const connection = record(value);
    return [
      connection.totalCount,
      array(connection.nodes)
        .map((node) => record(node).lastEditedAt)
        .filter((value) => typeof value === "string")
        .sort()
        .at(-1) ?? null,
    ];
  };
  return {
    status: hash([
      pr.state,
      pr.mergeable,
      pr.headRefOid,
      counts(contexts.checkRunCountsByState),
      counts(contexts.statusContextCountsByState),
    ]),
    remarks: hash([
      etag,
      edits(pr.comments),
      edits(pr.reviews),
      record(pr.reviewThreads).totalCount,
    ]),
  };
}

export function readGitHubWatchFingerprint(
  github: GitHubCliShape,
  ref: SourceControlPullRequestRef,
  cwd: string,
) {
  return Effect.gen(function* () {
    const context = yield* github.getCredentialContext({ cwd, host: ref.host });
    const pr = yield* github.request({
      cwd,
      context,
      method: "GET",
      endpoint: `repos/${ref.repository.split("/").map(encodeURIComponent).join("/")}/pulls/${ref.number}`,
      cache: { identity: "pr-watch", validate: (body) => record(body).number === ref.number },
    });
    if (pr.status !== 200)
      return yield* new GitHubCliError({
        operation: "watch.fingerprint",
        kind: "generic",
        detail: "GitHub refused the watch fingerprint.",
      });
    const [owner, name] = ref.repository.split("/");
    const result = yield* github
      .runGraphql({
        cwd,
        host: ref.host,
        query: PR_WATCH_FINGERPRINT_QUERY,
        variables: { owner: owner!, name: name!, number: ref.number },
      })
      .pipe(Effect.provideService(GitHubCredentialScope, context));
    return yield* Effect.try({
      try: () => decodeWatchFingerprint(result, pr.etag),
      catch: () =>
        new GitHubCliError({
          operation: "watch.fingerprint",
          kind: "invalid_json",
          detail: "GitHub returned an incomplete watch fingerprint.",
        }),
    });
  });
}
