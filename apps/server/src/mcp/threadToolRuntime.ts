import type { ThreadSettlementService } from "../orchestration/Layers/ThreadSettlementService.ts";
import type { PullRequestWatchService } from "../orchestration/Layers/PullRequestWatchService.ts";
import type { makeHtmlRenderRuntime } from "../htmlRender/HtmlRenderRuntime.ts";
import { MessageId, PullRequestKey, type ThreadId } from "@t3tools/contracts";
import { Effect, Option } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  formatSourceControlPullRequestKey,
  parseSourceControlPullRequestKey,
} from "@t3tools/shared/sourceControl";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { PrHubFederationShape } from "../prHub/Layers/PrHubFederation.ts";
import type { PrHubReviewGuideService } from "../prHub/Layers/PrHubReviewGuideService.ts";
import type { PrHubExtensions } from "../prHub/PrHubExtensions.ts";
import {
  hasHumanThreadReferenceGrant,
  workflowRequirementReferences,
} from "../orchestration/threadReferenceGrants.ts";
import { truncateUtf8 } from "../orchestration/threadTranscript.ts";
import type { ProjectionThreadMessageRepositoryShape } from "../persistence/Services/ProjectionThreadMessages.ts";
import type { ProjectionThreadProposedPlanRepositoryShape } from "../persistence/Services/ProjectionThreadProposedPlans.ts";
import {
  THREAD_READ_RESULT_MAX_BYTES,
  ThreadToolError,
  type ThreadReadInput,
  type ThreadToolHandler,
} from "./threadMcpTools.ts";

export function makeThreadToolHandler(input: {
  readonly engine: Pick<OrchestrationEngineShape, "getReadModel">;
  readonly federation: Pick<PrHubFederationShape, "resolve" | "parseUrl">;
  readonly settlement: Pick<ThreadSettlementService["Service"], "settleFromAgent">;
  readonly watches: Pick<PullRequestWatchService["Service"], "startWatch" | "stopWatch">;
  readonly guides: PrHubReviewGuideService["Service"];
  readonly html: Effect.Success<ReturnType<typeof makeHtmlRenderRuntime>>;
  readonly links: Pick<PrHubExtensions["Service"], "getThreadLinks">;
  readonly messages: ThreadReadDependencies["messages"];
  readonly plans: ThreadReadDependencies["plans"];
  readonly sql: SqlClient.SqlClient;
}): ThreadToolHandler {
  return (threadId, request) =>
    Effect.gen(function* () {
      const model = yield* input.engine.getReadModel();
      const thread = model.threads.find((value) => value.id === threadId && !value.deletedAt);
      if (!thread)
        return yield* new ThreadToolError({ message: "This thread is no longer available." });
      if (request.name === "thread_read")
        return yield* readReferencedThread(input, threadId, request.input);
      if (request.name === "thread_settle")
        return yield* input.settlement.settleFromAgent(threadId);
      if (request.name === "thread_status")
        return {
          threadId,
          title: thread.title,
          archivedAt: thread.archivedAt,
          settledAt: thread.settledAt ?? null,
          settledBy: thread.settledBy ?? null,
          autoSettleDisabled: thread.autoSettleDisabled ?? false,
          pinnedAt: thread.pinnedAt,
          snoozedUntil: thread.snoozedUntil,
          latestTurn: thread.latestTurn,
          sessionStatus: thread.session?.status ?? null,
        };
      if (request.name === "html_preview")
        return yield* input.html.preview(threadId, request.input);
      if (request.name === "html_render") return yield* input.html.publish(threadId, request.input);
      if (request.name === "watch_pull_request" || request.name === "unwatch_pull_request") {
        const target = { threadId, ...(request.pr ? { pr: request.pr } : {}) };
        return request.name === "watch_pull_request"
          ? yield* input.watches.startWatch(target)
          : yield* input.watches.stopWatch(target).pipe(Effect.as({ stopped: true }));
      }
      if (thread.archivedAt && request.name === "pull_request_review_guide_write")
        return yield* new ThreadToolError({
          message: "Unarchive this thread before starting a guide.",
        });
      const links = yield* input.links.getThreadLinks(threadId);
      const parsed = request.pr
        ? (parseSourceControlPullRequestKey(request.pr) ??
          (yield* input.federation.parseUrl(request.pr)))
        : links.length === 1
          ? links[0]
          : null;
      if (!parsed)
        return yield* new ThreadToolError({
          message: "Specify a PR URL or key, or link exactly one PR to this thread.",
        });
      const key = PullRequestKey.makeUnsafe(formatSourceControlPullRequestKey(parsed));
      // Capture the verified account incarnation before starting any remote guide operation.
      const runtime = yield* input.federation.resolve({ key });
      const target = { key, accountGeneration: runtime.account.generation };
      return yield* request.name === "pull_request_review_guide_write"
        ? input.guides.generate(target)
        : input.guides.get({ ...target, mode: "force" });
    }).pipe(
      Effect.mapError(
        () =>
          new ThreadToolError({
            message:
              "Thread tool failed. Check the PR target, account and current thread, then retry.",
          }),
      ),
    );
}

