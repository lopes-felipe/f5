import { Effect } from "effect";
import type { SourceControlPullRequestRef } from "@t3tools/contracts";
import { GitHubCliError } from "../git/Errors.ts";
import { GitHubCredentialScope } from "../git/githubApi.ts";
import type { GitHubCliShape } from "../git/Services/GitHubCli.ts";
import {
  makeGitHubSourceControlProvider,
  mapGitHubCliError,
} from "../sourceControl/GitHubSourceControlProvider.ts";
import {
  GITHUB_FORGE_CAPABILITIES,
  type ForgeProvider,
  type ForgeDetail,
} from "../sourceControl/ForgeSourceControlProvider.ts";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";
import { record, text } from "./forgeModel.ts";

export function makeGitHubForge(github: GitHubCliShape, cwd: string): ForgeProvider {
  const scope = <A>(
    ref: SourceControlPullRequestRef,
    run: (
      context: import("../git/githubApi.ts").GitHubCredentialContext,
    ) => Effect.Effect<A, import("../git/Errors.ts").GitHubCliError>,
  ) =>
    Effect.gen(function* () {
      const context = yield* github.getCredentialContext({ cwd, host: ref.host });
      if (
        ref.provider !== "github" ||
        context.host.toLowerCase() !== ref.host.toLowerCase() ||
        ref.repository.split("/").length !== 2 ||
        ref.repository
          .split("/")
          .some((part) => !part || part === "." || part === ".." || /[\\?#\s]/.test(part))
      )
        return yield* new GitHubCliError({
          operation: "forge.scope",
          kind: "forbidden",
          detail: "GitHub account and repository scope do not match the request.",
        });
      return yield* run(context).pipe(Effect.provideService(GitHubCredentialScope, context));
    }).pipe(Effect.mapError(mapGitHubCliError));
  const failure = (operation: string, detail: string, requestDispatched = false) =>
    new SourceControlProviderError({
      provider: "github",
      operation,
      kind: "invalid_response",
      detail,
      requestDispatched,
    });
  const request = (
    ref: SourceControlPullRequestRef,
    suffix: string,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET",
    body?: unknown,
  ) =>
    scope(ref, (context) =>
      github
        .request({
          cwd,
          context,
          method,
          endpoint: `repos/${ref.repository.split("/").map(encodeURIComponent).join("/")}${suffix}`,
          ...(body === undefined ? {} : { body }),
        })
        .pipe(
          Effect.flatMap((r) =>
            r.status >= 200 && r.status < 300
              ? Effect.succeed(r.body)
              : Effect.fail(
                  new GitHubCliError({
                    operation: "forge.request",
                    kind:
                      r.status === 404 ? "not_found" : r.status === 403 ? "forbidden" : "generic",
                    detail: `GitHub refused the request (${r.status}).`,
                    requestDispatched: method !== "GET",
                  }),
                ),
          ),
        ),
    );
  // CLI adapter errors retain dispatch knowledge for durable recovery.
  const graphql = (
    ref: SourceControlPullRequestRef,
    document: string,
    variables: Record<string, string | number | boolean>,
  ) =>
    scope(ref, () => github.runGraphql({ cwd, host: ref.host, query: document, variables })).pipe(
      Effect.flatMap((value) => {
        const mutation = document.trim().startsWith("mutation");
        const field = mutation ? /\{\s*([A-Za-z0-9_]+)\s*\(/.exec(document)?.[1] : undefined;
        if (
          (Array.isArray(record(value).errors) && (record(value).errors as unknown[]).length) ||
          (mutation && (!field || record(record(value).data)[field] == null))
        )
          return Effect.fail(failure("graphql", "GitHub GraphQL rejected the request.", mutation));
        return Effect.succeed(value);
      }),
    );
  const decodeDetail = (ref: SourceControlPullRequestRef, value: unknown) =>
    Effect.gen(function* () {
      const r = record(value),
        base = record(r.base),
        head = record(r.head);
      if (
        Number(r.number) !== ref.number ||
        !Number.isSafeInteger(ref.number) ||
        ref.number <= 0 ||
        !text(r.title)
      )
        return yield* failure("detail", "GitHub returned an invalid pull request.");
      return {
        number: ref.number,
        title: text(r.title)!,
        url: text(r.html_url) ?? `https://${ref.host}/${ref.repository}/pull/${ref.number}`,
        baseRefName: text(base.ref) ?? "",
        headRefName: text(head.ref) ?? "",
        headRefOid: text(head.sha),
        state: r.merged_at
          ? ("merged" as const)
          : r.state === "closed"
            ? ("closed" as const)
            : ("open" as const),
        body: text(r.body) ?? "",
        isCrossRepository: record(head.repo).full_name !== record(base.repo).full_name,
        headRepositoryNameWithOwner: text(record(head.repo).full_name),
        headRepositoryOwnerLogin: text(record(record(head.repo).owner).login),
        raw: r,
      } satisfies ForgeDetail;
    });
  const getDetail = (ref: SourceControlPullRequestRef) =>
    request(ref, `/pulls/${ref.number}`).pipe(Effect.flatMap((value) => decodeDetail(ref, value)));
  const node = (ref: SourceControlPullRequestRef) =>
    getDetail(ref).pipe(
      Effect.flatMap((r) =>
        typeof r.raw.node_id === "string" && r.raw.node_id
          ? Effect.succeed(r.raw.node_id)
          : Effect.fail(failure("node", "GitHub did not provide a pull request node ID.")),
      ),
    );
  const readComments = (ref: SourceControlPullRequestRef, suffix: string, kind: string) =>
    Effect.gen(function* () {
      const result: Readonly<Record<string, unknown>>[] = [];
      for (let page = 1; page <= 10; page++) {
        const value = yield* request(ref, `${suffix}?per_page=100&page=${page}`);
        if (!Array.isArray(value))
          return yield* failure("comments", "GitHub returned an invalid comment list.");
        result.push(...value.map((value) => ({ ...record(value), kind })));
        if (value.length < 100) return result;
      }
      return yield* failure("comments", "The bounded comment read exceeds 1,000 records.");
    });
  const original = makeGitHubSourceControlProvider(github);
  return {
    ...original,
    forgeCapabilities: GITHUB_FORGE_CAPABILITIES,
    getDetail,
    listPullRequests: (ref, limit = 100) =>
      request(ref, `/pulls?state=open&per_page=${Math.min(limit, 100)}`).pipe(
        Effect.flatMap((value) =>
          !Array.isArray(value)
            ? Effect.fail(failure("list", "GitHub returned an invalid pull request list."))
            : Effect.forEach(
                value,
                (item) => decodeDetail({ ...ref, number: Number(record(item).number) }, item),
                { concurrency: 4 },
              ),
        ),
      ),
    getReviewThreads: (ref) =>
      Effect.gen(function* () {
        const value = yield* graphql(
          ref,
          "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved isOutdated path line diffSide viewerCanReply viewerCanResolve viewerCanUnresolve comments(first:100){totalCount nodes{id databaseId body createdAt updatedAt url author{login} path line originalLine diffHunk replyTo{id}}}}pageInfo{hasNextPage endCursor}}}}}",
          {
            owner: ref.repository.split("/")[0]!,
            name: ref.repository.split("/")[1]!,
            number: ref.number,
          },
        );
        const connection = record(
          record(record(record(value).data).repository).pullRequest,
        ).reviewThreads;
        if (record(record(connection).pageInfo).hasNextPage === true)
          return yield* failure("review-threads", "The bounded review thread read is incomplete.");
        const nodes = Array.isArray(record(connection).nodes)
          ? (record(connection).nodes as unknown[])
          : [];
        if (nodes.some((value) => Number(record(record(value).comments).totalCount) > 100))
          return yield* failure("review-threads", "The bounded thread comment read is incomplete.");
        return nodes.map((value) => {
          const node = record(value),
            comments = record(node.comments);
          return {
            ...node,
            resolved: node.isResolved,
            comments: Array.isArray(comments.nodes)
              ? comments.nodes.map((comment) => ({
                  ...record(comment),
                  html_url: record(comment).url,
                }))
              : [],
          };
        });
      }),
    editComment: (input) =>
      request(
        input.ref,
        `/${input.kind === "review-comment" ? "pulls" : "issues"}/comments/${encodeURIComponent(input.commentId)}`,
        "PATCH",
        { body: input.body },
      ),
    getFiles: (ref) =>
      Effect.gen(function* () {
        const files: import("../sourceControl/ForgeSourceControlProvider.ts").ForgeFile[] = [];
        for (let page = 1; page <= 10; page++) {
          const raw = yield* request(ref, `/pulls/${ref.number}/files?per_page=100&page=${page}`);
          if (!Array.isArray(raw))
            return yield* new SourceControlProviderError({
              provider: "github",
              operation: "files",
              kind: "invalid_response",
              detail: "GitHub returned invalid files.",
            });
          for (const value of raw) {
            const r = record(value);
            files.push({
              path: String(r.filename),
              previousPath: text(r.previous_filename),
              status: String(r.status),
              patch: text(r.patch),
              revision: text(r.sha),
            });
          }
          if (raw.length < 100) break;
          if (page === 10)
            return yield* failure("files", "The bounded file read exceeds 1,000 files.");
        }
        return files;
      }),
    getDiff: (ref) =>
      scope(ref, () =>
        github
          .execute({
            cwd,
            args: [
              "api",
              `repos/${ref.repository}/pulls/${ref.number}`,
              "--hostname",
              ref.host,
              "-H",
              "Accept: application/vnd.github.diff",
            ],
          })
          .pipe(Effect.map((r) => r.stdout)),
      ),
    getComments: (ref) =>
      Effect.gen(function* () {
        const responses = yield* Effect.all(
          [
            readComments(ref, `/issues/${ref.number}/comments`, "issue-comment"),
            readComments(ref, `/pulls/${ref.number}/reviews`, "review"),
            readComments(ref, `/pulls/${ref.number}/comments`, "review-comment"),
          ],
          { concurrency: 3 },
        );
        return responses.flatMap((r) => (Array.isArray(r) ? r.map(record) : []));
      }),
    writeComment: (input) =>
      request(
        input.ref,
        input.replyTo
          ? `/pulls/${input.ref.number}/comments/${encodeURIComponent(input.replyTo)}/replies`
          : input.path
            ? `/pulls/${input.ref.number}/comments`
            : `/issues/${input.ref.number}/comments`,
        "POST",
        {
          body: input.body,
          ...(input.path
            ? {
                path: input.path,
                line: input.line,
                side: input.side === "old" ? "LEFT" : "RIGHT",
                commit_id: input.headSha,
              }
            : {}),
        },
      ),
    submitReview: (input) =>
      request(input.ref, `/pulls/${input.ref.number}/reviews`, "POST", {
        body: input.body,
        event:
          input.verdict === "approve"
            ? "APPROVE"
            : input.verdict === "request-changes"
              ? "REQUEST_CHANGES"
              : "COMMENT",
        ...(input.headSha ? { commit_id: input.headSha } : {}),
      }),
    performAction: (input) =>
      Effect.gen(function* () {
        const ref = input.ref;
        switch (input.action) {
          case "merge":
            return yield* request(ref, `/pulls/${ref.number}/merge`, "PUT", {
              merge_method: input.method ?? "merge",
              sha: input.expectedHeadOid,
            }).pipe(
              Effect.flatMap((value) =>
                record(value).merged === true
                  ? Effect.succeed(value)
                  : Effect.fail(failure("merge", "GitHub did not merge this pull request.", true)),
              ),
            );
          case "close":
          case "reopen":
            return yield* request(ref, `/pulls/${ref.number}`, "PATCH", {
              state: input.action === "close" ? "closed" : "open",
            });
          case "update-branch": {
            if (!input.expectedHeadOid)
              return yield* failure("update-branch", "A prepared head revision is required.");
            const detail = yield* getDetail(ref);
            if (detail.headRefOid !== input.expectedHeadOid)
              return yield* failure("update-branch", "The pull request head has changed.");
            const id = text(detail.raw.node_id);
            if (!id)
              return yield* failure(
                "update-branch",
                "GitHub did not provide a pull request node ID.",
              );
            return yield* graphql(
              ref,
              "mutation($id:ID!,$head:GitObjectID!,$method:PullRequestBranchUpdateMethod!){updatePullRequestBranch(input:{pullRequestId:$id,expectedHeadOid:$head,updateMethod:$method}){pullRequest{id headRefOid}}}",
              {
                id,
                head: input.expectedHeadOid,
                method: input.method === "rebase" ? "REBASE" : "MERGE",
              },
            );
          }
          case "ready":
          case "draft": {
            const id = yield* node(ref);
            const mutation =
              input.action === "ready"
                ? "markPullRequestReadyForReview"
                : "convertPullRequestToDraft";
            return yield* graphql(
              ref,
              `mutation($id:ID!){${mutation}(input:{pullRequestId:$id}){pullRequest{id}}}`,
              { id },
            );
          }
          case "enable-auto-merge":
          case "disable-auto-merge": {
            const id = yield* node(ref);
            return yield* graphql(
              ref,
              input.action === "enable-auto-merge"
                ? "mutation($id:ID!,$method:PullRequestMergeMethod!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$method}){pullRequest{id}}}"
                : "mutation($id:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$id}){pullRequest{id}}}",
              {
                id,
                ...(input.action === "enable-auto-merge"
                  ? { method: (input.method ?? "merge").toUpperCase() }
                  : {}),
              },
            );
          }
          case "revert":
            return yield* graphql(
              ref,
              "mutation($id:ID!){revertPullRequest(input:{pullRequestId:$id}){revertPullRequest{id url}}}",
              { id: yield* node(ref) },
            );
          case "approve-workflows": {
            const detail = yield* getDetail(ref);
            if (!detail.isCrossRepository) return null;
            const sha = detail.headRefOid,
              branch = detail.headRefName,
              owner = detail.headRepositoryOwnerLogin;
            if (!sha || !owner || (input.expectedHeadOid && input.expectedHeadOid !== sha))
              return yield* failure(
                "approve-workflows",
                "The fork head revision is unavailable or has changed.",
              );
            const open = yield* request(
              ref,
              `/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`,
            );
            if (!Array.isArray(open) || open.length >= 100)
              return yield* failure(
                "approve-workflows",
                "The matching pull request list is incomplete.",
              );
            const exact = open.filter((value) => {
              const h = record(record(value).head);
              return (
                h.sha === sha &&
                text(record(record(h.repo).owner).login)?.toLowerCase() === owner.toLowerCase()
              );
            });
            if (exact.length !== 1 || Number(record(exact[0]).number) !== ref.number)
              return yield* failure(
                "approve-workflows",
                "This fork head belongs to more than one pull request.",
              );
            const result = record(
              yield* request(
                ref,
                `/actions/runs?head_sha=${encodeURIComponent(sha)}&branch=${encodeURIComponent(branch)}&event=pull_request&status=action_required&per_page=100`,
              ),
            );
            if (!Array.isArray(result.workflow_runs) || Number(result.total_count) > 100)
              return yield* failure("approve-workflows", "The workflow run list is incomplete.");
            const matches = (value: unknown) => {
              const run = record(value);
              return (
                run.head_sha === sha &&
                run.head_branch === branch &&
                run.event === "pull_request" &&
                run.status === "action_required" &&
                text(record(record(run.head_repository).owner).login)?.toLowerCase() ===
                  owner.toLowerCase()
              );
            };
            for (const value of result.workflow_runs) {
              if (!matches(value)) continue;
              const current = yield* getDetail(ref);
              if (
                current.state !== "open" ||
                current.headRefOid !== sha ||
                current.headRefName !== branch ||
                current.headRepositoryOwnerLogin?.toLowerCase() !== owner.toLowerCase()
              )
                return yield* failure(
                  "approve-workflows",
                  "The fork head changed before workflow approval.",
                );
              const currentOpen = yield* request(
                ref,
                `/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`,
              );
              const currentMatches = Array.isArray(currentOpen)
                ? currentOpen.filter((value) => {
                    const h = record(record(value).head);
                    return (
                      h.sha === sha &&
                      text(record(record(h.repo).owner).login)?.toLowerCase() ===
                        owner.toLowerCase()
                    );
                  })
                : [];
              if (
                !Array.isArray(currentOpen) ||
                currentOpen.length >= 100 ||
                currentMatches.length !== 1 ||
                Number(record(currentMatches[0]).number) !== ref.number
              )
                return yield* failure(
                  "approve-workflows",
                  "The fork head is no longer uniquely associated with this pull request.",
                );
              const id = Number(record(value).id);
              if (!Number.isSafeInteger(id) || id <= 0)
                return yield* failure(
                  "approve-workflows",
                  "GitHub returned an invalid workflow run ID.",
                );
              const run = yield* request(ref, `/actions/runs/${id}`);
              if (matches(run)) yield* request(ref, `/actions/runs/${id}/approve`, "POST");
            }
            return null;
          }
        }
      }),
    editChangeRequest: (input) =>
      request(input.ref, `/pulls/${input.ref.number}`, "PATCH", {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.body === undefined ? {} : { body: input.body }),
      }),
    setReviewers: (input) =>
      getDetail(input.ref).pipe(
        Effect.flatMap((detail) => {
          const existing = Array.isArray(detail.raw.requested_reviewers)
            ? (detail.raw.requested_reviewers as unknown[])
                .map((user) => text(record(user).login))
                .filter((login): login is string => !!login)
            : [];
          const remove = existing.filter((login) => !input.reviewers.includes(login));
          const add = input.reviewers.filter((login) => !existing.includes(login));
          return (
            remove.length
              ? request(input.ref, `/pulls/${input.ref.number}/requested_reviewers`, "DELETE", {
                  reviewers: remove,
                })
              : Effect.void
          ).pipe(
            Effect.andThen(
              add.length
                ? request(input.ref, `/pulls/${input.ref.number}/requested_reviewers`, "POST", {
                    reviewers: add,
                  })
                : Effect.void,
            ),
          );
        }),
      ),
    listReviewerCandidates: (ref) => request(ref, "/collaborators?per_page=100"),
    setLabels: (input) =>
      request(input.ref, `/issues/${input.ref.number}/labels`, "PUT", { labels: input.labels }),
    react: (input) =>
      request(
        input.ref,
        input.commentId
          ? `/issues/comments/${encodeURIComponent(input.commentId)}/reactions${input.remove ? `/${encodeURIComponent(input.reactionId ?? "")}` : ""}`
          : `/issues/${input.ref.number}/reactions${input.remove ? `/${encodeURIComponent(input.reactionId ?? "")}` : ""}`,
        input.remove ? "DELETE" : "POST",
        { content: input.content },
      ),
    resolveThread: (input) =>
      graphql(
        input.ref,
        `mutation($id:ID!){${input.resolved ? "resolveReviewThread" : "unresolveReviewThread"}(input:{threadId:$id}){thread{id isResolved}}}`,
        { id: input.threadId },
      ),
  };
}
