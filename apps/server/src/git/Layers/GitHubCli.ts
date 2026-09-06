import { githubRequestScheduler } from "../githubRequestScheduler.ts";
import { makeGitHubApi, GitHubCredentialScope, githubCredentialEnvironment } from "../githubApi.ts";
import { Effect, Layer, Schema, Option } from "effect";
import { PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";

import { runProcess } from "../../processRunner";
import { GitHubCliError } from "../Errors.ts";
import {
  GitHubCli,
  type GitHubMergePullRequestInput,
  type GitHubRepositoryCloneUrls,
  type GitHubCliShape,
  type GitHubPullRequestSummary,
} from "../Services/GitHubCli.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

function normalizeGitHubCliError(operation: "execute" | "stdout", error: unknown): GitHubCliError {
  if (error instanceof Error) {
    if (error.message.includes("Command not found: gh")) {
      return new GitHubCliError({
        operation,
        detail: "GitHub CLI (`gh`) is required but not available on PATH.",
        kind: "binary_missing",
        cause: error,
      });
    }

    const lower = error.message.toLowerCase();
    if (
      lower.includes("authentication failed") ||
      lower.includes("not logged in") ||
      lower.includes("gh auth login") ||
      lower.includes("no oauth token")
    ) {
      return new GitHubCliError({
        operation,
        detail: "GitHub CLI is not authenticated. Run `gh auth login` and retry.",
        kind: "unauthenticated",
        cause: error,
      });
    }

    if (lower.includes("rate limit") || lower.includes("secondary rate")) {
      return new GitHubCliError({
        operation,
        detail: "GitHub API rate limit reached.",
        kind: "rate_limited",
        cause: error,
      });
    }

    const httpStatus = error.message.match(/\bHTTP\s+(\d{3})\b/i)?.[1];
    if (httpStatus) {
      const statusCode = Number(httpStatus);
      const kind =
        statusCode === 401
          ? "unauthenticated"
          : statusCode === 403
            ? "forbidden"
            : statusCode === 429
              ? "rate_limited"
              : statusCode >= 500
                ? "network"
                : "generic";
      return new GitHubCliError({
        operation,
        detail: `GitHub API returned HTTP ${httpStatus}.`,
        kind,
        cause: error,
      });
    }

    if (
      lower.includes("could not resolve host") ||
      lower.includes("network") ||
      lower.includes("connection refused") ||
      lower.includes("connection reset") ||
      lower.includes("tls")
    ) {
      return new GitHubCliError({
        operation,
        detail: "GitHub CLI could not reach GitHub.",
        kind: "network",
        cause: error,
      });
    }

    if (lower.includes("timed out") || lower.includes("timeout")) {
      return new GitHubCliError({
        operation,
        detail: "GitHub CLI command timed out.",
        kind: "timeout",
        cause: error,
      });
    }

    if (lower.includes("forbidden") || lower.includes("resource not accessible")) {
      return new GitHubCliError({
        operation,
        detail: "GitHub refused access to the requested resource.",
        kind: "forbidden",
        cause: error,
      });
    }

    if (
      lower.includes("could not resolve to a pullrequest") ||
      lower.includes("repository.pullrequest") ||
      lower.includes("no pull requests found for branch") ||
      lower.includes("pull request not found")
    ) {
      return new GitHubCliError({
        operation,
        detail: "Pull request not found. Check the PR number or URL and try again.",
        kind: "not_found",
        cause: error,
      });
    }

    return new GitHubCliError({
      operation,
      detail: "GitHub CLI command failed.",
      kind: "generic",
      cause: error,
    });
  }

  return new GitHubCliError({
    operation,
    detail: "GitHub CLI command failed.",
    kind: "generic",
    cause: error,
  });
}

function normalizePullRequestState(input: {
  state?: string | null | undefined;
  mergedAt?: string | null | undefined;
}): "open" | "closed" | "merged" {
  const mergedAt = input.mergedAt;
  const state = input.state;
  if ((typeof mergedAt === "string" && mergedAt.trim().length > 0) || state === "MERGED") {
    return "merged";
  }
  if (state === "CLOSED") {
    return "closed";
  }
  return "open";
}

const RawGitHubPullRequestSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  baseRefName: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  headRefOid: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  isCrossRepository: Schema.optional(Schema.Boolean),
  headRepository: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nameWithOwner: Schema.String,
      }),
    ),
  ),
  headRepositoryOwner: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: Schema.String,
      }),
    ),
  ),
});

