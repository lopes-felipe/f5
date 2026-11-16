import { Effect, Option } from "effect";
import type { GitHubCliShape } from "./Services/GitHubCli.ts";
import { GitHubCredentialScope, type GitHubCredentialContext } from "./githubApi.ts";
import { GitHubRequestPolicy } from "./githubRequestPolicy.ts";
import { GitHubCliError } from "./Errors.ts";
import { parseGitHubPullRequestUrl } from "@t3tools/shared/sourceControl";

export interface GitHubBranchDeletionInput {
  readonly cwd: string;
  readonly url: string;
  readonly expectedHeadOid: string;
  readonly inspectOnly?: boolean;
}
export interface PullRequestBranchDeletionResult {
  readonly host: string;
  readonly repository: string;
  readonly branch: string;
  readonly headOid: string;
  readonly absent: boolean;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const refused = (detail: string) =>
  new GitHubCliError({
    operation: "deletePullRequestBranch",
    kind: "forbidden",
    detail,
    requestDispatched: false,
  });
const PR_QUERY = `query F5BranchToDelete($owner:String!,$name:String!,$number:Int!) {
  repository(owner:$owner,name:$name) { pullRequest(number:$number) {
    state headRefName baseRefName headRefOid headRepository { id nameWithOwner }
  } }
}`;
const SOURCE_QUERY = `query F5SourceBranch($id:ID!,$ref:String!) {
  node(id:$id) { ... on Repository { id nameWithOwner isArchived viewerPermission defaultBranchRef { name } ref(qualifiedName:$ref) { target { oid } } } }
}`;
/** Owns the selected account across both reads and the atomic remote compare-and-delete. */
export function deleteGitHubPullRequestBranch(
  api: Pick<GitHubCliShape, "request" | "getCredentialContext">,
  input: GitHubBranchDeletionInput,
) {
  return Effect.gen(function* () {
    const host = yield* Effect.try({
      try: () => new URL(input.url).hostname,
      catch: () => refused("Invalid pull request URL."),
    });
    const ref = parseGitHubPullRequestUrl(input.url, host);
    if (
      !ref ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.expectedHeadOid) ||
      /^0+$/.test(input.expectedHeadOid)
    )
      return yield* refused("A complete prepared PR head is required before deleting its branch.");
    const captured = yield* Effect.serviceOption(GitHubCredentialScope);
    const context: GitHubCredentialContext = Option.isSome(captured)
      ? captured.value
      : yield* api.getCredentialContext({ cwd: input.cwd, host: ref.host });
    if (context.host !== ref.host)
      return yield* refused("The branch belongs to a different forge account host.");
    const parent = yield* Effect.serviceOption(GitHubRequestPolicy);
    const request = (query: string, variables: unknown) =>
      api
        .request({
          cwd: input.cwd,
          context,
          method: "POST",
          endpoint: "graphql",
          body: { query, variables },
        })
        .pipe(
          Effect.flatMap((response) => {
            const body = object(response.body);
            return response.status >= 400 ||
              (Array.isArray(body.errors) && body.errors.length) ||
              !body.data
              ? Effect.fail(
                  new GitHubCliError({
                    operation: "deletePullRequestBranch",
                    kind: "invalid_json",
                    detail: "GitHub did not confirm the branch request.",
                    requestDispatched: query.startsWith("mutation"),
                  }),
                )
              : Effect.succeed(object(body.data));
          }),
        );
    const read = Effect.gen(function* () {
      const [owner, name] = ref.repository.split("/");
      const data = yield* request(PR_QUERY, { owner, name, number: ref.number });
      const pr = object(object(data.repository).pullRequest),
        head = object(pr.headRepository);
      if (!["CLOSED", "MERGED"].includes(String(pr.state)))
        return yield* refused("Close or merge the PR before deleting its source branch.");
      if (pr.headRefOid !== input.expectedHeadOid)
        return yield* refused("The PR head changed; its branch was kept.");
      if (
        typeof pr.headRefName !== "string" ||
        !pr.headRefName ||
        pr.headRefName === pr.baseRefName ||
        typeof head.id !== "string" ||
        !head.id ||
        typeof head.nameWithOwner !== "string" ||
        !/^[^/]+\/[^/]+$/.test(head.nameWithOwner)
      )
        return yield* refused("The source branch is incomplete, or is the PR base branch.");
      const stack = yield* api.request({
        cwd: input.cwd,
        context,
        method: "GET",
        endpoint: `repos/${ref.repository}/stacks`,
        query: { pull_request: ref.number },
      });
      if (
        stack.status !== 404 &&
        stack.status !== 422 &&
        (stack.status !== 200 || !Array.isArray(stack.body) || stack.body.length !== 0)
      )
        return yield* refused(
          "Branch deletion is unavailable for a stack or an unverified stack response.",
        );
      const source = object(
        (yield* request(SOURCE_QUERY, { id: head.id, ref: `refs/heads/${pr.headRefName}` })).node,
      );
      if (
        source.id !== head.id ||
        source.nameWithOwner !== head.nameWithOwner ||
        source.isArchived !== false ||
        !["WRITE", "MAINTAIN", "ADMIN"].includes(String(source.viewerPermission)) ||
        typeof object(source.defaultBranchRef).name !== "string" ||
        pr.headRefName === object(source.defaultBranchRef).name
      )
        return yield* refused(
          "The source repository is not writable, or this is its default branch.",
        );
      const branch = source.ref;
      if (branch !== null && object(object(branch).target).oid !== input.expectedHeadOid)
        return yield* refused(
          "The source branch has new commits or could not be verified; it was kept.",
        );
      return {
        host: ref.host,
        repository: head.nameWithOwner,
        repositoryId: head.id,
        branch: pr.headRefName,
        headOid: input.expectedHeadOid,
        absent: branch === null,
      };
    });
    // A post-merge branch mutation intentionally requires CLOSED/MERGED rather than OPEN.
    // Keep the parent's account/exclusion/read-invalidated guards and apply our own write checks.
    let expectedSource: { repositoryId: string; branch: string; headOid: string } | undefined;
    const scoped = <A, E>(work: Effect.Effect<A, E>) =>
      work.pipe(
        Effect.provideService(GitHubRequestPolicy, {
          beforeSend: (write) =>
            Effect.gen(function* () {
              if (Option.isSome(parent)) yield* parent.value.beforeSend(false);
              if (write) {
                const fresh = yield* read;
                if (
                  !expectedSource ||
                  fresh.repositoryId !== expectedSource.repositoryId ||
                  fresh.branch !== expectedSource.branch ||
                  fresh.headOid !== expectedSource.headOid ||
                  fresh.absent
                )
                  return yield* refused(
                    "The source branch changed while deletion was queued. Refresh before continuing.",
                  );
              }
            }),
          readInvalidated: Option.isSome(parent) ? parent.value.readInvalidated : Effect.never,
        }),
      );
    return yield* scoped(
      Effect.gen(function* () {
        const source = yield* read;
        expectedSource = source;
        if (source.absent || input.inspectOnly) return source;
        const data = yield* request(
          "mutation F5DeleteSourceBranch($input:UpdateRefsInput!){updateRefs(input:$input){clientMutationId}}",
          {
            input: {
              repositoryId: source.repositoryId,
              refUpdates: [
                {
                  name: `refs/heads/${source.branch}`,
                  beforeOid: source.headOid,
                  afterOid: "0".repeat(source.headOid.length),
                },
              ],
            },
          },
        );
        if (!Object.hasOwn(object(data.updateRefs), "clientMutationId"))
          return yield* new GitHubCliError({
            operation: "deletePullRequestBranch",
            kind: "invalid_json",
            detail: "The branch deletion outcome is unconfirmed.",
            requestDispatched: true,
          });
        return { ...source, absent: true };
      }),
    );
  });
}