type ThreadReadRefusalReason =
  | "self"
  | "not_referenced"
  | "not_found"
  | "invalid_cursor"
  | "invalid_item";

const THREAD_READ_DEFAULT_LIMIT = 20;
/** Budget for one page's plan and messages, in bytes of serialized JSON. */
const THREAD_READ_PAGE_BUDGET_BYTES = 20 * 1024;
const THREAD_READ_PREVIEW_MAX_BYTES = 4 * 1024;
const THREAD_READ_ITEM_MAX_BYTES = 16 * 1024;

const refusal = (reason: ThreadReadRefusalReason, message: string) => ({
  ok: false as const,
  reason,
  message,
});

const codePointLength = (text: string) => {
  let length = 0;
  for (const _ of text) length++;
  return length;
};
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
/** Bytes the result takes once wrapped as MCP tool text, so escaping counts twice. */
const toolResultBytes = (value: unknown) =>
  jsonBytes({ content: [{ type: "text", text: JSON.stringify(value) }] });

/**
 * Bytes `text` takes inside the MCP result: the result is JSON carried as the text of a JSON
 * content block, so escaping counts twice.
 */
const toolTextBytes = (text: string) => jsonBytes(JSON.stringify(text));

/** The longest prefix of `text` that takes at most `maxBytes` inside the MCP result. */
function prefixWithinToolTextBytes(text: string, maxBytes: number): string {
  const first = truncateUtf8(text, maxBytes).text;
  if (toolTextBytes(first) <= maxBytes) return first;
  const points = Array.from(first);
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (toolTextBytes(points.slice(0, middle).join("")) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return points.slice(0, low).join("");
}

const THREAD_READ_MAX_ATTACHMENTS = 10;
/** Attachment names and types only, bounded so one row can never fill a page by itself. */
function boundedAttachments(
  attachments: ReadonlyArray<{ readonly name: string; readonly type: string }>,
) {
  if (attachments.length === 0) return {};
  return {
    attachments: attachments.slice(0, THREAD_READ_MAX_ATTACHMENTS).map((attachment) => ({
      name: prefixWithinToolTextBytes(attachment.name, 160),
      type: prefixWithinToolTextBytes(attachment.type, 64),
    })),
    ...(attachments.length > THREAD_READ_MAX_ATTACHMENTS
      ? { attachmentCount: attachments.length }
      : {}),
  };
}

const encodeCursor = (row: { readonly createdAt: string; readonly messageId: string }) =>
  Buffer.from(JSON.stringify({ createdAt: row.createdAt, messageId: row.messageId })).toString(
    "base64url",
  );
function decodeCursor(value: string): { createdAt: string; messageId: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "createdAt" in parsed &&
      "messageId" in parsed &&
      typeof parsed.createdAt === "string" &&
      typeof parsed.messageId === "string" &&
      parsed.createdAt.length > 0 &&
      parsed.createdAt.length <= 64 &&
      parsed.messageId.length > 0 &&
      parsed.messageId.length <= 256
    )
      return { createdAt: parsed.createdAt, messageId: parsed.messageId };
  } catch {
    // Fall through: anything that is not a cursor this tool wrote is refused.
  }
  return null;
}

/** A preview of `text` (already cut to a code-point bound in SQL) with continuation metadata. */
function previewOf(text: string, totalLength: number) {
  const preview = prefixWithinToolTextBytes(text, THREAD_READ_PREVIEW_MAX_BYTES);
  const kept = codePointLength(preview);
  return kept < totalLength
    ? { text: preview, truncated: true as const, totalLength, nextOffset: kept }
    : { text: preview };
}

const boundedText = (value: string | null, maxBytes: number) =>
  value === null ? null : truncateUtf8(value, maxBytes).text;

/**
 * `thread_read`: one page of a thread the caller's user referenced, or one chunk of a message or
 * plan in it. Every call re-checks authorization. Refusals are values so the agent can explain
 * them; only repository failures are errors.
 */