const RawGitHubRepositoryCloneUrlsSchema = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});

function normalizePullRequestSummary(
  raw: Schema.Schema.Type<typeof RawGitHubPullRequestSchema>,
): GitHubPullRequestSummary {
  const headRepositoryNameWithOwner = raw.headRepository?.nameWithOwner ?? null;
  const headRepositoryOwnerLogin =
    raw.headRepositoryOwner?.login ??
    (typeof headRepositoryNameWithOwner === "string" && headRepositoryNameWithOwner.includes("/")
      ? (headRepositoryNameWithOwner.split("/")[0] ?? null)
      : null);
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    ...(raw.headRefOid !== undefined ? { headRefOid: raw.headRefOid } : {}),
    state: normalizePullRequestState(raw),
    ...(typeof raw.isCrossRepository === "boolean"
      ? { isCrossRepository: raw.isCrossRepository }
      : {}),
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
  };
}

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawGitHubRepositoryCloneUrlsSchema>,
): GitHubRepositoryCloneUrls {
  return {
    nameWithOwner: raw.nameWithOwner,
    url: raw.url,
    sshUrl: raw.sshUrl,
  };
}

function decodeGitHubJson<S extends Schema.Top>(
  raw: string,
  schema: S,
  operation:
    | "listOpenPullRequests"
    | "getPullRequest"
    | "getRepositoryCloneUrls"
    | "getViewerTeams"
    | "runGraphql"
    | "searchPullRequests",
  invalidDetail: string,
): Effect.Effect<S["Type"], GitHubCliError, S["DecodingServices"]> {
  return Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
    Effect.mapError(
      (error) =>
        new GitHubCliError({
          operation,
          detail: error instanceof Error ? `${invalidDetail}: ${error.message}` : invalidDetail,
          kind: "invalid_json",
          cause: error,
        }),
    ),
  );
}

function mergeArgsForMethod(method: GitHubMergePullRequestInput["method"]): string {
  switch (method) {
    case "squash":
      return "--squash";
    case "merge":
      return "--merge";
    case "rebase":
      return "--rebase";
  }
}

