import { createHash } from "node:crypto";
import { Effect, Layer, Schema, Semaphore, ServiceMap } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  ForgeOperation,
  PrHubPeek,
  ThreadPullRequestLink,
  ThreadId,
  type ForgeOperationInput,
  type ForgePrepareOperationInput,
  type PrHubPeekInput,
  type PrHubStackInput,
  type PrHubViewedFilesInput,
  type PrHubSetViewedFileInput,
} from "@t3tools/contracts";
import {
  parseSourceControlPullRequestKey,
  formatSourceControlPullRequestKey,
} from "@t3tools/shared/sourceControl";
import { ServerConfig } from "../config.ts";
import { SourceControlProviderError } from "../sourceControl/SourceControlProvider.ts";
import { PrHubFederation, type PrHubAccountRuntime } from "./Layers/PrHubFederation.ts";
import { forgeComparison } from "./forgeModel.ts";
import { readGitHubStack } from "./githubStacks.ts";
import { mapGitHubCliError } from "../sourceControl/GitHubSourceControlProvider.ts";

const failure = (detail: string, kind: SourceControlProviderError["kind"] = "generic") =>
  new SourceControlProviderError({
    provider: "github",
    operation: "prHub.extensions",
    kind,
    detail,
  });
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
const marker = (id: string, key: string, account: string) =>
  `<!-- f5-forge-operation:${createHash("sha256")
    .update(JSON.stringify([account, key, id]))
    .digest("hex")} -->`;
export class PrHubExtensions extends ServiceMap.Service<
  PrHubExtensions,
  Effect.Success<typeof makePrHubExtensions>
