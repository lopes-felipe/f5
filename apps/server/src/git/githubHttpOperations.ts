import { mergeCreditRemovalEnabled, readGitHubMergeMessage } from "./githubMergeMessage.ts";
import { open } from "node:fs/promises";
import { Effect, Exit, Option, Request, RequestResolver, Schema, Semaphore } from "effect";
import { PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import {
  parseSourceControlRemoteUrl,
  parseGitHubPullRequestUrl,
} from "@t3tools/shared/sourceControl";
import {
  GitHubCredentialScope,
  type GitHubApiRequest,
  type GitHubCredentialContext,
} from "./githubApi.ts";
import { GitHubRequestPriority } from "./githubRequestScheduler.ts";
import type { GitHubPriority } from "./githubRequestQueue.ts";
import { GitHubCliError } from "./Errors.ts";
import type { GitHubCliShape, GitHubPullRequestSummary } from "./Services/GitHubCli.ts";

interface Repository {
  readonly host: string;
  readonly repository: string;
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" ? value : null);
const invalid = (operation: string, detail = "GitHub returned an invalid response.") =>
  new GitHubCliError({ operation, kind: "invalid_json", detail });
const Summary = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  baseRefName: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  headRefOid: Schema.NullOr(Schema.String),
  state: Schema.Literals(["open", "closed", "merged"]),
  updatedAt: Schema.NullOr(Schema.String),
  isCrossRepository: Schema.Boolean,
  headRepositoryNameWithOwner: Schema.NullOr(Schema.String),
  headRepositoryOwnerLogin: Schema.NullOr(Schema.String),
});
function summary(value: unknown): Effect.Effect<GitHubPullRequestSummary, GitHubCliError> {
  const r = record(value),
    base = record(r.base),
    head = record(r.head);
  return Schema.decodeUnknownEffect(Summary)({
    number: r.number,
    title: r.title,
    url: r.html_url ?? r.url,
    baseRefName: r.baseRefName ?? base.ref,
    headRefName: r.headRefName ?? head.ref,
    headRefOid: r.headRefOid ?? head.sha ?? null,
    state:
      r.merged_at || r.mergedAt || r.state === "MERGED"
        ? "merged"
        : r.state === "closed" || r.state === "CLOSED"
          ? "closed"
          : "open",
    updatedAt: r.updatedAt ?? r.updated_at ?? null,
    isCrossRepository:
      r.isCrossRepository ?? record(base.repo).full_name !== record(head.repo).full_name,
    headRepositoryNameWithOwner:
      record(r.headRepository).nameWithOwner ?? record(head.repo).full_name ?? null,
    headRepositoryOwnerLogin:
      record(r.headRepositoryOwner).login ?? record(record(head.repo).owner).login ?? null,
  }).pipe(Effect.mapError(() => invalid("pullRequest")));
}
const PR_FIELDS =
  "number title url baseRefName headRefName headRefOid state mergedAt updatedAt isCrossRepository headRepository{nameWithOwner} headRepositoryOwner{login}";

type HttpOperations = Omit<
  GitHubCliShape,
  "execute" | "checkoutPullRequest" | "request" | "getCredentialContext"
