import { readFile } from "node:fs/promises";
import { Effect, Schema } from "effect";
import {
  SOURCE_CONTROL_PULL_REQUEST_ACTIONS,
  type ForgeAction,
  type ForgeCapabilities,
  type SourceControlPullRequestAction,
  type SourceControlPullRequestRef,
} from "@t3tools/contracts";
import { quoteGitPatchPath, unquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import { parseSourceControlPullRequestUrl } from "@t3tools/shared/sourceControl";
import { forgeRequestBudget, updateForgeRequestBudget } from "./forgeRequestBudget.ts";
import {
  SourceControlProviderError,
  type SourceControlProvider,
  type SourceControlPullRequestSummary,
} from "./SourceControlProvider.ts";

export type ForgeKind = "gitlab" | "bitbucket" | "azure-devops" | "forgejo";
const COMMON = {
  diff: true,
  labels: false,
  viewedFiles: "f5",
  stacks: false,
  stackActions: false,
  edit: { changeRequest: true, comment: true },
  reviewers: { request: true, listCandidates: true },
} as const;
export const FORGE_CAPABILITIES: Readonly<Record<ForgeKind, ForgeCapabilities>> = {
  gitlab: {
    ...COMMON,
    comment: true,
    actions: [
      "merge",
      "ready",
      "draft",
      "close",
      "reopen",
      "update-branch",
      "enable-auto-merge",
      "disable-auto-merge",
    ],
    mergeMethods: ["merge", "squash", "rebase"],
    updateMethods: ["rebase"],
    search: true,
    reactions: true,
    review: { inlineComment: true, reply: true, resolve: true, verdicts: ["comment", "approve"] },
  },
  bitbucket: {
    ...COMMON,
    comment: true,
    actions: ["merge", "close"],
    mergeMethods: ["merge", "squash", "rebase"],
    updateMethods: [],
    search: true,
    reactions: false,
    review: {
      inlineComment: true,
      reply: true,
      resolve: true,
      verdicts: ["comment", "approve", "request-changes"],
    },
  },
  "azure-devops": {
    ...COMMON,
    comment: false,
    actions: [
      "merge",
      "ready",
      "draft",
      "close",
      "reopen",
      "enable-auto-merge",
      "disable-auto-merge",
    ],
    mergeMethods: ["merge", "squash"],
    updateMethods: [],
    search: false,
    reactions: false,
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: true, listCandidates: false },
    edit: { changeRequest: true, comment: false },
  },
  forgejo: {
    ...COMMON,
    comment: true,
    actions: ["merge", "close", "reopen", "update-branch"],
    mergeMethods: ["merge", "squash", "rebase"],
    updateMethods: ["merge", "rebase"],
    search: false,
    reactions: true,
    labels: true,
    review: {
      inlineComment: true,
      reply: false,
      resolve: false,
      verdicts: ["comment", "approve", "request-changes"],
    },
  },
};
export const GITHUB_FORGE_CAPABILITIES: ForgeCapabilities = {
  ...COMMON,
  viewedFiles: "host",
  comment: true,
  labels: true,
  actions: [
    "merge",
    "ready",
    "draft",
    "close",
    "reopen",
    "update-branch",
    "enable-auto-merge",
    "disable-auto-merge",
    "revert",
    "approve-workflows",
  ],
  mergeMethods: ["merge", "squash", "rebase"],
  updateMethods: ["merge", "rebase"],
  search: true,
  reactions: true,
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
  },
  stacks: true,
  stackActions: true,
};
export interface ForgeAccount {
  readonly kind: ForgeKind;
  readonly host: string;
  readonly repository: string;
  readonly login: string;
  readonly viewerId?: string;
  readonly token: string;
}
export interface ForgeFile {
  readonly path: string;
  readonly previousPath: string | null;
  readonly status: string;
  readonly patch: string | null;
  readonly revision: string | null;
}
export interface ForgeDetail extends SourceControlPullRequestSummary {
  readonly body: string;
  readonly raw: Readonly<Record<string, unknown>>;
}
export interface ForgeCommentInput {
  readonly ref: SourceControlPullRequestRef;
  readonly body: string;
  readonly path?: string;
  readonly line?: number;
  readonly side?: "old" | "new";
  readonly replyTo?: string;
  readonly baseSha?: string;
  readonly startSha?: string;
  readonly headSha?: string;
}
export interface ForgeProvider extends SourceControlProvider {
  readonly forgeCapabilities: ForgeCapabilities;
  readonly listPullRequests: (
    ref: SourceControlPullRequestRef,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<ForgeDetail>, SourceControlProviderError>;
  readonly getDetail: (
    ref: SourceControlPullRequestRef,
  ) => Effect.Effect<ForgeDetail, SourceControlProviderError>;
  readonly getFiles: (
    ref: SourceControlPullRequestRef,
  ) => Effect.Effect<ReadonlyArray<ForgeFile>, SourceControlProviderError>;
  readonly getDiff: (
    ref: SourceControlPullRequestRef,
  ) => Effect.Effect<string, SourceControlProviderError>;
  readonly getReviewThreads: (
    ref: SourceControlPullRequestRef,
  ) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, SourceControlProviderError>;
  readonly getComments: (
    ref: SourceControlPullRequestRef,
  ) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, SourceControlProviderError>;
  readonly writeComment: (
    input: ForgeCommentInput,
  ) => Effect.Effect<unknown, SourceControlProviderError>;
  readonly submitReview: (
    input: ForgeCommentInput & { readonly verdict: "comment" | "approve" | "request-changes" },
  ) => Effect.Effect<unknown, SourceControlProviderError>;
  readonly performAction: (input: {
    readonly ref: SourceControlPullRequestRef;
    readonly action: ForgeAction;
    readonly method?: "merge" | "squash" | "rebase";
    readonly expectedHeadOid?: string;
  }) => Effect.Effect<unknown, SourceControlProviderError>;
  readonly editChangeRequest: (input: {
    readonly ref: SourceControlPullRequestRef;
    readonly title?: string;
    readonly body?: string;
  }) => Effect.Effect<unknown, SourceControlProviderError>;
  readonly editComment: (input: {
    readonly ref: SourceControlPullRequestRef;
    readonly commentId: string;
    readonly body: string;
    readonly kind?: "issue-comment" | "review-comment";
  }) => Effect.Effect<unknown, SourceControlProviderError>;
  readonly setReviewers: (input: {
    readonly ref: SourceControlPullRequestRef;
    readonly reviewers: ReadonlyArray<string>;
  }) => Effect.Effect<unknown, SourceControlProviderError>;
  readonly listReviewerCandidates: (
    ref: SourceControlPullRequestRef,
  ) => Effect.Effect<unknown, SourceControlProviderError>;
  readonly setLabels: (input: {
    readonly ref: SourceControlPullRequestRef;
    readonly labels: ReadonlyArray<string>;
  }) => Effect.Effect<unknown, SourceControlProviderError>;
  readonly react: (input: {
    readonly ref: SourceControlPullRequestRef;
    readonly commentId?: string;
    readonly content: string;
    readonly remove?: boolean;
    readonly reactionId?: string;
  }) => Effect.Effect<unknown, SourceControlProviderError>;
  readonly resolveThread: (input: {
    readonly ref: SourceControlPullRequestRef;
    readonly threadId: string;
    readonly resolved: boolean;
  }) => Effect.Effect<unknown, SourceControlProviderError>;
}
type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const rows = (value: unknown): Json[] =>
  Array.isArray(value)
    ? value.map(object)
    : Array.isArray(object(value).values)
      ? (object(value).values as unknown[]).map(object)
      : Array.isArray(object(value).value)
        ? (object(value).value as unknown[]).map(object)
        : [];
const text = (value: unknown) => (typeof value === "string" ? value : "");
const enc = encodeURIComponent;
const pathParts = (value: string) => value.split("/").map(enc).join("/");

/** Each request resolves an account independently. There is no process-global active account. */
export function makeForgeSourceControlProvider(options: {
  readonly kind: ForgeKind;
  readonly resolveAccount: (input: {
    readonly cwd?: string;
    readonly ref?: SourceControlPullRequestRef;
  }) => Effect.Effect<ForgeAccount, SourceControlProviderError>;
  readonly fetch?: typeof globalThis.fetch;
}): ForgeProvider {
  const kind = options.kind,
    caps = FORGE_CAPABILITIES[kind];
  const error = (
    operation: string,
    detail: string,
    errorKind: SourceControlProviderError["kind"] = "unsupported",
    dispatched = false,
  ) =>
    new SourceControlProviderError({
      provider: kind,
      operation,
      detail,
      kind: errorKind,
      requestDispatched: dispatched,
    });
  const unsupported = (operation: string) =>
    Effect.fail(error(operation, `The ${kind} provider does not support ${operation}.`));
  const account = (ref?: SourceControlPullRequestRef, cwd?: string) =>
    options
      .resolveAccount({ ...(ref ? { ref } : {}), ...(cwd ? { cwd } : {}) })
      .pipe(
        Effect.flatMap((value) =>
          value.kind !== kind ||
          (ref &&
            (value.host.toLowerCase() !== ref.host.toLowerCase() ||
              value.repository !== ref.repository))
            ? Effect.fail(
                error(
                  "account.resolve",
                  "Account routing does not match the requested host and repository.",
                  "forbidden",
                ),
              )
            : Effect.succeed(value),
        ),
      );
  const root = (a: ForgeAccount) =>
    kind === "gitlab"
      ? `https://${a.host}/api/v4/projects/${enc(a.repository)}`
      : kind === "bitbucket"
        ? `https://api.bitbucket.org/2.0/repositories/${pathParts(a.repository)}`
        : kind === "forgejo"
          ? `https://${a.host}/api/v1/repos/${pathParts(a.repository)}`
          : `https://${a.host}/${pathParts(a.repository.split("/").slice(0, -1).join("/"))}/_apis/git/repositories/${enc(a.repository.split("/").at(-1)!)}`;
  const pull = (ref: SourceControlPullRequestRef) =>
    kind === "gitlab"
      ? `/merge_requests/${ref.number}`
      : kind === "forgejo"
        ? `/pulls/${ref.number}`
        : `/pullrequests/${ref.number}`;
  const issue = (ref: SourceControlPullRequestRef) => `/issues/${ref.number}`;
  const request = (
    ref: SourceControlPullRequestRef | undefined,
    cwd: string | undefined,
    suffix: string,
    method = "GET",
    body?: unknown,
    raw = false,
    repositoryOverride?: string,
  ) =>
    Effect.gen(function* () {
      const a = yield* account(ref, cwd);
      if (!a.token)
        return yield* error("request", "Credentials are not configured.", "unauthenticated");
      if (
        a.host.includes("/") ||
        a.host.includes(":") ||
        (kind === "bitbucket" && a.host !== "bitbucket.org")
      )
        return yield* error("request", "Invalid configured forge host.", "forbidden");
      if (
        repositoryOverride &&
        repositoryOverride
          .split("/")
          .some((part) => !part || part === "." || part === ".." || /[\\?#\s]/.test(part))
      )
        return yield* error("repository", "Invalid repository name.", "forbidden");
      const url = `${root(repositoryOverride ? { ...a, repository: repositoryOverride } : a)}${suffix}${kind === "azure-devops" ? `${suffix.includes("?") ? "&" : "?"}api-version=7.1` : ""}`;
      const budget = forgeRequestBudget(a);
      if (!budget)
        return yield* error(method, "The bounded account request budget is full.", "rate_limited");
      return yield* budget.gate.withPermits(1)(
        Effect.suspend(() => {
          if (budget.blockedUntil > Date.now())
            return Effect.fail(
              new SourceControlProviderError({
                provider: kind,
                operation: method,
                detail: "Forge requests are paused until the account rate limit resets.",
                kind: "rate_limited",
                requestDispatched: false,
                retryAfterSeconds: Math.ceil((budget.blockedUntil - Date.now()) / 1000),
              }),
            );
          return Effect.tryPromise({
            try: async (signal) => {
              const headers: Record<string, string> = {
                Accept: raw ? "text/plain" : "application/json",
              };
              if (kind === "gitlab") headers["PRIVATE-TOKEN"] = a.token;
              else
                headers.Authorization =
                  kind === "azure-devops"
                    ? `Basic ${Buffer.from(`:${a.token}`).toString("base64")}`
                    : `Bearer ${a.token}`;
              if (body !== undefined) headers["Content-Type"] = "application/json";
              const response = await (options.fetch ?? globalThis.fetch)(url, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                redirect: "error",
                signal,
              });
              updateForgeRequestBudget(budget, response);
              if (!response.ok) {
                const retry = response.headers.get("retry-after");
                const retryAfterSeconds =
                  retry && /^\d+$/.test(retry)
                    ? Number(retry)
                    : retry
                      ? Math.max(0, Math.ceil((Date.parse(retry) - Date.now()) / 1000))
                      : undefined;
                throw new SourceControlProviderError({
                  provider: kind,
                  operation: method,
                  detail: `Forge returned HTTP ${response.status}.`,
                  kind:
                    response.status === 401
                      ? "unauthenticated"
                      : response.status === 403
                        ? "forbidden"
                        : response.status === 404
                          ? "not_found"
                          : response.status === 429
                            ? "rate_limited"
                            : "generic",
                  requestDispatched: true,
                  ...(retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)
                    ? { retryAfterSeconds }
                    : {}),
                });
              }
              const reader = response.body?.getReader();
              const chunks: Uint8Array[] = [];
              let bytes = 0;
              if (reader)
                try {
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    bytes += value.byteLength;
                    if (bytes > 16 * 1024 * 1024)
                      throw error(
                        method,
                        "Response exceeds the 16 MiB limit.",
                        "invalid_response",
                        true,
                      );
                    chunks.push(value);
                  }
                } finally {
                  await reader.cancel().catch(() => undefined);
                }
              const content = Buffer.concat(chunks).toString("utf8");
              if (Buffer.byteLength(content) > 16 * 1024 * 1024)
                throw error(method, "Response exceeds the 16 MiB limit.", "invalid_response", true);
              if (raw) return content;
              if (!content) return null;
              try {
                return JSON.parse(content) as unknown;
              } catch {
                throw error(method, "Forge returned invalid JSON.", "invalid_response", true);
              }
            },
            catch: (cause) =>
              Schema.is(SourceControlProviderError)(cause)
                ? cause
                : error(method, "Forge request failed.", "network", true),
          }).pipe(
            Effect.timeoutOrElse({
              duration: "30 seconds",
              onTimeout: () =>
                Effect.fail(error(method, "Forge request timed out.", "timeout", true)),
            }),
          );
        }),
      );
    });
  const pagedRows = (ref: SourceControlPullRequestRef, suffix: string) =>
    Effect.gen(function* () {
      if (kind === "azure-devops") return rows(yield* request(ref, undefined, suffix));
      const result: Json[] = [];
      for (let page = 1; page <= 10; page++) {
        const response = yield* request(
          ref,
          undefined,
          `${suffix}${suffix.includes("?") ? "&" : "?"}${kind === "gitlab" ? "per_page" : kind === "bitbucket" ? "pagelen" : "limit"}=100&page=${page}`,
        );
        if (!Array.isArray(response) && !Array.isArray(object(response).values))
          return yield* error(
            "pagination",
            "Forge returned an invalid collection.",
            "invalid_response",
          );
        const values = rows(response);
        result.push(...values);
        const more = kind === "bitbucket" ? !!object(response).next : values.length === 100;
        if (!more) return result;
      }
      return yield* error(
        "pagination",
        "The bounded collection read exceeds 1,000 records.",
        "invalid_response",
      );
    });
  const summary = (value: unknown, reference?: SourceControlPullRequestRef): ForgeDetail => {
    const v = object(value),
      source = object(v.source),
      dest = object(v.destination),
      head = object(v.head),
      base = object(v.base);
    const links = object(v.links);
    const status = text(v.state || v.status).toLowerCase();
    return {
      number: Number(v.iid ?? v.number ?? v.id ?? v.pullRequestId),
      title: text(v.title),
      body: text(
        typeof v.description === "object" ? object(v.description).raw : (v.description ?? v.body),
      ),
      url:
        text(
          v.web_url ?? v.html_url ?? object(links.html).href ?? object(object(v._links).web).href,
        ) ||
        (kind === "azure-devops" && text(object(v.repository).webUrl)
          ? `${text(object(v.repository).webUrl)}/pullrequest/${Number(v.pullRequestId)}`
          : reference
            ? `https://${reference.host}/${kind === "azure-devops" ? reference.repository.split("/").slice(0, -1).join("/") + "/_git/" + reference.repository.split("/").at(-1) : reference.repository}/${kind === "gitlab" ? "-/merge_requests" : kind === "bitbucket" ? "pull-requests" : kind === "azure-devops" ? "pullrequest" : "pulls"}/${Number(v.iid ?? v.number ?? v.id ?? v.pullRequestId)}`
            : text(v.url)),
      baseRefName: text(
        v.target_branch ?? object(dest.branch).name ?? base.ref ?? v.targetRefName,
      ).replace(/^refs\/heads\//, ""),
      headRefName: text(
        v.source_branch ?? object(source.branch).name ?? head.ref ?? v.sourceRefName,
      ).replace(/^refs\/heads\//, ""),
      headRefOid:
        text(
          v.sha ??
            head.sha ??
            object(source.commit).hash ??
            object(v.lastMergeSourceCommit).commitId,
        ) || null,
      state:
        status === "merged" || status === "completed" || v.merged === true
          ? "merged"
          : status === "closed" || status === "declined" || status === "abandoned"
            ? "closed"
            : "open",
      isCrossRepository:
        kind === "gitlab"
          ? v.source_project_id !== v.target_project_id
          : kind === "bitbucket"
            ? object(source.repository).full_name !== object(dest.repository).full_name
            : kind === "forgejo"
              ? object(head.repo).full_name !== object(base.repo).full_name
              : false,
      headRepositoryNameWithOwner:
        text(object(source.repository).full_name ?? object(head.repo).full_name) || null,
      headRepositoryOwnerLogin: text(object(object(head.repo).owner).login) || null,
      raw: v,
    };
  };
  const refFrom = (value: string, cwd: string) =>
    Effect.gen(function* () {
      const a = yield* account(undefined, cwd);
      const ref = /^\d+$/.test(value)
        ? { provider: kind, host: a.host, repository: a.repository, number: Number(value) }
        : parseSourceControlPullRequestUrl(value, kind, a.host);
      if (!ref || ref.repository !== a.repository)
        return yield* error("reference", "Invalid pull request reference.", "invalid_response");
      return ref;
    });
  const getDetail = (ref: SourceControlPullRequestRef) =>
    request(ref, undefined, pull(ref)).pipe(Effect.map((value) => summary(value, ref)));
  const writeComment = (input: ForgeCommentInput) => {
    if (
      !caps.comment ||
      (input.path && !caps.review.inlineComment) ||
      (input.replyTo && !caps.review.reply)
    )
      return unsupported("comment");
    if (kind === "gitlab")
      return request(
        input.ref,
        undefined,
        `${pull(input.ref)}/${input.replyTo ? `discussions/${enc(input.replyTo)}/notes` : input.path ? "discussions" : "notes"}`,
        "POST",
        {
          body: input.body,
          ...(input.path
            ? {
                position: {
                  position_type: "text",
                  base_sha: input.baseSha,
                  start_sha: input.startSha,
                  head_sha: input.headSha,
                  old_path: input.path,
                  new_path: input.path,
                  [input.side === "old" ? "old_line" : "new_line"]: input.line,
                },
              }
            : {}),
        },
      );
    if (kind === "bitbucket")
      return request(input.ref, undefined, `${pull(input.ref)}/comments`, "POST", {
        content: { raw: input.body },
        ...(input.replyTo ? { parent: { id: Number(input.replyTo) } } : {}),
        ...(input.path
          ? { inline: { path: input.path, [input.side === "old" ? "from" : "to"]: input.line } }
          : {}),
      });
    return input.path
      ? request(input.ref, undefined, `${pull(input.ref)}/reviews`, "POST", {
          body: input.body,
          event: "COMMENT",
          comments: [{ path: input.path, body: input.body, position: input.line }],
        })
      : request(input.ref, undefined, `${issue(input.ref)}/comments`, "POST", { body: input.body });
  };
  const submitReview = (
    input: ForgeCommentInput & { verdict: "comment" | "approve" | "request-changes" },
  ) => {
    if (!caps.review.verdicts.includes(input.verdict)) return unsupported("review");
    if (input.verdict === "comment") return writeComment(input);
    if ((kind === "gitlab" || kind === "bitbucket") && input.body.trim())
      return unsupported("review body requires a separate durable comment step");
    if (kind === "gitlab")
      return request(input.ref, undefined, `${pull(input.ref)}/approve`, "POST", {
        sha: input.headSha,
      });
    if (kind === "bitbucket")
      return request(
        input.ref,
        undefined,
        `${pull(input.ref)}/${input.verdict === "approve" ? "approve" : "request-changes"}`,
        "POST",
      );
    return request(input.ref, undefined, `${pull(input.ref)}/reviews`, "POST", {
      body: input.body,
      event: input.verdict === "approve" ? "APPROVED" : "REQUEST_CHANGES",
      commit_id: input.headSha,
    });
  };
  const performAction = (input: {
    ref: SourceControlPullRequestRef;
    action: ForgeAction;
    method?: "merge" | "squash" | "rebase";
    expectedHeadOid?: string;
  }) => {
    const { ref, action, method = "merge" } = input;
    if (
      !caps.actions.includes(action) ||
      (action === "merge" && !caps.mergeMethods.includes(method)) ||
      (action === "update-branch" && !caps.updateMethods.includes(method as "merge" | "rebase"))
    )
      return unsupported(action);
    if (kind === "gitlab") {
      if (action === "merge" && method === "rebase")
        return request(ref, undefined, "").pipe(
          Effect.flatMap((project) =>
            object(project).merge_method === "ff" || object(project).merge_method === "rebase_merge"
              ? request(ref, undefined, `${pull(ref)}/merge`, "PUT", {
                  sha: input.expectedHeadOid,
                  squash: false,
                })
              : unsupported("rebase merge for this project's configured merge method"),
          ),
        );
      if (action === "merge" || action === "enable-auto-merge")
        return request(ref, undefined, `${pull(ref)}/merge`, "PUT", {
          sha: input.expectedHeadOid,
          squash: method === "squash",
          auto_merge: action === "enable-auto-merge",
        });
      if (action === "disable-auto-merge")
        return request(ref, undefined, `${pull(ref)}/cancel_merge_when_pipeline_succeeds`, "POST");
      if (action === "update-branch") return request(ref, undefined, `${pull(ref)}/rebase`, "PUT");
      if (action === "ready" || action === "draft")
        return getDetail(ref).pipe(
          Effect.flatMap((detail) =>
            request(ref, undefined, pull(ref), "PUT", {
              title:
                action === "draft"
                  ? `Draft: ${detail.title.replace(/^(?:Draft|WIP):\s*/i, "")}`
                  : detail.title.replace(/^(?:Draft|WIP):\s*/i, ""),
            }),
          ),
        );
      return request(ref, undefined, pull(ref), "PUT", {
        state_event: action === "close" ? "close" : "reopen",
      });
    }
    if (kind === "bitbucket")
      return request(
        ref,
        undefined,
        `${pull(ref)}/${action === "close" ? "decline" : "merge"}`,
        "POST",
        action === "merge"
          ? {
              merge_strategy:
                method === "merge"
                  ? "merge_commit"
                  : method === "rebase"
                    ? "fast_forward"
                    : "squash",
            }
          : undefined,
      );
    if (kind === "forgejo")
      return action === "merge"
        ? request(ref, undefined, `${pull(ref)}/merge`, "POST", {
            Do: method === "merge" ? "merge" : method === "rebase" ? "rebase" : "squash",
            head_commit_id: input.expectedHeadOid,
          })
        : action === "update-branch"
          ? request(ref, undefined, `${pull(ref)}/update`, "POST", { style: method })
          : request(ref, undefined, pull(ref), "PATCH", {
              state: action === "close" ? "closed" : "open",
            });
    const completionOptions = { mergeStrategy: method === "squash" ? "squash" : "noFastForward" };
    return account(ref).pipe(
      Effect.flatMap((a) =>
        request(
          ref,
          undefined,
          pull(ref),
          "PATCH",
          action === "merge"
            ? {
                status: "completed",
                lastMergeSourceCommit: { commitId: input.expectedHeadOid },
                completionOptions,
              }
            : action === "enable-auto-merge"
              ? { autoCompleteSetBy: { id: a.viewerId ?? a.login }, completionOptions }
              : action === "disable-auto-merge"
                ? { autoCompleteSetBy: null }
                : action === "ready" || action === "draft"
                  ? { isDraft: action === "draft" }
                  : { status: action === "close" ? "abandoned" : "active" },
        ),
      ),
    );
  };
  const azureFiles = (ref: SourceControlPullRequestRef) =>
    Effect.gen(function* () {
      const iterations = rows(yield* request(ref, undefined, `${pull(ref)}/iterations`));
      const iteration = iterations.toSorted((a, b) => Number(a.id) - Number(b.id)).at(-1);
      if (!iteration) return [];
      const entries: Json[] = [];
      let skip = 0;
      for (let page = 1; page <= 10; page++) {
        const changes = object(
          yield* request(
            ref,
            undefined,
            `${pull(ref)}/iterations/${Number(iteration.id)}/changes?$top=100&$skip=${skip}`,
          ),
        );
        entries.push(...rows(changes.changeEntries));
        if (!changes.nextSkip && !changes.nextTop) break;
        if (page === 10)
          return yield* error(
            "diff",
            "The bounded Azure iteration read exceeds 1,000 files.",
            "invalid_response",
          );
        const next = Number(changes.nextSkip);
        if (!Number.isSafeInteger(next) || next <= skip)
          return yield* error(
            "diff",
            "Azure returned an invalid iteration cursor.",
            "invalid_response",
          );
        skip = next;
      }
      const source = text(object(iteration.sourceRefCommit).commitId),
        target = text(object(iteration.targetRefCommit).commitId);
      return yield* Effect.forEach(
        entries,
        (v) =>
          Effect.gen(function* () {
            const path = text(object(v.item).path),
              previousPath = text(v.originalPath) || null,
              status = text(v.changeType);
            const read = (file: string, revision: string) =>
              request(
                ref,
                undefined,
                `/items?path=${enc(file)}&versionDescriptor.versionType=commit&versionDescriptor.version=${enc(revision)}&includeContent=true&includeContentMetadata=true`,
              ).pipe(
                Effect.map((x) => ({
                  content: text(object(x).content),
                  binary: object(object(x).contentMetadata).isBinary === true,
                })),
                Effect.catchIf(
                  (e) => e.kind === "not_found",
                  () => Effect.succeed({ content: "", binary: false }),
                ),
              );
            const oldContent =
              status.toLowerCase() === "add"
                ? { content: "", binary: false }
                : yield* read(previousPath ?? path, target);
            const newContent =
              status.toLowerCase() === "delete"
                ? { content: "", binary: false }
                : yield* read(path, source);
            if (oldContent.binary || newContent.binary)
              return { path, previousPath, status, patch: null, revision: source };
            const before = oldContent.content,
              after = newContent.content;
            if (Buffer.byteLength(before) + Buffer.byteLength(after) > 1024 * 1024)
              return { path, previousPath, status, patch: null, revision: source };
            const oldLines = before ? before.replace(/\n$/, "").split("\n") : [],
              newLines = after ? after.replace(/\n$/, "").split("\n") : [];
            const patch =
              before === after
                ? ""
                : `diff --git ${quoteGitPatchPath(`a${previousPath ?? path}`)} ${quoteGitPatchPath(`b${path}`)}\n--- ${quoteGitPatchPath(`a${previousPath ?? path}`)}\n+++ ${quoteGitPatchPath(`b${path}`)}\n@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@\n${[...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)].join("\n")}\n`;
            return { path, previousPath, status, patch, revision: source };
          }),
        { concurrency: 4 },
      );
    });
  const setReviewers = (input: {
    ref: SourceControlPullRequestRef;
    reviewers: ReadonlyArray<string>;
  }) => {
    if (kind === "gitlab")
      return request(input.ref, undefined, pull(input.ref), "PUT", {
        reviewer_ids: input.reviewers.map(Number),
      });
    if (kind === "bitbucket")
      return request(input.ref, undefined, pull(input.ref), "PUT", {
        reviewers: input.reviewers.map((uuid) => ({ uuid })),
      });
    if (kind === "forgejo")
      return getDetail(input.ref).pipe(
        Effect.flatMap((detail) => {
          const existing = rows(detail.raw.requested_reviewers).map((v) => text(v.login));
          const remove = existing.filter((login) => !input.reviewers.includes(login)),
            add = input.reviewers.filter((login) => !existing.includes(login));
          return (
            remove.length
              ? request(input.ref, undefined, `${pull(input.ref)}/requested_reviewers`, "DELETE", {
                  reviewers: remove,
                })
              : Effect.void
          ).pipe(
            Effect.andThen(
              add.length
                ? request(input.ref, undefined, `${pull(input.ref)}/requested_reviewers`, "POST", {
                    reviewers: add,
                  })
                : Effect.void,
            ),
          );
        }),
      );
    return getDetail(input.ref).pipe(
      Effect.flatMap((detail) => {
        const remove = rows(detail.raw.reviewers)
          .map((v) => text(v.id))
          .filter((id) => !input.reviewers.includes(id));
        return Effect.forEach(
          remove,
          (id) =>
            request(input.ref, undefined, `${pull(input.ref)}/reviewers/${enc(id)}`, "DELETE"),
          { concurrency: 1 },
        ).pipe(
          Effect.andThen(
            request(
              input.ref,
              undefined,
              `${pull(input.ref)}/reviewers`,
              "PUT",
              input.reviewers.map((id) => ({ id, vote: 0 })),
            ),
          ),
        );
      }),
    );
  };
  const capability = (action: SourceControlPullRequestAction) => {
    const supported =
      action === "approve"
        ? caps.review.verdicts.includes("approve")
        : action === "request-changes"
          ? caps.review.verdicts.includes("request-changes")
          : action === "comment"
            ? caps.comment
            : action === "mark-ready"
              ? caps.actions.includes("ready")
              : action === "request-reviewers" || action === "change-reviewers"
                ? caps.reviewers.request
                : action === "edit-comment"
                  ? caps.edit.comment
                  : action === "react"
                    ? caps.reactions
                    : action === "update-branch"
                      ? caps.actions.includes("update-branch")
                      : action === "merge";
    return supported
      ? { action, supported: true as const }
      : { action, supported: false as const, reason: `${kind} does not support ${action}.` };
  };
  const urlAction = (
    input: { cwd: string; url: string },
    fn: (ref: SourceControlPullRequestRef) => Effect.Effect<unknown, SourceControlProviderError>,
  ) => refFrom(input.url, input.cwd).pipe(Effect.flatMap(fn), Effect.asVoid);
  return {
    kind,
    listPullRequests: (ref, limit = 100) =>
      request(
        ref,
        undefined,
        kind === "gitlab"
          ? `/merge_requests?state=opened&per_page=${Math.min(limit, 100)}`
          : kind === "forgejo"
            ? `/pulls?state=open&limit=${Math.min(limit, 100)}`
            : kind === "bitbucket"
              ? `/pullrequests?state=OPEN&pagelen=${Math.min(limit, 100)}`
              : `/pullrequests?searchCriteria.status=active&$top=${Math.min(limit, 100)}`,
      ).pipe(Effect.map((value) => rows(value).map((value) => summary(value, ref)))),
    forgeCapabilities: caps,
    capability,
    capabilities: SOURCE_CONTROL_PULL_REQUEST_ACTIONS.map(capability),
    requireCapability: (action) =>
      capability(action).supported ? Effect.void : unsupported(action),
    getDetail,
    editComment: (input) =>
      !caps.edit.comment
        ? unsupported("edit-comment")
        : request(
            input.ref,
            undefined,
            kind === "forgejo"
              ? `/issues/comments/${enc(input.commentId)}`
              : `${pull(input.ref)}/${kind === "gitlab" ? "notes" : "comments"}/${enc(input.commentId)}`,
            kind === "forgejo" ? "PATCH" : "PUT",
            kind === "bitbucket" ? { content: { raw: input.body } } : { body: input.body },
          ),
    writeComment,
    submitReview,
    performAction,
    setReviewers,
    getReviewThreads: (ref) =>
      kind !== "forgejo"
        ? pagedRows(
            ref,
            `${pull(ref)}/${kind === "gitlab" ? "discussions" : kind === "azure-devops" ? "threads" : "comments"}`,
          )
        : pagedRows(ref, `${pull(ref)}/reviews`).pipe(
            Effect.flatMap((reviews) =>
              Effect.forEach(
                reviews,
                (review) =>
                  pagedRows(ref, `${pull(ref)}/reviews/${Number(review.id)}/comments`).pipe(
                    Effect.map((comments) => ({ ...review, comments })),
                  ),
                { concurrency: 4 },
              ),
            ),
          ),
    getComments: (ref) =>
      pagedRows(
        ref,
        `${kind === "forgejo" ? issue(ref) : pull(ref)}/${kind === "gitlab" ? "discussions" : kind === "azure-devops" ? "threads" : "comments"}`,
      ),
    getDiff: (ref) =>
      kind === "azure-devops"
        ? azureFiles(ref).pipe(Effect.map((files) => files.map((f) => f.patch ?? "").join("\n")))
        : request(
            ref,
            undefined,
            `${pull(ref)}${kind === "gitlab" ? "/raw_diffs" : kind === "forgejo" ? ".diff" : "/diff"}`,
            "GET",
            undefined,
            true,
          ).pipe(Effect.map(text)),
    getFiles: (ref) =>
      kind === "azure-devops"
        ? azureFiles(ref)
        : Effect.gen(function* () {
            const result = yield* pagedRows(
              ref,
              `${pull(ref)}/${kind === "gitlab" ? "diffs" : kind === "bitbucket" ? "diffstat" : "files"}`,
            );
            const diff =
              kind === "gitlab"
                ? ""
                : text(
                    yield* request(
                      ref,
                      undefined,
                      `${pull(ref)}${kind === "forgejo" ? ".diff" : "/diff"}`,
                      "GET",
                      undefined,
                      true,
                    ),
                  );
            const sections = diff.split(/(?=^diff --git )/m);
            return rows(result).map((v) => {
              const path = text(
                v.new_path ?? object(v.new).path ?? v.filename ?? object(v.item).path,
              );
              const previousPath =
                text(v.old_path ?? object(v.old).path ?? v.previous_filename) || null;
              const status =
                text(v.status ?? v.changeType) ||
                (v.new_file
                  ? "added"
                  : v.deleted_file
                    ? "removed"
                    : v.renamed_file
                      ? "renamed"
                      : "modified");
              const section = sections.find((section) => {
                for (const line of section.split("\n")) {
                  if (line.startsWith("@@")) break;
                  if (line.startsWith("+++ ") || line.startsWith("--- ")) {
                    const side = unquoteGitPatchPath(line.slice(4).split("\t")[0]!).replace(
                      /^[ab]\//,
                      "",
                    );
                    if (side === path || side === previousPath) return true;
                  }
                }
                return false;
              });
              return {
                path,
                previousPath,
                status,
                patch: text(v.diff ?? v.patch) || section || null,
                revision: text(v.sha ?? object(v.item).objectId) || null,
              };
            });
          }),
    editChangeRequest: (input) =>
      request(
        input.ref,
        undefined,
        pull(input.ref),
        kind === "gitlab" || kind === "bitbucket" ? "PUT" : "PATCH",
        {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined
            ? {}
            : { [kind === "forgejo" ? "body" : "description"]: input.body }),
        },
      ),
    listReviewerCandidates: (ref) =>
      !caps.reviewers.listCandidates
        ? unsupported("reviewer-candidates")
        : request(
            ref,
            undefined,
            kind === "gitlab"
              ? "/members/all"
              : kind === "bitbucket"
                ? "/default-reviewers"
                : "/collaborators",
          ),
    setLabels: (input) =>
      !caps.labels
        ? unsupported("labels")
        : request(input.ref, undefined, `${issue(input.ref)}/labels`, "PUT", {
            labels: input.labels.map(Number),
          }),
    react: (input) =>
      !caps.reactions
        ? unsupported("reactions")
        : request(
            input.ref,
            undefined,
            kind === "gitlab"
              ? `${pull(input.ref)}${input.commentId ? `/notes/${enc(input.commentId)}` : ""}/award_emoji${input.remove ? `/${enc(input.reactionId ?? "")}` : ""}`
              : `${input.commentId ? `/issues/comments/${enc(input.commentId)}` : issue(input.ref)}/reactions`,
            input.remove ? "DELETE" : "POST",
            {
              [kind === "gitlab" ? "name" : "content"]:
                kind === "gitlab"
                  ? ((
                      {
                        "+1": "thumbsup",
                        "-1": "thumbsdown",
                        laugh: "laughing",
                        hooray: "tada",
                      } as Record<string, string>
                    )[input.content] ?? input.content)
                  : input.content,
            },
          ),
    resolveThread: (input) =>
      !caps.review.resolve
        ? unsupported("resolve-thread")
        : request(
            input.ref,
            undefined,
            `${pull(input.ref)}/${kind === "gitlab" ? `discussions/${enc(input.threadId)}` : `comments/${enc(input.threadId)}/resolve`}`,
            kind === "gitlab" ? "PUT" : input.resolved ? "POST" : "DELETE",
            kind === "gitlab" ? { resolved: input.resolved } : undefined,
          ),
    execute: () => unsupported("execute"),
    query: () => unsupported("graphql"),
    getPullRequest: (input) => refFrom(input.reference, input.cwd).pipe(Effect.flatMap(getDetail)),
    listOpenPullRequests: (input) =>
      request(
        undefined,
        input.cwd,
        kind === "gitlab"
          ? `/merge_requests?state=opened&source_branch=${enc(input.headSelector)}&per_page=${Math.min(input.limit ?? 100, 100)}`
          : kind === "azure-devops"
            ? `/pullrequests?searchCriteria.status=active&searchCriteria.sourceRefName=${enc(`refs/heads/${input.headSelector}`)}`
            : `/${kind === "forgejo" ? "pulls" : "pullrequests"}?${kind === "bitbucket" ? `q=${enc(`state="OPEN" AND source.branch.name="${input.headSelector.replace(/["\\]/g, "")}"`)}` : "state=open"}`,
      ).pipe(Effect.map((result) => rows(result).map((value) => summary(value)))),
    searchPullRequests: (input) =>
      !caps.search
        ? unsupported("search")
        : request(
            undefined,
            input.cwd,
            kind === "gitlab"
              ? `/merge_requests?search=${enc(input.qualifiers.join(" "))}`
              : `/pullrequests?q=${enc(input.qualifiers.join(" "))}`,
          ),
    getDefaultBranch: (input) =>
      request(undefined, input.cwd, "").pipe(
        Effect.map(
          (v) =>
            text(
              object(v).default_branch ??
                object(object(v).mainbranch).name ??
                object(v).defaultBranch,
            ).replace(/^refs\/heads\//, "") || null,
        ),
      ),
    getRepositoryCloneUrls: (input) =>
      request(undefined, input.cwd, "", "GET", undefined, false, input.repository).pipe(
        Effect.map((value) => {
          const v = object(value),
            clone = rows(object(v.links).clone);
          return {
            nameWithOwner: input.repository,
            url: text(
              v.http_url_to_repo ??
                v.clone_url ??
                v.remoteUrl ??
                clone.find((c) => c.name === "https")?.href,
            ),
            sshUrl: text(
              v.ssh_url_to_repo ??
                v.ssh_url ??
                v.sshUrl ??
                clone.find((c) => c.name === "ssh")?.href,
            ),
          };
        }),
      ),
    createPullRequest: (input) =>
      Effect.tryPromise({
        try: () => readFile(input.bodyFile, "utf8"),
        catch: () => error("create", "Unable to read pull request body.", "generic"),
      }).pipe(
        Effect.flatMap((body) =>
          request(
            undefined,
            input.cwd,
            kind === "gitlab" ? "/merge_requests" : kind === "forgejo" ? "/pulls" : "/pullrequests",
            "POST",
            kind === "gitlab"
              ? {
                  source_branch: input.headSelector,
                  target_branch: input.baseBranch,
                  title: input.title,
                  description: body,
                }
              : kind === "bitbucket"
                ? {
                    title: input.title,
                    description: body,
                    source: { branch: { name: input.headSelector } },
                    destination: { branch: { name: input.baseBranch } },
                  }
                : kind === "forgejo"
                  ? { title: input.title, body, head: input.headSelector, base: input.baseBranch }
                  : {
                      title: input.title,
                      description: body,
                      sourceRefName: `refs/heads/${input.headSelector}`,
                      targetRefName: `refs/heads/${input.baseBranch}`,
                    },
          ),
        ),
        Effect.asVoid,
      ),
    checkoutPullRequest: () => unsupported("checkout"),
    getAuthenticatedLogin: (input) =>
      account(undefined, input.cwd).pipe(Effect.map((a) => a.login)),
    getViewerTeams: () => Effect.succeed([]),
    approvePullRequest: (input) =>
      urlAction(input, (ref) => submitReview({ ref, body: input.body ?? "", verdict: "approve" })),
    requestChanges: (input) =>
      urlAction(input, (ref) =>
        submitReview({ ref, body: input.body, verdict: "request-changes" }),
      ),
    commentPullRequest: (input) =>
      urlAction(input, (ref) => writeComment({ ref, body: input.body })),
    mergePullRequest: (input) =>
      urlAction(input, (ref) =>
        performAction({
          ref,
          action: "merge",
          method: input.method,
          ...(input.expectedHeadOid ? { expectedHeadOid: input.expectedHeadOid } : {}),
        }),
      ),
    markPullRequestReady: (input) =>
      urlAction(input, (ref) => performAction({ ref, action: "ready" })),
    addPullRequestReviewers: (input) =>
      urlAction(input, (ref) => setReviewers({ ref, reviewers: input.reviewers })),
    changePullRequestReviewers: (input) =>
      urlAction(input, (ref) =>
        getDetail(ref).pipe(
          Effect.flatMap((detail) => {
            const reviewers = rows(detail.raw.reviewers ?? detail.raw.requested_reviewers)
              .map((v) => text(v.login ?? v.uuid ?? v.id))
              .filter((id) => !input.remove.includes(id));
            return setReviewers({ ref, reviewers: [...new Set([...reviewers, ...input.add])] });
          }),
        ),
      ),
    updatePullRequestBranch: (input) =>
      urlAction(input, (ref) =>
        performAction({ ref, action: "update-branch", method: input.method }),
      ),
    updatePullRequestComment: (input) =>
      !caps.edit.comment
        ? unsupported("edit-comment")
        : request(
            { provider: kind, host: input.host, repository: input.repository, number: 1 },
            input.cwd,
            kind === "gitlab"
              ? `/merge_requests/${input.commentId.split(":")[0]}/notes/${enc(input.commentId.split(":")[1] ?? input.commentId)}`
              : kind === "bitbucket"
                ? `/pullrequests/${input.commentId.split(":")[0]}/comments/${enc(input.commentId.split(":")[1] ?? input.commentId)}`
                : `/issues/comments/${enc(input.commentId)}`,
            kind === "forgejo" ? "PATCH" : "PUT",
            kind === "bitbucket" ? { content: { raw: input.body } } : { body: input.body },
          ).pipe(Effect.asVoid),
  };
}