const makeGitHubCli = Effect.sync(() => {
  const execute: GitHubCliShape["execute"] = (input) =>
    Effect.gen(function* () {
      const capture = yield* Effect.serviceOption(GitHubCredentialScope);
      const context = input.env === undefined && Option.isSome(capture) ? capture.value : null;
      const args = [...input.args];
      if (context && args[0] === "api") {
        const hostIndex = args.indexOf("--hostname");
        if (hostIndex >= 0 && args[hostIndex + 1]?.toLowerCase() !== context.host) {
          return yield* new GitHubCliError({
            operation: "execute",
            kind: "forbidden",
            detail: "GitHub request host does not match the captured account.",
          });
        }
        if (hostIndex < 0) args.push("--hostname", context.host);
      }
      if (
        context &&
        args[0] === "pr" &&
        args[2]?.startsWith("https://") &&
        new URL(args[2]).hostname !== context.host
      )
        return yield* new GitHubCliError({
          operation: "execute",
          kind: "forbidden",
          detail: "Pull request host does not match the captured account.",
        });
      const command = Effect.tryPromise({
        try: (signal) => {
          if (input.stdin !== undefined && Buffer.byteLength(input.stdin, "utf8") > 1024 * 1024) {
            return Promise.reject(new Error("GitHub request exceeds the 1 MiB body limit."));
          }
          return runProcess("gh", args, {
            cwd: input.cwd,
            env: context ? githubCredentialEnvironment(context) : input.env,
            timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            allowNonZeroExit: input.allowNonZeroExit ?? false,
            stdin: input.stdin,
            signal: input.signal ? AbortSignal.any([signal, input.signal]) : signal,
            maxStdoutBytes: input.maxStdoutBytes ?? 8 * 1024 * 1024,
            outputMode: "error",
          });
        },
        catch: (error) => normalizeGitHubCliError("execute", error),
      });
      if (!context) return yield* command;
      const methodIndex = Math.max(args.indexOf("--method"), args.indexOf("-X"));
      const writes =
        (args[0] === "pr" &&
          ["review", "comment", "merge", "ready", "edit"].includes(args[1] ?? "")) ||
        (args[0] === "api" && methodIndex >= 0 && args[methodIndex + 1] !== "GET");
      const checked = writes
        ? Effect.gen(function* () {
            const current = yield* api.getCredentialContext({ cwd: input.cwd, host: context.host });
            if (current.generation !== context.generation)
              return yield* new GitHubCliError({
                operation: "execute",
                kind: "forbidden",
                detail: "The GitHub account changed before the write. Nothing was sent.",
              });
            return yield* command;
          })
        : command;
      return yield* githubRequestScheduler.run(
        context.host,
        writes ? "write" : args[0] === "search" ? "search" : "rest",
        checked,
      );
    });

  const api = makeGitHubApi(execute);
  const service = {
    ...api,
    execute,
    listOpenPullRequests: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "list",
          "--head",
          input.headSelector,
          "--state",
          "open",
          "--limit",
          String(input.limit ?? 1),
          "--json",
          "number,title,url,baseRefName,headRefName",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : decodeGitHubJson(
                raw,
                Schema.Array(RawGitHubPullRequestSchema),
                "listOpenPullRequests",
                "GitHub CLI returned invalid PR list JSON.",
              ),
        ),
        Effect.map((pullRequests) => pullRequests.map(normalizePullRequestSummary)),
      ),
    getPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "view",
          input.reference,
          "--json",
          "number,title,url,baseRefName,headRefName,headRefOid,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitHubJson(
            raw,
            RawGitHubPullRequestSchema,
            "getPullRequest",
            "GitHub CLI returned invalid pull request JSON.",
          ),
        ),
        Effect.map(normalizePullRequestSummary),
      ),
    getRepositoryCloneUrls: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", input.repository, "--json", "nameWithOwner,url,sshUrl"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitHubJson(
            raw,
            RawGitHubRepositoryCloneUrlsSchema,
            "getRepositoryCloneUrls",
            "GitHub CLI returned invalid repository JSON.",
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    createPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "create",
          "--base",
          input.baseBranch,
          "--head",
          input.headSelector,
          "--title",
          input.title,
          "--body-file",
          input.bodyFile,
        ],
      }).pipe(Effect.asVoid),
    getDefaultBranch: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
      }).pipe(
        Effect.map((value) => {
          const trimmed = value.stdout.trim();
          return trimmed.length > 0 ? trimmed : null;
        }),
      ),
    checkoutPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "checkout", input.reference, ...(input.force ? ["--force"] : [])],
      }).pipe(Effect.asVoid),
    getAuthenticatedLogin: (input) =>
      execute({
        cwd: input.cwd,
        args: ["api", "user", "--jq", ".login"],
      }).pipe(
        Effect.flatMap((result) => {
          const login = result.stdout.trim();
          if (login.length === 0) {
            return Effect.fail(
              new GitHubCliError({
                operation: "getAuthenticatedLogin",
                detail: "GitHub CLI returned an empty login.",
                kind: "invalid_json",
              }),
            );
          }
          return Effect.succeed(login);
        }),
      ),
    getViewerTeams: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "api",
          "user/teams",
          "--paginate",
          "--jq",
          ".[] | [.organization.login, .slug] | @tsv",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.map((raw) =>
          raw.length === 0
            ? []
            : raw
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line) => {
                  const [organization, slug] = line.split("\t");
                  return organization && slug ? `${organization}/${slug}` : null;
                })
                .filter((team): team is string => team !== null)
                .toSorted(),
        ),
      ),
    runGraphql: (input) =>
      Effect.gen(function* () {
        const capture = yield* Effect.serviceOption(GitHubCredentialScope);
        if (Option.isSome(capture)) {
          if (input.host !== undefined && input.host.toLowerCase() !== capture.value.host) {
            return yield* new GitHubCliError({
              operation: "runGraphql",
              kind: "forbidden",
              detail: "GitHub request host does not match the captured account.",
            });
          }
          const response = yield* api.request({
            cwd: input.cwd,
            context: capture.value,
            method: "POST",
            endpoint: "graphql",
            body: { query: input.query, variables: input.variables ?? {} },
          });
          if (response.status < 200 || response.status >= 300) {
            return yield* new GitHubCliError({
              operation: "runGraphql",
              detail: `GitHub API returned HTTP ${response.status}.`,
              kind:
                response.status === 401
                  ? "unauthenticated"
                  : response.status === 429 || response.rateLimit.remaining === 0
                    ? "rate_limited"
                    : response.status === 403
                      ? "forbidden"
                      : response.status >= 500
                        ? "network"
                        : "generic",
              rateLimit: response.rateLimit,
            });
          }
          return response.body;
        }
        return yield* execute({
          cwd: input.cwd,
          args: ["api", "graphql", "--hostname", input.host ?? "github.com", "--input", "-"],
          stdin: JSON.stringify({ query: input.query, variables: input.variables ?? {} }),
          timeoutMs: 45_000,
          // `gh api graphql` exits 1 when a response contains both partial data
          // and GraphQL errors. Decode the body so callers can retain the data
          // and surface the partial failure accurately.
          allowNonZeroExit: true,
        }).pipe(
          Effect.flatMap((result) => {
            if (result.stdoutTruncated || result.aborted || result.signal) {
              return Effect.fail(
                new GitHubCliError({
                  operation: "runGraphql",
                  kind: "invalid_json",
                  detail: "GitHub response was interrupted or truncated.",
                }),
              );
            }
            const processFailed = result.timedOut || result.code !== 0;
            const processError = () => {
              const detail = result.timedOut
                ? "GitHub CLI command timed out."
                : result.stderr.trim() || `GitHub CLI command failed (code=${result.code}).`;
              return normalizeGitHubCliError("execute", new Error(detail));
            };
            return decodeGitHubJson(
              result.stdout.trim(),
              Schema.Unknown,
              "runGraphql",
              "GitHub CLI returned invalid GraphQL JSON.",
            ).pipe(
              Effect.flatMap((response) => {
                if (!processFailed) {
                  return Effect.succeed(response);
                }
                const root =
                  typeof response === "object" && response !== null
                    ? (response as Record<string, unknown>)
                    : null;
                const hasPartialData =
                  root?.data !== undefined && Array.isArray(root.errors) && root.errors.length > 0;
                if (hasPartialData && !result.timedOut) {
                  return Effect.succeed(response);
                }
                return Effect.fail(processError());
              }),
              Effect.catch((error) =>
                processFailed ? Effect.fail(processError()) : Effect.fail(error),
              ),
            );
          }),
        );
      }),
    searchPullRequests: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "search",
          "prs",
          ...input.args,
          "--json",
          "number,title,state,url,repository,author,createdAt,updatedAt,isDraft,labels,assignees,commentsCount",
          "--limit",
          String(input.limit ?? 50),
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : decodeGitHubJson(
                raw,
                Schema.Unknown,
                "searchPullRequests",
                "GitHub CLI returned invalid search JSON.",
              ),
        ),
      ),
    reviewPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "review", input.url, "--approve", ...(input.body ? ["--body-file", "-"] : [])],
        ...(input.body ? { stdin: input.body } : {}),
      }).pipe(Effect.asVoid),
    requestChanges: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "review", input.url, "--request-changes", "--body-file", "-"],
        stdin: input.body,
      }).pipe(Effect.asVoid),
    commentPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "comment", input.url, "--body-file", "-"],
        stdin: input.body,
      }).pipe(Effect.asVoid),
    mergePullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "merge",
          input.url,
          mergeArgsForMethod(input.method),
          ...(input.expectedHeadOid ? ["--match-head-commit", input.expectedHeadOid] : []),
        ],
      }).pipe(Effect.asVoid),
    markPullRequestReady: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "ready", input.url],
      }).pipe(Effect.asVoid),
    addPullRequestReviewers: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "edit",
          input.url,
          ...input.reviewers.flatMap((reviewer) => ["--add-reviewer", reviewer]),
        ],
      }).pipe(Effect.asVoid),
    changePullRequestReviewers: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "edit",
          input.url,
          ...input.add.flatMap((reviewer) => ["--add-reviewer", reviewer]),
          ...input.remove.flatMap((reviewer) => ["--remove-reviewer", reviewer]),
        ],
      }).pipe(Effect.asVoid),
    updatePullRequestBranch: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "update-branch",
          input.url,
          ...(input.method === "rebase" ? ["--rebase"] : []),
        ],
      }).pipe(Effect.asVoid),
    updatePullRequestComment: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "api",
          `repos/${input.repository}/${
            input.kind === "issue-comment" ? "issues/comments" : "pulls/comments"
          }/${input.commentId}`,
          "--hostname",
          input.host,
          "--method",
          "PATCH",
          "--input",
          "-",
        ],
        stdin: JSON.stringify({ body: input.body }),
      }).pipe(Effect.asVoid),
  } satisfies GitHubCliShape;

  return service;
});

export const GitHubCliLive = Layer.effect(GitHubCli, makeGitHubCli);