export const readReferencedThread = Effect.fn("readReferencedThread")(function* (
  input: ThreadReadDependencies,
  callerThreadId: ThreadId,
  request: ThreadReadInput,
) {
  const targetThreadId = request.threadId;
  if (targetThreadId === callerThreadId)
    return refusal("self", "This is the current thread; it is already in your context.");
  const model = yield* input.engine.getReadModel();
  const authorized =
    workflowRequirementReferences(model, callerThreadId).includes(targetThreadId) ||
    (yield* hasHumanThreadReferenceGrant(input.sql, {
      threadId: callerThreadId,
      targetThreadId,
    }));
  if (!authorized)
    return refusal(
      "not_referenced",
      "The user has not referenced this thread in a message they sent here, so it cannot be read.",
    );
  const target = model.threads.find((thread) => thread.id === targetThreadId);
  const project = target
    ? model.projects.find((entry) => entry.id === target.projectId && entry.deletedAt === null)
    : undefined;
  if (!target || target.deletedAt !== null || !project)
    return refusal("not_found", "The referenced thread no longer exists.");
  const threadId = target.id;

  if (request.item) {
    const { kind, id } = request.item;
    const offset = request.item.offset ?? 0;
    if (id.trim() !== id || !Number.isSafeInteger(offset) || offset < 0)
      return refusal("invalid_item", "Pass an item id and nextOffset from an earlier result.");
    const value: {
      readonly role?: string;
      readonly text: string;
      readonly totalLength: number;
      readonly isStreaming?: boolean;
      readonly createdAt: string;
      readonly updatedAt: string;
    } | null =
      kind === "message"
        ? Option.getOrNull(
            yield* input.messages.getContextItem({
              threadId,
              messageId: MessageId.makeUnsafe(id),
              offset,
            }),
          )
        : Option.getOrNull(yield* input.plans.getContextItem({ threadId, planId: id, offset }));
    if (value === null || (offset > 0 && offset >= value.totalLength))
      return refusal("invalid_item", "That message or plan is not in the referenced thread.");
    const text = prefixWithinToolTextBytes(value.text, THREAD_READ_ITEM_MAX_BYTES);
    const end = offset + codePointLength(text);
    return {
      ok: true as const,
      threadId,
      item: {
        kind,
        id,
        ...(value.role !== undefined ? { role: value.role } : {}),
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
        isStreaming: value.isStreaming ?? false,
        offset,
        totalLength: value.totalLength,
        text,
        nextOffset: end < value.totalLength ? end : null,
      },
    };
  }

  let before: { createdAt: string; messageId: string } | undefined;
  if (request.before !== undefined) {
    const decoded = decodeCursor(request.before);
    if (!decoded)
      return refusal("invalid_cursor", "Pass the olderCursor from an earlier thread_read result.");
    before = decoded;
  }
  const limit = request.limit ?? THREAD_READ_DEFAULT_LIMIT;
  const plan = before === undefined ? yield* input.plans.getLatestContext(threadId) : Option.none();
  const rows = yield* input.messages.listContextPage({
    threadId,
    ...(before ? { before } : {}),
    limit,
  });

  const latestPlan = Option.isSome(plan)
    ? {
        id: plan.value.planId,
        createdAt: plan.value.createdAt,
        implementedAt: plan.value.implementedAt,
        ...previewOf(plan.value.text, plan.value.totalLength),
      }
    : null;
  const base = {
    ok: true as const,
    threadId,
    title: prefixWithinToolTextBytes(target.title, 512),
    project: { id: project.id, title: prefixWithinToolTextBytes(project.title, 512) },
    branch: boundedText(target.branch, 512),
    worktreePath: boundedText(target.worktreePath, 1024),
    archived: target.archivedAt !== null,
    latestTurnState: target.latestTurn?.state ?? null,
    latestPlan,
  };
  // Newest first, stopping at the first row that does not fit. Every field is bounded, so the
  // newest row always fits and each page advances the cursor.
  const kept: Array<{
    readonly row: (typeof rows)[number];
    readonly entry: Record<string, unknown>;
  }> = [];
  let used = latestPlan ? jsonBytes(latestPlan) : 0;
  const candidates = rows.slice(0, limit);
  for (const row of candidates) {
    const entry = {
      id: row.messageId,
      role: row.role,
      createdAt: row.createdAt,
      ...(row.isStreaming ? { isStreaming: true } : {}),
      ...boundedAttachments(row.attachments),
      ...previewOf(row.text, row.totalLength),
    };
    const size = jsonBytes(entry);
    if (kept.length > 0 && used + size > THREAD_READ_PAGE_BUDGET_BYTES) break;
    const next = [...kept, { row, entry }];
    const oldest = next[next.length - 1]!.row;
    const probe = {
      ...base,
      messages: next.map((item) => item.entry),
      olderCursor: encodeCursor(oldest),
    };
    if (kept.length > 0 && toolResultBytes(probe) > THREAD_READ_RESULT_MAX_BYTES) break;
    kept.push({ row, entry });
    used += size;
  }
  const hasOlder = kept.length < candidates.length || rows.length > limit;
  const oldestKept = kept[kept.length - 1]?.row;
  return {
    ...base,
    messages: kept.map((item) => item.entry).reverse(),
    olderCursor: hasOlder && oldestKept ? encodeCursor(oldestKept) : null,
  };
});

interface ThreadReadDependencies {
  readonly engine: Pick<OrchestrationEngineShape, "getReadModel">;
  readonly messages: Pick<
    ProjectionThreadMessageRepositoryShape,
    "listContextPage" | "getContextItem"
  >;
  readonly plans: Pick<
    ProjectionThreadProposedPlanRepositoryShape,
    "getLatestContext" | "getContextItem"
  >;
  readonly sql: SqlClient.SqlClient;
}
