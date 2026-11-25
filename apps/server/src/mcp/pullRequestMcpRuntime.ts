import { createHash, randomUUID } from "node:crypto";
import {
  CommandId,
  PullRequestKey,
  type ForgeMutationPayload,
  type OrchestrationThread,
  type SourceControlPullRequestRef,
} from "@t3tools/contracts";
import {
  formatSourceControlPullRequestKey,
  parseSourceControlPullRequestKey,
  toThreadPullRequestLink,
} from "@t3tools/shared/sourceControl";
import { threadWorkspaceCwd } from "@t3tools/shared/threadWorkspace";
import { Effect } from "effect";
import type { SourceControlPullRequestSummary } from "../sourceControl/SourceControlProvider";
import type { GitManagerShape } from "../git/Services/GitManager";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine";
import { truncateUtf8 } from "../orchestration/threadTranscript";
import { forgeComments, forgeComparison, forgeReviewThreads, record } from "../prHub/forgeModel";
import type { PrHubFederationShape } from "../prHub/Layers/PrHubFederation";
import type { PrHubExtensions } from "../prHub/PrHubExtensions";
import type { PullRequestMcpRequest } from "./pullRequestMcpTools";
import { ThreadToolError } from "./threadMcpTools";

type Extensions = Pick<
  PrHubExtensions["Service"],
  | "getCheckLog"
  | "getChecks"
  | "getOperation"
  | "getStack"
  | "prepareOperation"
  | "recoverOperation"
  | "submitOperation"
>;
const failure = (message: string) => new ThreadToolError({ message });
/** `repository_file_read` returns at most this much of a file's text. */
export const REPOSITORY_FILE_BYTE_LIMIT = 100_000;
const REPOSITORY_DIRECTORY_ENTRY_LIMIT = 1_000;
const limitText = (text: string, max: number) => truncateUtf8(text, max).text;

function logTail(excerpt: string, lines: number) {
  const all = excerpt.split("\n");
  const tail = Buffer.from(all.slice(-lines).join("\n"));
  let offset = Math.max(0, tail.length - 3000);
  while (offset < tail.length && (tail[offset]! & 0xc0) === 0x80) offset++;
  const text = tail.subarray(offset).toString("utf8");
  return {
    excerpt: text,
    skippedLines:
      Math.max(0, all.length - lines) +
      tail.subarray(0, offset).toString("utf8").split("\n").length -
      1,
    truncated: all.length > lines || offset > 0,
  };
}

function requestFingerprint(request: PullRequestMcpRequest) {
  return createHash("sha256")
    .update(
      JSON.stringify(request, (key, value: unknown) => {
        if (["addLabels", "removeLabels", "requestReviewers"].includes(key) && Array.isArray(value))
          return [...new Set(value as string[])].sort();
        if (value && typeof value === "object" && !Array.isArray(value))
          return Object.fromEntries(
            Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
          );
        return value;
      }),
    )
    .digest("hex");
}

function pageWindow<T>(input: {
  readonly items: readonly T[];
  readonly cursor?: string | undefined;
  readonly limit: number;
  readonly scope: readonly unknown[];
}) {
  const identity = createHash("sha256").update(JSON.stringify(input.scope)).digest("base64url");
  const [saved, position, extra] = input.cursor?.split(".") ?? [];
  const offset = input.cursor === undefined ? 0 : Number(position);
  if (
    input.cursor &&
    (saved !== identity ||
      extra !== undefined ||
      !Number.isSafeInteger(offset) ||
      offset < 1 ||
      offset >= input.items.length)
  )
    return null;
  const end = offset + input.limit;
  return {
    offset,
    values: input.items.slice(offset, end),
    nextCursor: end < input.items.length ? identity + "." + end : null,
  };
}

function summarize(detail: SourceControlPullRequestSummary) {
  return {
    number: detail.number,
    title: detail.title,
    url: detail.url,
    state: detail.state,
    baseBranch: detail.baseRefName,
    headBranch: detail.headRefName,
    headSha: detail.headRefOid ?? null,
  };
}

