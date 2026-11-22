import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
  "getCheckLog" | "getChecks" | "getOperation" | "getStack" | "prepareOperation" | "submitOperation"
>;
const failure = (message: string) => new ThreadToolError({ message });
const limitText = (text: string, max: number) => truncateUtf8(text, max).text;

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
  readonly git: Pick<GitManagerShape, "status" | "branchPullRequest">;
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
      const repositoryRef = (repository?: string) =>
        Effect.gen(function* () {
          if (!workspace) return yield* failure("This thread has no repository workspace.");
          const status = yield* deps.git.status({ cwd: workspace });
          const identity = status.sourceControl;
          if (!identity?.host || !identity.owner || !identity.repository)
            return yield* failure("This thread's repository has no recognized forge.");
          const path = repository ?? [identity.owner, identity.repository].join("/");
          if (
            !/^[\w.-]+(?:\/[\w.-]+)+$/u.test(path) ||
            path.split("/").some((part) => part === "." || part === "..")
          )
            return yield* failure("Use a repository path such as owner/repository.");
          return {
            provider: identity.kind,
            host: identity.host,
            repository: path,
            number: 1,
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
      const key = PullRequestKey.makeUnsafe(formatSourceControlPullRequestKey(ref));
      const runtime = yield* resolve(ref);
      const provider = runtime.provider;
      const target = { key, accountGeneration: runtime.account.generation };
      if (name === "pull_request_read") {
        const sections =
          input.sections ?? (input.cursor ? ["conversation"] : ["summary", "checks"]);
        const summary = sections.includes("summary") ? yield* provider.getDetail(ref) : undefined;
        const checks = sections.includes("checks")
          ? yield* deps.extensions.getChecks(target)
          : undefined;
        const conversation = sections.includes("conversation")
          ? yield* Effect.gen(function* () {
              const rawThreads = yield* provider.getReviewThreads(ref);
              const threads = forgeReviewThreads(rawThreads, provider)
                .filter((item) => input.includeResolved || !item.isResolved)
                .map(({ comments, ...item }) => ({
                  ...item,
                  comments: comments.slice(0, 4).map(({ id, author, bodyText, url }) => ({
                    id,
                    author,
                    url,
                    body: limitText(bodyText, 500),
                  })),
                  moreComments: comments.length > 4 || item.commentsPageInfo?.hasNextPage === true,
                }));
              const page = pageWindow({
                items: threads,
                cursor: input.cursor,
                limit: 6,
                scope: [
                  runtime.account.generation,
                  key,
                  input.includeResolved ?? false,
                  threads.map((item) => item.id),
                ],
              });
              if (!page)
                return yield* failure(
                  "The review conversation changed. Start again without a cursor.",
                );
              const comments =
                page.offset === 0
                  ? forgeComments(yield* provider.getComments(ref))
                      .slice(0, 12)
                      .map((item) => ({
                        id: String(item.id),
                        author: record(item.author ?? item.user).login ?? null,
                        body: limitText(String(item.body ?? item.bodyText ?? ""), 500),
                      }))
                  : [];
              return {
                comments,
                reviewThreads: page.values,
                nextCursor: page.nextCursor,
              };
            })
          : undefined;
        const diff = sections.includes("diff") ? yield* provider.getDiff(ref) : undefined;
        return {
          key,
          ...(summary
            ? { summary: { ...summarize(summary), body: limitText(summary.body, 3500) } }
            : {}),
          ...(checks ? { checks } : {}),
          ...(conversation ? { conversation } : {}),
          ...(diff !== undefined
            ? { diff: limitText(diff, 12_000), diffTruncated: Buffer.byteLength(diff) > 12_000 }
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
              Effect.map(({ excerpt, ...log }) => ({
                ...log,
                name: item.name,
                excerpt:
                  excerpt === null
                    ? null
                    : limitText(
                        excerpt
                          .split("\n")
                          .slice(-(input.tailLines ?? 200))
                          .join("\n"),
                        3000,
                      ),
              })),
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
      const operations: Array<{ id: string; status: string; warning?: string | undefined }> = [];
      const operationId = input.operationId ?? randomUUID();
      const operationKey = createHash("sha256")
        .update(JSON.stringify([thread.id, operationId]))
        .digest("hex");
      const run = (payload: ForgeMutationPayload) =>
        Effect.gen(function* () {
          const args = { ...target, operationId: operationKey + ":" + operations.length };
          const prior = yield* deps.extensions.getOperation(args);
          if (
            prior &&
            (prior.operationId !== args.operationId ||
              prior.expectedHeadOid !== headSha ||
              !isDeepStrictEqual(prior.payload, payload))
          )
            return yield* failure(
              "This operation ID already belongs to a different revision or change.",
            );
          if (!prior)
            yield* deps.extensions.prepareOperation({ ...args, expectedHeadOid: headSha, payload });
          const operation = yield* deps.extensions.submitOperation(args);
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

      if (name === "pull_request_merge") {
        if (input.expectedHeadSha !== headSha)
          return yield* failure(
            "The pull request head changed. Review the current revision before merging.",
          );
        if (input.stack) {
          if (input.auto) return yield* failure("Automatic merging is unavailable for a stack.");
          const stack = yield* deps.extensions.getStack(target);
          if (!stack) return yield* failure("This pull request has no available GitHub stack.");
          yield* run({
            kind: "stack",
            action: "merge",
            method: input.method ?? "merge",
            fingerprint: stack.fingerprint,
          });
        } else {
          yield* run({
            kind: "action",
            action: input.auto ? "enable-auto-merge" : "merge",
            ...(input.method ? { method: input.method } : {}),
          });
        }
      } else if (name === "ci_rerun") {
        let workflowRunId: number | undefined;
        if (input.check) {
          const checks = yield* deps.extensions.getChecks({ ...target, mode: "force" });
          const matching = checks.checks.filter(
            (item) =>
              (item.name === input.check || item.id === input.check) && item.status === "failure",
          );
          const ids = new Set(matching.map((item) => Number(item.workflowRunId)));
          if (
            checks.headOid !== headSha ||
            ids.size !== 1 ||
            ![...ids].every((id) => Number.isSafeInteger(id) && id > 0)
          )
            return yield* failure("Choose one failed GitHub Actions check on the current head.");
          workflowRunId = [...ids][0];
        }
        yield* run({
          kind: "action",
          action: "rerun-failed-checks",
          ...(workflowRunId ? { workflowRunId } : {}),
        });
      } else if (name === "pull_request_update") {
        if (input.title !== undefined || input.body !== undefined)
          yield* run({
            kind: "edit",
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.body === undefined ? {} : { body: input.body }),
          });
        if (input.addLabels || input.removeLabels) {
          const raw = detail.raw.labels;
          if (!Array.isArray(raw))
            return yield* failure("The forge did not return the existing labels.");
          const current = raw
            .map((item) => (typeof item === "string" ? item : record(item).name))
            .filter((item): item is string => typeof item === "string");
          const labels = [...new Set([...current, ...(input.addLabels ?? [])])].filter(
            (item) => !input.removeLabels?.includes(item),
          );
          yield* run({ kind: "labels", labels });
        }
        if (input.requestReviewers) {
          const current = detail.raw.requested_reviewers ?? detail.raw.reviewers;
          if (!Array.isArray(current))
            return yield* failure("The forge did not return the existing reviewers.");
          const identities = current.flatMap((item) => {
            const reviewer = record(item);
            const identity = reviewer.login ?? reviewer.uuid ?? reviewer.id;
            return typeof identity === "string" || typeof identity === "number"
              ? [String(identity)]
              : [];
          });
          yield* run({
            kind: "reviewers",
            reviewers: [...new Set([...identities, ...input.requestReviewers])],
          });
        }
        if (input.state)
          yield* run({ kind: "action", action: input.state === "open" ? "reopen" : "close" });
        if (input.ready !== undefined)
          yield* run({ kind: "action", action: input.ready ? "ready" : "draft" });
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
          yield* run({ kind: "comment", body: input.body, ...(replyTo ? { replyTo } : {}) });
        if (input.reviewThreadId && input.resolved !== undefined)
          yield* run({
            kind: "thread-state",
            threadId: input.reviewThreadId,
            resolved: input.resolved,
          });
      } else if (name === "pull_request_review") {
        if (input.comments?.length) {
          const baseOid = forgeComparison(ref, detail)?.baseOid;
          if (!baseOid) return yield* failure("The current diff comparison is unavailable.");
          for (const comment of input.comments)
            yield* run({ kind: "comment", ...comment, side: comment.side ?? "new", baseOid });
        }
        if (input.verdict !== "comment" || input.body?.trim())
          yield* run({ kind: "review", body: input.body ?? "", verdict: input.verdict });
      }
      if (!operations.length) return yield* failure("Provide at least one change.");
      return { ...summarize(detail), key, operationId, operations };
    });
}