>;
/** API-backed operations share one captured account for each complete operation. */
export function makeGitHubHttpOperations(
  api: Pick<GitHubCliShape, "request" | "getCredentialContext">,
  gitRead: (cwd: string, args: readonly string[]) => Effect.Effect<string, GitHubCliError>,
): HttpOperations {
  const remoteCache = new Map<string, { at: number; value: Repository }>();
  const remoteLock = Semaphore.makeUnsafe(1);
  const capture = (
    cwd: string,
    host?: string,
  ): Effect.Effect<GitHubCredentialContext, GitHubCliError> =>
    Effect.gen(function* () {
      const current = yield* Effect.serviceOption(GitHubCredentialScope);
      if (Option.isSome(current)) {
        if (host && host.toLowerCase() !== current.value.host)
          return yield* new GitHubCliError({
            operation: "credentials",
            kind: "forbidden",
            detail: "GitHub request host does not match the captured account.",
          });
        return current.value;
      }
      return yield* api.getCredentialContext({ cwd, host: host ?? "github.com" });
    });
  const repository = (cwd: string, writing = false): Effect.Effect<Repository, GitHubCliError> =>
    Effect.gen(function* () {
      const current = yield* Effect.serviceOption(GitHubCredentialScope);
      const host = Option.isSome(current) ? current.value.host : undefined;
      const key = JSON.stringify([cwd, host]);
      return yield* remoteLock.withPermits(1)(
        Effect.gen(function* () {
          const cached = remoteCache.get(key);
          if (!writing && cached && Date.now() - cached.at < 5_000) return cached.value;
          const output = yield* gitRead(cwd, [
            "config",
            "--get-regexp",
            "^remote\\..*\\.(url|gh-resolved)$",
          ]);
          const urls = new Map<string, string>(),
            resolved = new Map<string, string>();
          for (const line of output.split("\n")) {
            const match = /^remote\.(.+)\.(url|gh-resolved)\s+(.+)$/.exec(line);
            if (match) (match[2] === "url" ? urls : resolved).set(match[1]!, match[3]!);
          }
          const rank = (name: string) => {
            const index = ["upstream", "github", "origin"].indexOf(name.toLowerCase());
            return index < 0 ? 99 : index;
          };
          const candidates = [...urls]
            .map(([name, url]) => ({ name, ...parseSourceControlRemoteUrl(url) }))
            .filter(
              (r) =>
                r.host &&
                r.owner &&
                r.repository &&
                (host ? r.host.toLowerCase() === host : r.kind === "github"),
            )
            .toSorted((a, b) => rank(a.name) - rank(b.name));
          // gh's explicit base choice wins; never follow it across a captured host.
          for (const candidate of candidates) {
            const base = resolved.get(candidate.name);
            if (base && base !== "base" && base !== "true") {
              const parsed = parseSourceControlRemoteUrl(`https://${base}`);
              if (parsed.host === candidate.host && parsed.owner && parsed.repository) {
                const value = {
                  host: parsed.host!,
                  repository: `${parsed.owner}/${parsed.repository}`,
                };
                remoteCache.set(key, { at: Date.now(), value });
                return value;
              }
            }
            if (base === "base" || base === "true") {
              const value = {
                host: candidate.host!,
                repository: `${candidate.owner}/${candidate.repository}`,
              };
              remoteCache.set(key, { at: Date.now(), value });
              return value;
            }
          }
          const selected = candidates[0];
          if (!selected)
            return yield* new GitHubCliError({
              operation: "repository",
              kind: "not_found",
              detail:
                "No GitHub repository matching the selected account was found in this checkout.",
            });
          const value = {
            host: selected.host!,
            repository: `${selected.owner}/${selected.repository}`,
          };
          if (remoteCache.size >= 256) remoteCache.delete(remoteCache.keys().next().value!);
          remoteCache.set(key, { at: Date.now(), value });
          return value;
        }),
      );
    });
  const request = (
    cwd: string,
    context: GitHubCredentialContext,
    input: Omit<GitHubApiRequest, "cwd" | "context">,
  ) =>
    api.request({ cwd, context, ...input }).pipe(
      Effect.flatMap((response) => {
        if (response.status >= 200 && response.status < 300) return Effect.succeed(response.body);
        const status = response.status;
        return Effect.fail(
          new GitHubCliError({
            operation: "request",
            kind:
              status === 401
                ? "unauthenticated"
                : status === 404
                  ? "not_found"
                  : status === 429 ||
                      (status === 403 &&
                        (response.rateLimit.remaining === 0 ||
                          response.rateLimit.retryAfterSeconds != null))
                    ? "rate_limited"
                    : status === 403
                      ? "forbidden"
                      : status >= 500
                        ? "network"
                        : "generic",
            detail:
              status === 404
                ? "Pull request or repository not found."
                : `GitHub API returned HTTP ${status}.`,
            rateLimit: response.rateLimit,
            requestDispatched: input.method !== "GET",
          }),
        );
      }),
    );
  const graphql = (
    cwd: string,
    context: GitHubCredentialContext,
    query: string,
    variables: unknown = {},
    strict = true,
  ) =>
    request(cwd, context, { method: "POST", endpoint: "graphql", body: { query, variables } }).pipe(
      Effect.flatMap((value) =>
        strict &&
        ((Array.isArray(record(value).errors) && (record(value).errors as unknown[]).length > 0) ||
          !record(value).data)
          ? Effect.fail(invalid("runGraphql", "GitHub GraphQL rejected the request."))
          : Effect.succeed(value),
      ),
    );
  const pullTarget = (cwd: string, url: string) =>
    Effect.gen(function* () {
      let host: string;
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch {
        return yield* invalid("pullRequest", "Expected an HTTPS pull request URL.");
      }
      const ref = parseGitHubPullRequestUrl(url, host);
      if (!ref) return yield* invalid("pullRequest", "Expected an HTTPS pull request URL.");
      const context = yield* capture(cwd, host);
      return { context, ref, endpoint: `repos/${ref.repository}/pulls/${ref.number}` };
    });
  const markReady = (cwd: string, url: string) =>
    Effect.gen(function* () {
      const target = yield* pullTarget(cwd, url);
      const pr = record(
        yield* request(cwd, target.context, { method: "GET", endpoint: target.endpoint }),
      );
      if (typeof pr.node_id !== "string" || !pr.node_id)
        return yield* invalid("markPullRequestReady");
      const result = yield* graphql(
        cwd,
        target.context,
        "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id}}}",
        { id: pr.node_id },
      );
      if (!record(record(record(result).data).markPullRequestReadyForReview).pullRequest)
        return yield* invalid("markPullRequestReady");
    });
  const review = (cwd: string, url: string, event: string, body?: string) =>
    Effect.gen(function* () {
      const target = yield* pullTarget(cwd, url);
      yield* request(cwd, target.context, {
        method: "POST",
        endpoint: `${target.endpoint}/reviews`,
        body: { event, ...(body === undefined ? {} : { body }) },
      });
    });
  const reviewers = (cwd: string, url: string, add: readonly string[], remove: readonly string[]) =>
    Effect.gen(function* () {
      const target = yield* pullTarget(cwd, url);
      const changes: { method: "POST" | "DELETE"; users: string[]; teams: string[] }[] = [];
      for (const [method, names] of [
        ["POST", add],
        ["DELETE", remove],
      ] as const) {
        const users: string[] = [],
          teams: string[] = [];
        for (const name of names) {
          const parts = name.split("/");
          if (
            !parts.every((p) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(p)) ||
            parts.length > 2 ||
            (parts.length === 2 &&
              parts[0]!.toLowerCase() !== target.ref.repository.split("/")[0]!.toLowerCase())
          )
            return yield* invalid(
              "reviewers",
              "Expected a reviewer login or repository-owner/team slug.",
            );
          (parts.length === 2 ? teams : users).push(parts.at(-1)!);
        }
        if (names.length) changes.push({ method, users, teams });
      }
      for (const change of changes)
        yield* request(cwd, target.context, {
          method: change.method,
          endpoint: `${target.endpoint}/requested_reviewers`,
          body: { reviewers: change.users, team_reviewers: change.teams },
        });
    });
  class HeadLookup extends Request.Class<
    {
      cwd: string;
      context: GitHubCredentialContext;
      repo: Repository;
      head: string;
      state: "open" | "all";
      count: number;
      priority: GitHubPriority;
    },
    ReadonlyArray<GitHubPullRequestSummary>,
    GitHubCliError
  > {}
  const headResolver = RequestResolver.makeGrouped<HeadLookup, string>({
    key: ({ request: r }) =>
      JSON.stringify([r.context.host, r.context.generation, r.repo.repository, r.priority]),
    resolver: (entries) =>
      Effect.gen(function* () {
        const first = entries[0]!.request;
        const variables: Record<string, string | number> = {
          owner: first.repo.repository.split("/")[0]!,
          name: first.repo.repository.split("/")[1]!,
        };
        const declarations = ["$owner:String!", "$name:String!"];
        const fields = entries.map(({ request: r }, index) => {
          declarations.push(`$h${index}:String!`, `$n${index}:Int!`);
          variables[`h${index}`] = r.head;
          variables[`n${index}`] = r.count;
          return `h${index}:pullRequests(headRefName:$h${index},first:$n${index},${r.state === "open" ? "states:OPEN," : ""}orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${PR_FIELDS}}}`;
        });
        const result = yield* graphql(
          first.cwd,
          first.context,
          `query(${declarations.join(",")}){repository(owner:$owner,name:$name){${fields.join(" ")}}}`,
          variables,
        ).pipe(Effect.provideService(GitHubRequestPriority, first.priority));
        const data = record(record(record(result).data).repository);
        const rows = yield* Effect.forEach(entries, (_entry, index) => {
          const nodes = record(data[`h${index}`]).nodes;
          return Array.isArray(nodes)
            ? Effect.forEach(nodes, summary)
            : Effect.fail(invalid("listOpenPullRequests"));
        });
        for (const [index, entry] of entries.entries())
          entry.completeUnsafe(Exit.succeed(rows[index]!));
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            for (const entry of entries) entry.completeUnsafe(Exit.failCause(cause));
          }),
        ),
      ),
  }).pipe(RequestResolver.setDelay(5), RequestResolver.batchN(50));
  const listByHead = (cwd: string, headSelector: string, state: "open" | "all", limit = 1) =>
    Effect.gen(function* () {
      const repo = yield* repository(cwd);
      const context = yield* capture(cwd, repo.host);
      const ownerMatch = /^([^:/\s]+):(.+)$/.exec(headSelector);
      const count = Math.max(1, Math.min(100, Math.trunc(limit)));
      const priority = Option.getOrElse(
        yield* Effect.serviceOption(GitHubRequestPriority),
        () => "interactive" as const,
      );
      const rows = yield* Effect.request(
        new HeadLookup({
          cwd,
          context,
          repo,
          head: ownerMatch?.[2] ?? headSelector,
          state,
          count: ownerMatch ? 100 : count,
          priority,
        }),
        headResolver,
      );
      return rows
        .filter(
          (r) =>
            !ownerMatch ||
            r.headRepositoryOwnerLogin?.toLowerCase() === ownerMatch[1]!.toLowerCase(),
        )
        .slice(0, count);
    });
  return {
    listOpenPullRequests: (input) =>
      listByHead(input.cwd, input.headSelector, input.state ?? "open", input.limit),
    getPullRequest: (input) =>
      Effect.gen(function* () {
        if (/^https?:/i.test(input.reference)) {
          const target = yield* pullTarget(input.cwd, input.reference);
          return yield* request(input.cwd, target.context, {
            method: "GET",
            endpoint: target.endpoint,
          }).pipe(Effect.flatMap(summary));
        }
        const number = /^#?([1-9][0-9]*)$/.exec(input.reference);
        if (!number) {
          const found =
            (yield* listByHead(input.cwd, input.reference, "open"))[0] ??
            (yield* listByHead(input.cwd, input.reference, "all"))[0];
          if (!found)
            return yield* new GitHubCliError({
              operation: "getPullRequest",
              kind: "not_found",
              detail: "Pull request not found.",
            });
          return found;
        }
        const repo = yield* repository(input.cwd);
        const context = yield* capture(input.cwd, repo.host);
        return yield* request(input.cwd, context, {
          method: "GET",
          endpoint: `repos/${repo.repository}/pulls/${number[1]}`,
        }).pipe(Effect.flatMap(summary));
      }),
    getRepositoryCloneUrls: (input) =>
      Effect.gen(function* () {
        const current = yield* Effect.serviceOption(GitHubCredentialScope);
        const parts = input.repository
          .replace(/^https:\/\//, "")
          .replace(/\.git$/, "")
          .split("/");
        const host =
          parts.length === 3
            ? parts.shift()!
            : Option.isSome(current)
              ? current.value.host
              : "github.com";
        if (parts.length !== 2 || parts.some((p) => !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(p)))
          return yield* invalid(
            "getRepositoryCloneUrls",
            "Repositories are named owner/name or host/owner/name.",
          );
        const context = yield* capture(input.cwd, host);
        const result = record(
          yield* request(input.cwd, context, {
            method: "GET",
            endpoint: `repos/${parts.join("/")}`,
          }),
        );
        if (!text(result.full_name) || !text(result.html_url) || !text(result.ssh_url))
          return yield* invalid("getRepositoryCloneUrls");
        return {
          nameWithOwner: result.full_name as string,
          url: result.html_url as string,
          sshUrl: result.ssh_url as string,
        };
      }),
    createPullRequest: (input) =>
      Effect.gen(function* () {
        const repo = yield* repository(input.cwd, true);
        const context = yield* capture(input.cwd, repo.host);
        const body = yield* Effect.tryPromise({
          try: async () => {
            // Read at most the captured request's body limit, including a changing file.
            const file = await open(input.bodyFile, "r");
            try {
              const buffer = Buffer.alloc(1024 * 1024 + 1);
              let length = 0;
              while (length < buffer.length) {
                const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
                if (!bytesRead) break;
                length += bytesRead;
              }
              if (length > 1024 * 1024) throw new Error("oversized");
              return buffer.subarray(0, length).toString("utf8");
            } finally {
              await file.close();
            }
          },
          catch: () =>
            invalid("createPullRequest", "Could not read the bounded pull request body file."),
        });
        yield* request(input.cwd, context, {
          method: "POST",
          endpoint: `repos/${repo.repository}/pulls`,
          body: {
            base: input.baseBranch,
            head: input.headSelector,
            title: input.title,
            body,
            maintainer_can_modify: true,
          },
        });
      }),
    getDefaultBranch: (input) =>
      Effect.gen(function* () {
        const repo = yield* repository(input.cwd);
        const context = yield* capture(input.cwd, repo.host);
        const result = record(
          yield* request(input.cwd, context, {
            method: "GET",
            endpoint: `repos/${repo.repository}`,
          }),
        );
        if (result.default_branch != null && typeof result.default_branch !== "string")
          return yield* invalid("getDefaultBranch");
        return text(result.default_branch)?.trim() || null;
      }),
    getAuthenticatedLogin: (input) => capture(input.cwd).pipe(Effect.map((c) => c.login)),
    getViewerTeams: (input) =>
      Effect.gen(function* () {
        const context = yield* capture(input.cwd);
        const teams = new Set<string>();
        for (let page = 1; page <= 10; page++) {
          const result = yield* request(input.cwd, context, {
            method: "GET",
            endpoint: "user/teams",
            query: { per_page: 100, page },
          });
          if (!Array.isArray(result)) return yield* invalid("getViewerTeams");
          for (const value of result) {
            const r = record(value),
              owner = text(record(r.organization).login),
              slug = text(r.slug);
            if (!owner || !slug) return yield* invalid("getViewerTeams");
            teams.add(`${owner}/${slug}`);
          }
          if (result.length < 100) return [...teams].toSorted();
        }
        return yield* invalid(
          "getViewerTeams",
          "The team list exceeds the bounded pagination limit.",
        );
      }),
    runGraphql: (input) =>
      Effect.gen(function* () {
        // Validate size before credential lookup or any network/process work.
        if (
          Buffer.byteLength(
            JSON.stringify({ query: input.query, variables: input.variables ?? {} }),
          ) >
          1024 * 1024
        )
          return yield* invalid("runGraphql", "GitHub request exceeds the 1 MiB body limit.");
        const context = yield* capture(input.cwd, input.host);
        return yield* graphql(input.cwd, context, input.query, input.variables, false);
      }),
    searchPullRequests: (input) =>
      Effect.gen(function* () {
        const context = yield* capture(input.cwd);
        const mapping: Record<string, string> = {
          "--author": "author",
          "--assignee": "assignee",
          "--review-requested": "review-requested",
          "--mentions": "mentions",
          "--involves": "involves",
          "--state": "is",
          "--repo": "repo",
          "--label": "label",
        };
        const qualifiers = ["is:pr"];
        for (let index = 0; index < input.args.length; index++) {
          const arg = input.args[index]!;
          if (arg.startsWith("--")) {
            const qualifier = mapping[arg],
              next = input.args[++index];
            if (!qualifier || !next)
              return yield* invalid(
                "searchPullRequests",
                "Unsupported pull request search option.",
              );
            qualifiers.push(
              `${qualifier}:${next === "@me" ? context.login : /\s/.test(next) ? JSON.stringify(next) : next}`,
            );
          } else qualifiers.push(arg);
        }
        const result = record(
          yield* request(input.cwd, context, {
            method: "GET",
            endpoint: "search/issues",
            query: {
              q: qualifiers.join(" "),
              per_page: Math.max(1, Math.min(100, input.limit ?? 50)),
            },
          }),
        );
        if (!Array.isArray(result.items) || result.incomplete_results === true)
          return yield* invalid(
            "searchPullRequests",
            "GitHub returned an incomplete search result.",
          );
        return yield* Effect.forEach(result.items, (value) =>
          Effect.gen(function* () {
            const r = record(value),
              owner = record(r.user),
              pr = record(r.pull_request);
            const repoMatch = /\/repos\/([^/]+)\/([^/]+)$/.exec(text(r.repository_url) ?? "");
            if (!repoMatch || typeof r.number !== "number" || typeof r.title !== "string")
              return yield* invalid("searchPullRequests");
            return {
              number: r.number,
              title: r.title,
              state: r.state,
              url: pr.html_url ?? r.html_url,
              repository: { name: repoMatch[2], nameWithOwner: `${repoMatch[1]}/${repoMatch[2]}` },
              author: { login: owner.login },
              createdAt: r.created_at,
              updatedAt: r.updated_at,
              isDraft: r.draft === true,
              labels: r.labels,
              assignees: r.assignees,
              commentsCount: r.comments,
            };
          }),
        );
      }),
    reviewPullRequest: (input) => review(input.cwd, input.url, "APPROVE", input.body),
    requestChanges: (input) => review(input.cwd, input.url, "REQUEST_CHANGES", input.body),
    commentPullRequest: (input) =>
      Effect.gen(function* () {
        const target = yield* pullTarget(input.cwd, input.url);
        yield* request(input.cwd, target.context, {
          method: "POST",
          endpoint: `repos/${target.ref.repository}/issues/${target.ref.number}/comments`,
          body: { body: input.body },
        });
      }),
    mergePullRequest: (input) =>
      Effect.gen(function* () {
        const target = yield* pullTarget(input.cwd, input.url);
        const message = yield* readGitHubMergeMessage({
          ref: target.ref,
          method: input.method,
          enabled: yield* mergeCreditRemovalEnabled(input.removeAgentCreditsOnMerge),
          expectedHeadOid: input.expectedHeadOid,
          query: (query, variables) => graphql(input.cwd, target.context, query, variables),
          invalid: (detail) => invalid("mergePullRequest", detail),
        });
        const expectedHead = message.expectedHeadOid ?? input.expectedHeadOid;
        const result = yield* request(input.cwd, target.context, {
          method: "PUT",
          endpoint: `${target.endpoint}/merge`,
          body: {
            merge_method: input.method,
            ...(expectedHead ? { sha: expectedHead } : {}),
            ...(message.commitBody === undefined ? {} : { commit_message: message.commitBody }),
          },
        });
        if (record(result).merged !== true)
          return yield* new GitHubCliError({
            operation: "mergePullRequest",
            kind: "generic",
            detail: "GitHub did not merge this pull request.",
            requestDispatched: true,
          });
      }),
    markPullRequestReady: (input) => markReady(input.cwd, input.url),
    addPullRequestReviewers: (input) => reviewers(input.cwd, input.url, input.reviewers, []),
    changePullRequestReviewers: (input) => reviewers(input.cwd, input.url, input.add, input.remove),
    updatePullRequestBranch: (input) =>
      Effect.gen(function* () {
        const target = yield* pullTarget(input.cwd, input.url);
        const pr = record(
          yield* request(input.cwd, target.context, { method: "GET", endpoint: target.endpoint }),
        );
        const head = text(record(pr.head).sha),
          id = text(pr.node_id);
        if (!head || !id) return yield* invalid("updatePullRequestBranch");
        const result = yield* graphql(
          input.cwd,
          target.context,
          "mutation($id:ID!,$head:GitObjectID!,$method:PullRequestBranchUpdateMethod!){updatePullRequestBranch(input:{pullRequestId:$id,expectedHeadOid:$head,updateMethod:$method}){pullRequest{id}}}",
          { id, head, method: input.method.toUpperCase() },
        );
        if (!record(record(record(result).data).updatePullRequestBranch).pullRequest)
          return yield* invalid("updatePullRequestBranch");
      }),
    updatePullRequestComment: (input) =>
      Effect.gen(function* () {
        const context = yield* capture(input.cwd, input.host);
        yield* request(input.cwd, context, {
          method: "PATCH",
          endpoint: `repos/${input.repository}/${input.kind === "issue-comment" ? "issues" : "pulls"}/comments/${input.commentId}`,
          body: { body: input.body },
        });
      }),
  };
}