export function makePullRequestMcpHandler(deps: {
  readonly federation: Pick<PrHubFederationShape, "resolve" | "parseUrl">;
  readonly extensions: Extensions;
  readonly git: Pick<GitManagerShape, "sourceControlIdentity" | "branchPullRequest">;
  readonly engine: Pick<OrchestrationEngineShape, "dispatch">;
}) {
  return (
    thread: OrchestrationThread,
    project: Parameters<typeof threadWorkspaceCwd>[1],
    links: readonly SourceControlPullRequestRef[],
    request: PullRequestMcpRequest,
  ) =>
    Effect.gen(function* () {
      const { input, name } = request;
      const workspace = threadWorkspaceCwd(thread, project);
      // From the remotes only (never `git status`, which can fetch and update refs), and looked
      // up at most once per call. A lookup error fails the call: treating it as "no home
      // repository" would skip the same-host check below.
      const homeRepository = yield* Effect.cached(
        Effect.gen(function* () {
          if (!workspace) return undefined;
          const identity = yield* deps.git.sourceControlIdentity(workspace);
          if (!identity?.host || !identity.owner || !identity.repository) return undefined;
          return {
            provider: identity.kind,
            host: identity.host,
            repository: [identity.owner, identity.repository].join("/"),
            number: 1,
          } satisfies SourceControlPullRequestRef;
        }),
      );
      /**
       * The thread's repository when it has one. Read-only tools also work without it (a project
       * root holding several repositories, say): the PR's forge host must then belong to a
       * connected account, which `resolve` enforces.
       */
      const optionalHomeRepository = homeRepository;
      const repositoryRef = (repository?: string) =>
        Effect.gen(function* () {
          if (!workspace) return yield* failure("This thread has no repository workspace.");
          const home = yield* homeRepository;
          if (!home) return yield* failure("This thread's repository has no recognized forge.");
          const path = repository ?? home.repository;
          if (
            !/^[\w.-]+(?:\/[\w.-]+)+$/u.test(path) ||
            path.split("/").some((part) => part === "." || part === "..")
          )
            return yield* failure("Use a repository path such as owner/repository.");
          return {
            ...home,
            repository: path,
          } satisfies SourceControlPullRequestRef;
        });
      const resolve = (ref: SourceControlPullRequestRef) =>
        deps.federation.resolve({ key: formatSourceControlPullRequestKey(ref) });
      if (name === "pull_request_list") {
        const ref = yield* repositoryRef(input.repository);
        const runtime = yield* resolve(ref);
        const state = input.state ?? "open";
        const involvement = input.involvement ?? "all";
        const rows = yield* runtime.provider.listPullRequests(ref, 100, { state });
        const query = input.query?.toLowerCase();
        const login = runtime.account.login.toLowerCase();
        const loginOf = (value: unknown) => {
          const actor = record(value);
          return String(actor.login ?? actor.username ?? actor.uniqueName ?? "").toLowerCase();
        };
        const selected = rows
          .filter(
            (row) =>
              (state === "all" || row.state === state) &&
              (!query ||
                row.title.toLowerCase().includes(query) ||
                row.body.toLowerCase().includes(query)),
          )
          .filter(({ raw }) => {
            if (involvement === "authored")
              return loginOf(raw.user ?? raw.author ?? raw.createdBy) === login;
            if (involvement === "reviewing") {
              const reviewers = raw.requested_reviewers ?? raw.reviewers ?? raw.participants;
              return (
                Array.isArray(reviewers) &&
                reviewers.some((value) => loginOf(record(value).user ?? value) === login)
              );
            }
            return true;
          })
          .toSorted((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
          .map(summarize);
        const page = pageWindow({
          items: selected,
          cursor: input.cursor,
          limit: input.limit ?? 30,
          scope: [
            runtime.account.generation,
            ref,
            state,
            involvement,
            query,
            selected.map((item) => item.number),
          ],
        });
        if (!page)
          return yield* failure("The pull request list changed. Start again without a cursor.");
        return {
          pullRequests: page.values,
          nextCursor: page.nextCursor,
          truncated: rows.length === 100,
        };
      }
      if (name === "pull_request_create") {
        if (thread.archivedAt)
          return yield* failure("Unarchive this thread before opening a pull request.");
        const repo = yield* repositoryRef();
        const runtime = yield* resolve(repo);
        const head = thread.branch;
        if (!workspace || !head)
          return yield* failure("The thread needs a checked-out, pushed branch.");
        if (!runtime.provider.openChangeRequest)
          return yield* failure("This forge does not support opening pull requests through F5.");
        const detail = yield* runtime.provider.openChangeRequest({
          ref: repo,
          head,
          base: input.base,
          title: input.title,
          body: input.body,
          draft: input.draft ?? false,
        });
        const ref = { ...repo, number: detail.number };
        const link = toThreadPullRequestLink(ref, { url: detail.url, title: detail.title });
        if (link)
          yield* deps.engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe(randomUUID()),
            threadId: thread.id,
            pullRequest: link,
          });
        return summarize(detail);
      }

      if (name === "repository_file_read") {
        const path = (input.path ?? "").replace(/^\/+|\/+$/gu, "");
        if (
          path &&
          (path.includes("\\") ||
            path.includes("\0") ||
            path.split("/").some((part) => part === "" || part === "." || part === ".."))
        )
          return yield* failure("Use a path from the repository root, without . or .. segments.");
        let target: SourceControlPullRequestRef;
        if (input.pr) {
          if (input.number !== undefined || input.repository !== undefined)
            return yield* failure(
              "Use a PR URL or key, or use a PR number with an optional repository.",
            );
          const parsed =
            parseSourceControlPullRequestKey(input.pr) ??
            (yield* deps.federation.parseUrl(input.pr));
          if (!parsed) return yield* failure("Specify a pull request URL or key.");
          target = parsed;
        } else if (input.number !== undefined) {
          target = { ...(yield* repositoryRef(input.repository)), number: input.number };
        } else {
          target = yield* repositoryRef(input.repository);
        }
        const home = yield* optionalHomeRepository;
        if (
          home &&
          (target.provider !== home.provider ||
            target.host.toLowerCase() !== home.host.toLowerCase())
        )
          return yield* failure("This repository is outside the thread's forge.");
        const runtime = yield* resolve(target);
        const read = runtime.provider.readRepositoryContent;
        if (!read)
          return yield* failure("Reading repository files is not supported for this forge.");
        let revision = input.ref;
        if (!revision && (input.pr !== undefined || input.number !== undefined)) {
          revision = (yield* runtime.provider.getDetail(target)).headRefOid ?? undefined;
          if (!revision)
            return yield* failure("The forge did not return a current pull request head.");
        }
        const content = yield* read({ ref: target, path, revision });
        const location = {
          repository: target.repository,
          revision: revision ?? null,
          path,
        };
        if (content.kind === "directory")
          return {
            ...location,
            kind: "directory",
            entries: content.entries.slice(0, REPOSITORY_DIRECTORY_ENTRY_LIMIT),
            truncated: content.entries.length > REPOSITORY_DIRECTORY_ENTRY_LIMIT,
          };
        const text =
          content.text === null ? null : truncateUtf8(content.text, REPOSITORY_FILE_BYTE_LIMIT);
        return {
          ...location,
          kind: "file",
          size: content.size,
          text: text?.text ?? null,
          truncated: text?.truncated ?? false,
          ...(content.binary
            ? { note: "Binary file; its content is not shown." }
            : text === null
              ? {
                  note: "The forge did not return this file's content; it may be too large.",
                }
              : {}),
        };
      }

      let ref: SourceControlPullRequestRef | null = null;
      if (input.pr) {
        if (input.number !== undefined || input.repository !== undefined)
          return yield* failure(
            "Use a PR URL or key, or use a PR number with an optional repository.",
          );
        ref =
          parseSourceControlPullRequestKey(input.pr) ?? (yield* deps.federation.parseUrl(input.pr));
      } else if (input.number !== undefined) {
        ref = { ...(yield* repositoryRef(input.repository)), number: input.number };
      } else if (input.repository !== undefined) {
        return yield* failure("Include a pull request number with the repository.");
      } else if (links.length === 1) {
        ref = links[0]!;
      } else if (workspace && thread.branch) {
        const branchPr = yield* deps.git.branchPullRequest({
          cwd: workspace,
          branch: thread.branch,
        });
        if (branchPr) ref = yield* deps.federation.parseUrl(branchPr.url);
      }
      if (!ref) return yield* failure("Specify a pull request URL or number.");
      const readOnly = name === "pull_request_read" || name === "ci_logs";
      const home = readOnly ? yield* optionalHomeRepository : yield* repositoryRef();
      if (home) {
        const sameRepository =
          home.provider === "github"
            ? ref.repository.toLowerCase() === home.repository.toLowerCase()
            : ref.repository === home.repository;
        if (
          ref.provider !== home.provider ||
          ref.host.toLowerCase() !== home.host.toLowerCase() ||
          (!readOnly && !sameRepository)
        )
          return yield* failure(
            "This pull request is outside the thread's forge or writable repository.",
          );
      }
      const key = PullRequestKey.makeUnsafe(formatSourceControlPullRequestKey(ref));
      const runtime = yield* resolve(ref);
      const provider = runtime.provider;
      const target = { key, accountGeneration: runtime.account.generation };
      if (name === "pull_request_read") {
        const conversationPaging =
          input.cursor || input.commentCursor || input.reviewThreadId || input.replyCursor;
        if (input.replyCursor && !input.reviewThreadId)
          return yield* failure("A reply cursor needs its review thread ID.");
        const sections =
          input.sections ??
          (input.diffCursor
            ? ["diff"]
            : conversationPaging
              ? ["conversation"]
              : ["summary", "checks"]);
        if (
          (conversationPaging && !sections.includes("conversation")) ||
          (input.diffCursor && !sections.includes("diff"))
        )
          return yield* failure("Request the section the cursor belongs to.");
        const summary = sections.includes("summary") ? yield* provider.getDetail(ref) : undefined;
        const checks = sections.includes("checks")
          ? yield* deps.extensions.getChecks(target)
          : undefined;
        const scope = [runtime.account.generation, key];
        const conversation = sections.includes("conversation")
          ? yield* Effect.gen(function* () {
              const serialize = ({
                id,
                author,
                bodyText,
                url,
              }: {
                id: string;
                author: string | null;
                bodyText: string;
                url: string;
              }) => ({ id, author, url, body: limitText(bodyText, 500) });
              if (input.reviewThreadId) {
                const threads = forgeReviewThreads(yield* provider.getReviewThreads(ref), provider);
                const item = threads.find((thread) => thread.id === input.reviewThreadId);
                if (!item) return yield* failure("The requested review thread is unavailable.");
                const page = pageWindow({
                  items: item.comments,
                  cursor: input.replyCursor,
                  limit: 12,
                  scope: [...scope, "replies", item.id, item.comments.map(({ id }) => id)],
                });
                if (!page)
                  return yield* failure(
                    "The review replies changed. Start again without a cursor.",
                  );
                return {
                  reviewThreadId: item.id,
                  replies: page.values.map(serialize),
                  nextReplyCursor: page.nextCursor,
                };
              }
              const threads =
                input.commentCursor && !input.cursor
                  ? []
                  : forgeReviewThreads(yield* provider.getReviewThreads(ref), provider).filter(
                      (item) => input.includeResolved || !item.isResolved,
                    );
              const page = pageWindow({
                items: threads,
                cursor: input.cursor,
                limit: 6,
                scope: [
                  ...scope,
                  "threads",
                  input.includeResolved ?? false,
                  threads.map(({ id }) => id),
                ],
              });
              if (!page)
                return yield* failure(
                  "The review conversation changed. Start again without a cursor.",
                );
              const comments =
                input.cursor && !input.commentCursor
                  ? []
                  : forgeComments(yield* provider.getComments(ref))
                      .filter((item) => item.kind !== "review-comment")
                      .map((item) => ({
                        id: String(item.id),
                        author: record(item.author ?? item.user).login ?? null,
                        body: limitText(String(item.body ?? item.bodyText ?? ""), 500),
                      }));
              const commentPage = pageWindow({
                items: comments,
                cursor: input.commentCursor,
                limit: 12,
                scope: [...scope, "comments", comments.map(({ id }) => id)],
              });
              if (!commentPage)
                return yield* failure("The PR comments changed. Start again without a cursor.");
              return {
                comments: commentPage.values,
                nextCommentCursor: commentPage.nextCursor,
                reviewThreads: page.values.map(({ comments, ...item }) => ({
                  ...item,
                  comments: comments.slice(0, 4).map(serialize),
                  moreComments: comments.length > 4,
                })),
                nextCursor: page.nextCursor,
              };
            })
          : undefined;
        const diff = sections.includes("diff") ? yield* provider.getDiff(ref) : undefined;
        let diffPage: { values: string[]; nextCursor: string | null } | undefined;
        if (diff !== undefined) {
          const chunks: string[] = [];
          const bytes = Buffer.from(diff);
          for (let start = 0; start < bytes.length; ) {
            let end = Math.min(start + 12_000, bytes.length);
            while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
            chunks.push(bytes.subarray(start, end).toString("utf8"));
            start = end;
          }
          const page = pageWindow({
            items: chunks,
            cursor: input.diffCursor,
            limit: 1,
            scope: [...scope, "diff", createHash("sha256").update(bytes).digest("hex")],
          });
          if (!page) return yield* failure("The PR diff changed. Start again without a cursor.");
          diffPage = page;
        }
        return {
          key,
          ...(summary
            ? { summary: { ...summarize(summary), body: limitText(summary.body, 3500) } }
            : {}),
          ...(checks ? { checks } : {}),
          ...(conversation ? { conversation } : {}),
          ...(diffPage
            ? {
                diff: diffPage.values[0] ?? "",
                diffTruncated: diffPage.nextCursor !== null,
                nextDiffCursor: diffPage.nextCursor,
              }
            : {}),
        };
      }
      if (name === "ci_logs") {
        const checks = yield* deps.extensions.getChecks(target);
        const failed = checks.checks.filter((item) =>
          input.check
            ? item.name === input.check || item.id === input.check
            : item.status === "failure",
        );
        const logs = yield* Effect.forEach(
          failed.slice(0, 6),
          (item) =>
            deps.extensions.getCheckLog({ ...target, checkId: item.id }).pipe(
              Effect.map(({ excerpt, ...log }) => {
                const tail = excerpt === null ? null : logTail(excerpt, input.tailLines ?? 200);
                return {
                  ...log,
                  name: item.name,
                  excerpt: tail?.excerpt ?? null,
                  startLine: log.startLine + (tail?.skippedLines ?? 0),
                  truncated: log.truncated || tail?.truncated === true,
                };
              }),
            ),
          { concurrency: 2 },
        );
        return {
          key,
          headSha: checks.headOid,
          logs,
          truncated: checks.truncated || failed.length > logs.length,
        };
      }
      if (thread.archivedAt)
        return yield* failure("Unarchive this thread before changing a pull request.");
      const detail = yield* provider.getDetail(ref);
      const headSha = detail.headRefOid;
      if (!headSha) return yield* failure("The forge did not return a current pull request head.");
      const operations: Array<{
        id: string;
        status: string;
        warning?: string | undefined;
      }> = [];
      const operationId = input.operationId ?? randomUUID();
      const operationKey = createHash("sha256")
        .update(JSON.stringify([thread.id, operationId]))
        .digest("hex");
      const fingerprint = requestFingerprint(request);
      const run = <E>(makePayload: () => Effect.Effect<ForgeMutationPayload, E>) =>
        Effect.gen(function* () {
          const args = { ...target, operationId: operationKey + ":" + operations.length };
          const prior = yield* deps.extensions.getOperation(args);
          if (
            prior &&
            (prior.operationId !== args.operationId ||
              prior.expectedHeadOid !== headSha ||
              prior.requestFingerprint !== fingerprint)
          )
            return yield* failure(
              "This operation ID already belongs to a different revision or change.",
            );
          if (!prior) {
            const payload = yield* makePayload();
            const prepared = yield* deps.extensions.prepareOperation({
              ...args,
              expectedHeadOid: headSha,
              payload,
              requestFingerprint: fingerprint,
            });
            if (prepared.requestFingerprint !== fingerprint)
              return yield* failure("This operation ID already belongs to a different change.");
          }
          let operation = yield* deps.extensions.submitOperation(args);
          if (operation.status === "outcome_unknown" || operation.status === "running")
            operation = yield* deps.extensions.recoverOperation(args);
          operations.push({
            id: operation.operationId,
            status: operation.status,
            warning: operation.warning,
          });
          if (operation.status !== "succeeded")
            return yield* failure(
              "Forge operation is " +
                operation.status +
                ". Reuse operationId " +
                operationId +
                " to check the outcome.",
            );
        });
      const runPayload = (payload: ForgeMutationPayload) => run(() => Effect.succeed(payload));

      if (name === "pull_request_merge") {
        if (input.expectedHeadSha !== headSha)
          return yield* failure(
            "The pull request head changed. Review the current revision before merging.",
          );
        if (input.stack) {
          if (input.auto) return yield* failure("Automatic merging is unavailable for a stack.");
          yield* run(() =>
            Effect.gen(function* () {
              const stack = yield* deps.extensions.getStack(target);
              if (!stack) return yield* failure("This pull request has no available GitHub stack.");
              return {
                kind: "stack",
                action: "merge",
                method: input.method ?? "merge",
                fingerprint: stack.fingerprint,
              } as const;
            }),
          );
        } else {
          yield* runPayload({
            kind: "action",
            action: input.auto ? "enable-auto-merge" : "merge",
            ...(input.method ? { method: input.method } : {}),
          });
        }
      } else if (name === "ci_rerun") {
        yield* run(() =>
          Effect.gen(function* () {
            if (!input.check) return { kind: "action", action: "rerun-failed-checks" } as const;
            const checks = yield* deps.extensions.getChecks({ ...target, mode: "force" });
            const ids = new Set(
              checks.checks
                .filter(
                  (item) =>
                    (item.name === input.check || item.id === input.check) &&
                    item.status === "failure",
                )
                .map((item) => Number(item.workflowRunId)),
            );
            const id = [...ids][0];
            if (
              checks.headOid !== headSha ||
              ids.size !== 1 ||
              id === undefined ||
              !Number.isSafeInteger(id) ||
              id < 1
            )
              return yield* failure("Choose one failed GitHub Actions check on the current head.");
            return { kind: "action", action: "rerun-failed-checks", workflowRunId: id } as const;
          }),
        );
      } else if (name === "pull_request_update") {
        if (input.title !== undefined || input.body !== undefined)
          yield* runPayload({
            kind: "edit",
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.body === undefined ? {} : { body: input.body }),
          });
        if (input.addLabels || input.removeLabels) {
          yield* run(() =>
            Effect.gen(function* () {
              const raw = (yield* provider.getDetail(ref)).raw.labels;
              if (!Array.isArray(raw))
                return yield* failure("The forge did not return the existing labels.");
              const current = raw
                .map((item) => (typeof item === "string" ? item : record(item).name))
                .filter((item): item is string => typeof item === "string");
              const labels = [...new Set([...current, ...(input.addLabels ?? [])])].filter(
                (item) => !input.removeLabels?.includes(item),
              );
              return { kind: "labels", labels } as const;
            }),
          );
        }
        if (input.requestReviewers) {
          const requested = input.requestReviewers;
          yield* run(() =>
            Effect.gen(function* () {
              const { raw } = yield* provider.getDetail(ref);
              const current = raw.requested_reviewers ?? raw.reviewers ?? raw.participants;
              if (!Array.isArray(current))
                return yield* failure("The forge did not return the existing reviewers.");
              const reviewerId = (item: unknown) => {
                const entry = record(item);
                const user = record(entry.user ?? item);
                const id =
                  ref.provider === "bitbucket"
                    ? user.uuid
                    : ref.provider === "github" || ref.provider === "forgejo"
                      ? user.login
                      : user.id;
                return typeof id === "string" || typeof id === "number" ? String(id) : null;
              };
              const existing = current
                .filter((item) => !record(item).role || record(item).role === "REVIEWER")
                .map(reviewerId);
              if (existing.some((id) => id === null))
                return yield* failure("The forge did not identify every existing reviewer.");
              let ids = requested;
              if (ref.provider !== "github" && ref.provider !== "forgejo") {
                const response = yield* provider.listReviewerCandidates(ref);
                const collection = Array.isArray(response)
                  ? response
                  : (record(response).values ?? record(response).value);
                if (!Array.isArray(collection))
                  return yield* failure("The forge did not return reviewer candidates.");
                ids = [];
                for (const name of requested) {
                  const matches = collection.filter((item) => {
                    const user = record(record(item).user ?? item);
                    return [
                      reviewerId(item),
                      user.username,
                      user.login,
                      user.nickname,
                      user.display_name,
                      user.displayName,
                      user.name,
                    ].some(
                      (value) =>
                        typeof value === "string" && value.toLowerCase() === name.toLowerCase(),
                    );
                  });
                  const candidates = [
                    ...new Set(matches.map(reviewerId).filter((id) => id !== null)),
                  ];
                  if (candidates.length !== 1)
                    return yield* failure(
                      "Choose an unambiguous reviewer from the forge's candidates.",
                    );
                  ids.push(candidates[0]!);
                }
              }
              return {
                kind: "reviewers",
                reviewers: [...new Set([...existing.filter((id) => id !== null), ...ids])],
              } as const;
            }),
          );
        }
        if (input.state)
          yield* runPayload({
            kind: "action",
            action: input.state === "open" ? "reopen" : "close",
          });
        if (input.ready !== undefined)
          yield* runPayload({ kind: "action", action: input.ready ? "ready" : "draft" });
      } else if (name === "pull_request_respond") {
        let replyTo: string | undefined;
        if (input.reviewThreadId) {
          const rawThreads = yield* provider.getReviewThreads(ref);
          const threads = forgeReviewThreads(rawThreads, provider);
          const discussion = threads.find((item) => item.id === input.reviewThreadId);
          if (!discussion || (input.body?.trim() && discussion.viewerCanReply === false))
            return yield* failure("The requested review thread is unavailable for this response.");
          if (ref.provider === "github") {
            const comments = rawThreads.find((item) => item.id === discussion.id)?.comments;
            const databaseId = Array.isArray(comments) ? record(comments[0]).databaseId : undefined;
            if (typeof databaseId === "number" && Number.isSafeInteger(databaseId))
              replyTo = String(databaseId);
          } else {
            replyTo = discussion.id;
          }
          if (input.body?.trim() && !replyTo)
            return yield* failure("The review thread has no reply target.");
        } else if (input.resolved !== undefined) {
          return yield* failure("Give the review thread ID when changing its resolution.");
        }
        if (input.body?.trim())
          yield* runPayload({ kind: "comment", body: input.body, ...(replyTo ? { replyTo } : {}) });
        if (input.reviewThreadId && input.resolved !== undefined)
          yield* runPayload({
            kind: "thread-state",
            threadId: input.reviewThreadId,
            resolved: input.resolved,
          });
      } else if (name === "pull_request_review") {
        if (input.comments?.length && ref.provider === "github") {
          const comments = input.comments;
          yield* run(() =>
            Effect.gen(function* () {
              const baseOid = forgeComparison(ref, detail)?.baseOid;
              if (!baseOid) return yield* failure("The current diff comparison is unavailable.");
              return {
                kind: "review",
                body: input.body ?? "",
                verdict: input.verdict,
                baseOid,
                comments: comments.map((comment) => ({ ...comment, side: comment.side ?? "new" })),
              } as const;
            }),
          );
        } else {
          if (input.comments?.length) {
            const baseOid = forgeComparison(ref, detail)?.baseOid;
            if (!baseOid) return yield* failure("The current diff comparison is unavailable.");
            for (const comment of input.comments)
              yield* runPayload({
                kind: "comment",
                ...comment,
                side: comment.side ?? "new",
                baseOid,
              });
          }
          if (input.verdict !== "comment" || input.body?.trim())
            yield* runPayload({ kind: "review", body: input.body ?? "", verdict: input.verdict });
        }
      }
      if (!operations.length) return yield* failure("Provide at least one change.");
      return { ...summarize(detail), key, operationId, operations };
    });
}