>()("t3/prHub/PrHubExtensions") {}
export const makePrHubExtensions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const federation = yield* PrHubFederation;
  const config = yield* ServerConfig;
  const gates = new Map<string, Semaphore.Semaphore>();
  const peekCache = new Map<string, { expires: number; value: PrHubPeek }>();
  const permit = yield* Semaphore.make(2);
  const db = <A, E>(value: Effect.Effect<A, E>) =>
    value.pipe(Effect.mapError(() => failure("PR Hub storage is unavailable.")));
  const refFor = (key: string) => {
    const ref = parseSourceControlPullRequestKey(key);
    return ref ? Effect.succeed(ref) : Effect.fail(failure("Invalid pull request reference."));
  };
  const resolve = (input: { key: string; accountGeneration?: string | undefined }) =>
    Effect.gen(function* () {
      const runtime = yield* federation.resolve(input);
      const ref = yield* refFor(input.key);
      if (ref.provider !== runtime.account.provider || ref.host !== runtime.account.host)
        return yield* failure("The account does not own this provider host.", "forbidden");
      const snapshot = yield* runtime.hub.getSnapshot;
      if (
        input.accountGeneration !== undefined &&
        snapshot.account?.generation !== input.accountGeneration
      )
        return yield* failure(
          "The account changed. Refresh PR Hub before continuing.",
          "forbidden",
        );
      return { runtime, ref };
    });
  const peek = (input: PrHubPeekInput) =>
    permit.withPermits(1)(
      Effect.gen(function* () {
        const ref = yield* federation.parseUrl(input.url);
        if (!ref) return null;
        const runtime = yield* federation.resolve(input);
        if (runtime.account.provider !== ref.provider || runtime.account.host !== ref.host)
          return yield* failure("Link preview account mismatch.", "forbidden");
        const identity = JSON.stringify([runtime.account.id, runtime.account.generation, ref]);
        const cached = peekCache.get(identity);
        if (cached && cached.expires > Date.now()) return cached.value;
        const detail = yield* runtime.provider.getDetail(ref);
        const value = yield* Schema.decodeUnknownEffect(PrHubPeek)({
          provider: ref.provider,
          host: ref.host,
          repository: ref.repository,
          number: ref.number,
          title: detail.title.slice(0, 1000),
          url: detail.url,
          state: detail.state ?? "open",
          author: null,
        }).pipe(Effect.mapError(() => failure("Invalid link preview.", "invalid_response")));
        peekCache.delete(identity);
        peekCache.set(identity, { expires: Date.now() + 60000, value });
        while (peekCache.size > 128) peekCache.delete(peekCache.keys().next().value!);
        return value;
      }),
    );
  const getStack = (input: PrHubStackInput) =>
    Effect.gen(function* () {
      const { runtime, ref } = yield* resolve(input);
      return runtime.github ? yield* readGitHubStack(runtime.github, config.cwd, ref) : null;
    });
  const getViewedFiles = (input: PrHubViewedFilesInput) =>
    Effect.gen(function* () {
      const { runtime } = yield* resolve(input);
      if (runtime.github) {
        const context = yield* runtime.github
          .getCredentialContext({ cwd: config.cwd, host: runtime.account.host })
          .pipe(Effect.mapError(mapGitHubCliError));
        const [owner, name] = (yield* refFor(input.key)).repository.split("/");
        const number = (yield* refFor(input.key)).number;
        const viewed: string[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 10; page++) {
          const response = yield* runtime.github
            .request({
              cwd: config.cwd,
              context,
              method: "POST",
              endpoint: "graphql",
              body: {
                query:
                  "query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid baseRefOid files(first:100,after:$cursor){nodes{path viewerViewedState} pageInfo{hasNextPage endCursor}}}}}",
                variables: { owner, name, number, cursor },
              },
            })
            .pipe(Effect.mapError(mapGitHubCliError));
          const body = response.body as {
            errors?: unknown[];
            data?: {
              repository?: {
                pullRequest?: {
                  headRefOid: string;
                  baseRefOid: string;
                  files?: {
                    nodes?: { path: string; viewerViewedState: string }[];
                    pageInfo?: { hasNextPage: boolean; endCursor?: string };
                  };
                };
              };
            };
          };
          if (response.status >= 400 || body?.errors?.length)
            return yield* failure("GitHub viewed-file read failed.", "invalid_response");
          const pr = body?.data?.repository?.pullRequest;
          if (!pr || pr.headRefOid !== input.headOid || pr.baseRefOid !== input.baseOid) return [];
          for (const file of pr.files?.nodes ?? [])
            if (file.viewerViewedState === "VIEWED") viewed.push(file.path);
          if (!pr.files?.pageInfo?.hasNextPage) return viewed;
          const next = pr.files.pageInfo.endCursor;
          if (!next || next === cursor)
            return yield* failure("Invalid viewed-file cursor.", "invalid_response");
          cursor = next;
        }
        return yield* failure(
          "The viewed-file connection exceeds the bounded read limit.",
          "unsupported",
        );
      }
      return (yield* db(
        sql<{
          path: string;
        }>`SELECT path FROM pr_hub_viewed_files WHERE account_id=${runtime.account.id} AND pr_key=${input.key} AND head_oid=${input.headOid} AND base_oid=${input.baseOid}`,
      )).map((row) => row.path);
    });
  const setViewedFile = (input: PrHubSetViewedFileInput) =>
    Effect.gen(function* () {
      const { runtime, ref } = yield* resolve(input);
      const detail = yield* runtime.provider.getDetail(ref);
      const comparison = forgeComparison(ref, detail);
      if (
        detail.headRefOid !== input.headOid ||
        !comparison ||
        comparison.baseOid !== input.baseOid
      )
        return yield* failure(
          "The file revision changed. Refresh before marking it viewed.",
          "forbidden",
        );
      if (runtime.github) {
        const context = yield* runtime.github
          .getCredentialContext({ cwd: config.cwd, host: ref.host })
          .pipe(Effect.mapError(mapGitHubCliError));
        const id = detail.raw.node_id;
        const response = yield* runtime.github
          .request({
            cwd: config.cwd,
            context,
            method: "POST",
            endpoint: "graphql",
            body: {
              query: `mutation($id:ID!,$path:String!){${input.viewed ? "markFileAsViewed" : "unmarkFileAsViewed"}(input:{pullRequestId:$id,path:$path}){pullRequest{id}}}`,
              variables: { id, path: input.path },
            },
          })
          .pipe(Effect.mapError(mapGitHubCliError));
        const result = response.body as { errors?: unknown[]; data?: Record<string, unknown> };
        if (
          response.status >= 400 ||
          result?.errors?.length ||
          !result?.data?.[input.viewed ? "markFileAsViewed" : "unmarkFileAsViewed"]
        )
          return yield* failure(
            "GitHub did not confirm the viewed-file update.",
            "invalid_response",
          );
      } else if (input.viewed)
        yield* db(
          sql`INSERT INTO pr_hub_viewed_files(account_id,pr_key,path,head_oid,base_oid) VALUES(${runtime.account.id},${input.key},${input.path},${input.headOid},${input.baseOid}) ON CONFLICT DO NOTHING`,
        );
      else
        yield* db(
          sql`DELETE FROM pr_hub_viewed_files WHERE account_id=${runtime.account.id} AND pr_key=${input.key} AND path=${input.path} AND head_oid=${input.headOid} AND base_oid=${input.baseOid}`,
        );
      return yield* getViewedFiles(input);
    });
  const getThreadLinks = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const rows = yield* db(
        sql`SELECT provider,host,repository,number,title,url FROM projection_thread_pull_requests WHERE thread_id=${threadId} ORDER BY updated_at DESC LIMIT 50`,
      );
      return yield* Schema.decodeUnknownEffect(Schema.Array(ThreadPullRequestLink))(rows).pipe(
        Effect.mapError(() => failure("Invalid stored pull request links.")),
      );
    });
  const getThreadsForPr = (key: string) =>
    Effect.gen(function* () {
      const ref = yield* refFor(key);
      const rows = yield* db(
        sql<{
          threadId: string;
          title: string;
        }>`SELECT t.thread_id AS "threadId", t.title FROM projection_thread_pull_requests p JOIN projection_threads t ON t.thread_id=p.thread_id WHERE p.provider=${ref.provider} AND p.host=${ref.host} AND p.repository=${ref.repository} AND p.number=${ref.number} AND t.deleted_at IS NULL ORDER BY t.created_at DESC LIMIT 50`,
      );
      return rows.map((row) => ({ ...row, threadId: ThreadId.makeUnsafe(row.threadId) }));
    });
  const validate = (runtime: PrHubAccountRuntime, input: ForgePrepareOperationInput) => {
    const p = input.payload,
      caps = runtime.provider.forgeCapabilities;
    let supported = false;
    switch (p.kind) {
      case "stack":
        supported = caps.stacks && caps.stackActions;
        break;
      case "action":
        supported =
          caps.actions.includes(p.action) &&
          (!p.method ||
            (p.action === "update-branch" ? caps.updateMethods : caps.mergeMethods).includes(
              p.method,
            ));
        break;
      case "comment":
        supported =
          caps.comment &&
          (!p.path || caps.review.inlineComment) &&
          (!p.replyTo || caps.review.reply);
        break;
      case "review":
        supported = caps.review.verdicts.includes(p.verdict);
        break;
      case "edit":
        supported = caps.edit.changeRequest;
        break;
      case "edit-comment":
        supported = caps.edit.comment;
        break;
      case "reviewers":
        supported = caps.reviewers.request;
        break;
      case "labels":
        supported = caps.labels;
        break;
      case "reaction":
        supported = caps.reactions;
        break;
      case "thread-state":
        supported = caps.review.resolve;
        break;
    }
    return supported
      ? Effect.void
      : Effect.fail(failure("This forge does not advertise this operation.", "unsupported"));
  };
  const load = (accountId: string, id: string) =>
    Effect.gen(function* () {
      const rows = yield* db(
        sql<{
          payloadJson: string;
          status: ForgeOperation["status"];
          progressJson: string | null;
          resultJson: string | null;
        }>`SELECT payload_json AS "payloadJson",status,progress_json AS "progressJson",result_json AS "resultJson" FROM forge_operations WHERE account_id=${accountId} AND operation_id=${id}`,
      );
      if (!rows[0]) return null;
      const operation = yield* Schema.decodeUnknownEffect(ForgeOperation)({
        ...JSON.parse(rows[0].payloadJson),
        status: rows[0].status,
        ...(rows[0].resultJson ? JSON.parse(rows[0].resultJson) : {}),
      }).pipe(Effect.mapError(() => failure("Invalid saved operation.")));
      return {
        operation,
        progress: rows[0].progressJson
          ? (JSON.parse(rows[0].progressJson) as {
              commentDone?: boolean;
              verdictStarted?: boolean;
              uuid?: string;
              completed?: number;
            })
          : {},
      };
    });
  const prepareOperation = (input: ForgePrepareOperationInput) =>
    Effect.gen(function* () {
      const { runtime, ref } = yield* resolve(input);
      yield* validate(runtime, input);
      const detail = yield* runtime.provider.getDetail(ref);
      if (!input.expectedHeadOid || detail.headRefOid !== input.expectedHeadOid)
        return yield* failure(
          "The pull request changed. Refresh before preparing the operation.",
          "forbidden",
        );
      const prior = yield* load(runtime.account.id, input.operationId);
      if (prior) {
        if (
          canonical({ ...prior.operation, status: undefined, error: undefined }) !==
          canonical({ ...input, status: undefined, error: undefined })
        )
          return yield* failure(
            "The operation ID is already bound to another payload.",
            "forbidden",
          );
        return prior.operation;
      }
      const key = formatSourceControlPullRequestKey(ref);
      const pending = yield* db(
        sql`SELECT operation_id FROM forge_operations WHERE account_id=${runtime.account.id} AND pr_key=${key} AND status IN ('running','outcome_unknown')`,
      );
      if (pending.length)
        return yield* failure(
          "Resolve the existing operation before preparing another for this pull request.",
          "forbidden",
        );
      yield* db(
        sql`INSERT INTO forge_operations(account_id,operation_id,pr_key,payload_json,status) VALUES(${runtime.account.id},${input.operationId},${key},${JSON.stringify(input)},'prepared') ON CONFLICT DO NOTHING`,
      );
      return (yield* load(runtime.account.id, input.operationId))!.operation;
    });
  const update = (account: string, id: string, status: ForgeOperation["status"], error?: string) =>
    db(
      sql`UPDATE forge_operations SET status=${status},result_json=${error ? JSON.stringify({ error }) : null} WHERE account_id=${account} AND operation_id=${id}`,
    );
  const progress = (account: string, id: string, value: unknown) =>
    db(
      sql`UPDATE forge_operations SET progress_json=${JSON.stringify(value)} WHERE account_id=${account} AND operation_id=${id}`,
    );
  const gateFor = (account: string) =>
    Effect.gen(function* () {
      let gate = gates.get(account);
      if (!gate) {
        gate = yield* Semaphore.make(1);
        gates.set(account, gate);
      }
      return gate;
    });
  const submitOperation = (input: ForgeOperationInput) =>
    Effect.gen(function* () {
      const { runtime, ref } = yield* resolve(input);
      const gate = yield* gateFor(runtime.account.id);
      return yield* gate.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const saved = yield* load(runtime.account.id, input.operationId);
            if (
              !saved ||
              saved.operation.key !== input.key ||
              saved.operation.accountGeneration !== input.accountGeneration
            )
              return yield* failure("Saved operation identity mismatch.", "forbidden");
            if (saved.operation.status !== "prepared") return saved.operation;
            yield* validate(runtime, saved.operation);
            const detail = yield* runtime.provider.getDetail(ref);
            if (detail.headRefOid !== saved.operation.expectedHeadOid)
              return yield* failure(
                "The pull request changed. Prepare a new operation.",
                "forbidden",
              );
            const p = saved.operation.payload,
              id = input.operationId,
              account = runtime.account.id;
            const claimed = yield* db(
              sql`UPDATE forge_operations SET status='running' WHERE account_id=${account} AND operation_id=${id} AND status='prepared' RETURNING operation_id`,
            );
            if (!claimed.length) return (yield* load(account, id))!.operation;
            const tag = marker(id, input.key, account);
            const commentBody = (body: string) => `${body}\n\n${tag}`;
            let dispatched = 0;
            const dispatch = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              Effect.suspend(() => {
                dispatched++;
                return effect;
              });
            const run = Effect.gen(function* () {
              switch (p.kind) {
                case "comment":
                  return yield* dispatch(
                    runtime.provider.writeComment({
                      ref,
                      body: commentBody(p.body),
                      ...(p.path
                        ? {
                            path: p.path,
                            ...(p.line === undefined ? {} : { line: p.line }),
                            ...(p.side === undefined ? {} : { side: p.side }),
                            headSha: saved.operation.expectedHeadOid,
                            baseSha: String(
                              detail.raw.diff_refs && typeof detail.raw.diff_refs === "object"
                                ? ((detail.raw.diff_refs as { base_sha?: string }).base_sha ?? "")
                                : "",
                            ),
                            startSha: String(
                              detail.raw.diff_refs && typeof detail.raw.diff_refs === "object"
                                ? ((detail.raw.diff_refs as { start_sha?: string }).start_sha ?? "")
                                : "",
                            ),
                          }
                        : {}),
                      ...(p.replyTo ? { replyTo: p.replyTo } : {}),
                    }),
                  );
                case "review": {
                  const separated = ref.provider === "gitlab" || ref.provider === "bitbucket";
                  if (
                    separated &&
                    p.verdict !== "comment" &&
                    p.body.trim() &&
                    !saved.progress.commentDone
                  ) {
                    yield* dispatch(
                      runtime.provider.writeComment({ ref, body: commentBody(p.body) }),
                    );
                    saved.progress.commentDone = true;
                    yield* progress(account, id, saved.progress);
                  }
                  saved.progress.verdictStarted = true;
                  yield* progress(account, id, saved.progress);
                  return yield* dispatch(
                    runtime.provider.submitReview({
                      ref,
                      body: separated && p.verdict !== "comment" ? "" : commentBody(p.body),
                      verdict: p.verdict,
                      headSha: saved.operation.expectedHeadOid,
                    }),
                  );
                }
                case "action":
                  return yield* dispatch(
                    runtime.provider.performAction({
                      ref,
                      action: p.action,
                      ...(p.method ? { method: p.method } : {}),
                      expectedHeadOid: saved.operation.expectedHeadOid,
                    }),
                  );
                case "edit":
                  return yield* dispatch(
                    runtime.provider.editChangeRequest({
                      ref,
                      ...(p.title === undefined ? {} : { title: p.title }),
                      ...(p.body === undefined ? {} : { body: p.body }),
                    }),
                  );
                case "edit-comment":
                  return yield* dispatch(
                    runtime.provider.editComment({
                      ref,
                      commentId: p.commentId,
                      body: p.body,
                    }),
                  );
                case "reviewers":
                  return yield* dispatch(
                    runtime.provider.setReviewers({ ref, reviewers: p.reviewers }),
                  );
                case "labels":
                  return yield* dispatch(runtime.provider.setLabels({ ref, labels: p.labels }));
                case "reaction":
                  return yield* dispatch(
                    runtime.provider.react({
                      ref,
                      content: p.content,
                      ...(p.commentId ? { commentId: p.commentId } : {}),
                      ...(p.remove === undefined ? {} : { remove: p.remove }),
                      ...(p.reactionId ? { reactionId: p.reactionId } : {}),
                    }),
                  );
                case "thread-state":
                  return yield* dispatch(
                    runtime.provider.resolveThread({
                      ref,
                      threadId: p.threadId,
                      resolved: p.resolved,
                    }),
                  );
                case "stack": {
                  if (!runtime.github)
                    return yield* failure("This forge does not have stacks.", "unsupported");
                  const stack = yield* readGitHubStack(runtime.github, config.cwd, ref);
                  if (!stack || stack.fingerprint !== p.fingerprint)
                    return yield* failure(
                      "The stack changed. Refresh before trying again.",
                      "forbidden",
                    );
                  const targetIndex = stack.layers.findIndex(
                    (layer) => layer.number === ref.number,
                  );
                  if (targetIndex < 0)
                    return yield* failure(
                      "The pull request is no longer in this stack.",
                      "forbidden",
                    );
                  const affected = (
                    p.action === "merge" ? stack.layers.slice(0, targetIndex + 1) : stack.layers
                  ).filter((layer) => layer.state !== "merged");
                  if (
                    !affected.length ||
                    affected.some((layer) => layer.state !== "open" || layer.isDraft)
                  )
                    return yield* failure(
                      "Only open, ready stack layers can be changed.",
                      "forbidden",
                    );
                  for (const layer of affected) {
                    const current = yield* runtime.provider.getDetail({
                      ...ref,
                      number: layer.number,
                    });
                    if (
                      current.headRefOid !== layer.headOid ||
                      current.state !== "open" ||
                      current.raw.draft === true
                    )
                      return yield* failure(
                        "A stack layer changed. Refresh before continuing.",
                        "forbidden",
                      );
                  }
                  if (p.action === "merge") {
                    const context = yield* runtime.github
                      .getCredentialContext({ cwd: config.cwd, host: ref.host })
                      .pipe(Effect.mapError(mapGitHubCliError));
                    dispatched++;
                    const response = yield* runtime.github
                      .request({
                        cwd: config.cwd,
                        context,
                        method: "PUT",
                        endpoint: `repos/${ref.repository}/pulls/${ref.number}/merge-async`,
                        body: {
                          merge_method: p.method,
                          merge_action: "default",
                          sha: saved.operation.expectedHeadOid,
                        },
                      })
                      .pipe(Effect.mapError(mapGitHubCliError));
                    const result = response.body as {
                      status?: string;
                      details?: { uuid?: string };
                    };
                    if (response.status >= 400)
                      return yield* failure("GitHub refused the stack merge.");
                    if (result?.status === "pending") {
                      yield* progress(account, id, { uuid: result.details?.uuid });
                      return yield* failure("The stack merge is still running on GitHub.");
                    }
                    if (result?.status !== "merged" && result?.status !== "enqueued")
                      return yield* failure("The stack merge outcome is uncertain.");
                    return null;
                  }
                  // Rebase is remote-only. Each completed layer remains recorded on failure.
                  if (stack.layers.at(-1)?.number !== ref.number)
                    return yield* failure(
                      "Rebase must start at the top of the stack.",
                      "unsupported",
                    );
                  const processed: { number: number; headOid: string }[] = [];
                  for (const [index, layer] of affected.entries()) {
                    for (const prior of processed) {
                      const observed = yield* runtime.provider.getDetail({
                        ...ref,
                        number: prior.number,
                      });
                      if (observed.headRefOid !== prior.headOid)
                        return yield* failure(
                          `A previously rebased layer changed after ${index} layers. Refresh before continuing.`,
                        );
                    }
                    const current = yield* runtime.provider.getDetail({
                      ...ref,
                      number: layer.number,
                    });
                    if (current.headRefOid !== layer.headOid)
                      return yield* failure(
                        `The stack changed after ${index} layers. Refresh before continuing.`,
                      );
                    yield* dispatch(
                      runtime.provider.performAction({
                        ref: { ...ref, number: layer.number },
                        action: "update-branch",
                        method: "rebase",
                        expectedHeadOid: layer.headOid,
                      }),
                    );
                    const after = yield* runtime.provider.getDetail({
                      ...ref,
                      number: layer.number,
                    });
                    if (!after.headRefOid)
                      return yield* failure("GitHub did not return the rebased revision.");
                    processed.push({ number: layer.number, headOid: after.headRefOid });
                    yield* progress(account, id, { completed: index + 1 });
                  }
                  return null;
                }
              }
            });
            const outcome = yield* Effect.result(run.pipe(Effect.timeout("30 seconds")));
            if (outcome._tag === "Success") yield* update(account, id, "succeeded");
            else {
              const error = outcome.failure;
              const definitelyUnsent =
                dispatched === 0 ||
                (dispatched === 1 &&
                  Schema.is(SourceControlProviderError)(error) &&
                  error.requestDispatched === false);
              yield* update(
                account,
                id,
                definitelyUnsent ? "failed" : "outcome_unknown",
                definitelyUnsent
                  ? Schema.is(SourceControlProviderError)(error)
                    ? error.detail
                    : "The operation was not dispatched."
                  : "The outcome could not be confirmed. Check this saved operation before preparing another.",
              );
            }
            return (yield* load(account, id))!.operation;
          }),
        ),
      );
    });
  const getOperation = (input: ForgeOperationInput) =>
    resolve(input).pipe(
      Effect.flatMap(({ runtime }) => load(runtime.account.id, input.operationId)),
      Effect.flatMap((row) =>
        row && row.operation.key !== input.key
          ? Effect.fail(failure("Saved operation identity mismatch.", "forbidden"))
          : Effect.succeed(row?.operation ?? null),
      ),
    );
  const cancelOperation = (input: ForgeOperationInput) =>
    Effect.gen(function* () {
      const { runtime } = yield* resolve(input);
      const saved = yield* getOperation(input);
      if (!saved) return yield* failure("Saved operation not found.", "not_found");
      yield* db(
        sql`UPDATE forge_operations SET status='canceled' WHERE account_id=${runtime.account.id} AND operation_id=${input.operationId} AND status='prepared'`,
      );
      return (yield* getOperation(input))!;
    });
  const recoverOperation = (input: ForgeOperationInput) =>
    Effect.gen(function* () {
      const { runtime, ref } = yield* resolve(input);
      const saved = yield* load(runtime.account.id, input.operationId);
      if (!saved || saved.operation.key !== input.key)
        return yield* failure("Saved operation not found.", "not_found");
      if (!["running", "outcome_unknown"].includes(saved.operation.status)) return saved.operation;
      const p = saved.operation.payload;
      const tag = marker(input.operationId, input.key, runtime.account.id);
      if (p.kind === "comment" || p.kind === "review") {
        const comments = yield* runtime.provider.getComments(ref);
        const matchingComment = (value: unknown): boolean => {
          if (!value || typeof value !== "object") return false;
          const c = value as Record<string, unknown>;
          const a = (c.user ?? c.author ?? c.createdBy) as Record<string, unknown> | undefined;
          const authorId = a?.id ?? a?.uuid ?? a?.account_id;
          const login = a?.login ?? a?.username ?? a?.nickname;
          const ownAuthor =
            authorId !== undefined
              ? String(authorId) === runtime.account.viewerId
              : typeof login === "string" && login === runtime.account.login;
          const content = c.content as Record<string, unknown> | undefined;
          const body = c.body ?? c.note ?? c.text ?? content?.raw;
          if (ownAuthor && typeof body === "string" && body.includes(tag)) return true;
          return [c.notes, c.comments].some(
            (items) => Array.isArray(items) && items.some(matchingComment),
          );
        };
        const found = comments.some(matchingComment);
        if (
          found &&
          p.kind === "review" &&
          (ref.provider === "gitlab" || ref.provider === "bitbucket") &&
          p.verdict !== "comment"
        ) {
          if (!saved.progress.verdictStarted) {
            yield* progress(runtime.account.id, input.operationId, { commentDone: true });
            yield* update(runtime.account.id, input.operationId, "prepared");
          }
          // A dispatched verdict requires direct host evidence; never infer it from its comment.
        } else if (found) yield* update(runtime.account.id, input.operationId, "succeeded");
      } else if (p.kind === "stack" && saved.progress.uuid && runtime.github) {
        const context = yield* runtime.github
          .getCredentialContext({ cwd: config.cwd, host: ref.host })
          .pipe(Effect.mapError(mapGitHubCliError));
        const response = yield* runtime.github
          .request({
            cwd: config.cwd,
            context,
            method: "GET",
            endpoint: `repos/${ref.repository}/pulls/${ref.number}/merge-async/${encodeURIComponent(saved.progress.uuid)}`,
          })
          .pipe(Effect.mapError(mapGitHubCliError));
        if (["merged", "enqueued"].includes((response.body as { status?: string })?.status ?? ""))
          yield* update(runtime.account.id, input.operationId, "succeeded");
      } else {
        const detail = yield* runtime.provider.getDetail(ref);
        const observed =
          p.kind === "edit"
            ? (p.title === undefined || detail.title === p.title) &&
              (p.body === undefined || detail.body === p.body)
            : p.kind === "action"
              ? (p.action === "merge" && detail.state === "merged") ||
                (p.action === "close" && detail.state === "closed") ||
                (p.action === "reopen" && detail.state === "open")
              : false;
        if (observed) yield* update(runtime.account.id, input.operationId, "succeeded");
      }
      const result = (yield* load(runtime.account.id, input.operationId))!.operation;
      if (result.status === "running")
        yield* update(
          runtime.account.id,
          input.operationId,
          "outcome_unknown",
          "The server stopped before confirmation. Verify the result on the forge; this operation will not be resent automatically.",
        );
      return (yield* load(runtime.account.id, input.operationId))!.operation;
    });
  const listReviewerCandidates = (input: PrHubStackInput) =>
    resolve(input).pipe(
      Effect.flatMap(({ runtime, ref }) =>
        Effect.gen(function* () {
          const detail = yield* runtime.provider.getDetail(ref);
          const candidatesSupported = runtime.provider.forgeCapabilities.reviewers.listCandidates;
          const candidates = candidatesSupported
            ? yield* runtime.provider.listReviewerCandidates(ref)
            : [];
          return {
            candidates,
            candidatesSupported,
            currentReviewers:
              detail.raw.reviewers ??
              detail.raw.requested_reviewers ??
              detail.raw.participants ??
              [],
          };
        }),
      ),
    );
  return {
    peek,
    getStack,
    getViewedFiles,
    setViewedFile,
    getThreadLinks,
    getThreadsForPr,
    prepareOperation,
    submitOperation,
    getOperation,
    recoverOperation,
    cancelOperation,
    listReviewerCandidates,
  };
});
export const PrHubExtensionsLive = Layer.effect(PrHubExtensions, makePrHubExtensions);
