import { buildNewThreadSubmission } from "../turnSubmission.ts";
import { projectProviderSnapshots } from "@t3tools/shared/serverSettings";
import { isListedModel, pickPreferredModel } from "@t3tools/shared/model";
/**
 * Agent Bridge thread tools: read exposed projects, threads, and diffs, and
 * create threads or queue turns. Every bridge turn runs supervised
 * (`approval-required`); agents never answer approvals or control running work.
 *
 * @module agentBridge/threadTools
 */
import {
  AGENT_BRIDGE_TURN_SUBMITTED_ACTIVITY_KIND,
  BOOTSTRAP_THREAD_DELETED_ERROR_CODE,
  BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE,
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  isKnownProviderKind,
  isProviderAvailable,
  MessageId,
  ProjectId,
  ThreadId,
  type TurnId,
  type AgentBridgeScope,
  type ClientThreadTurnStartCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ProviderKind,
  type ServerProvider,
  type ServerSettings,
  type TurnSubmissionIntent,
  type TurnSubmissionResult,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { runtimeModeCapabilities } from "@t3tools/shared/runtimeMode";
import {
  Clock,
  Data,
  Deferred,
  Duration,
  Effect,
  Schema,
  SchemaIssue,
  Semaphore,
  Stream,
} from "effect";

import { canonicalJsonHash } from "../canonicalJsonHash.ts";
import type { AgentBridgeHostShape } from "./AgentBridgeHost.ts";
import type {
  AgentBridgeClientRecord,
  AgentBridgeRequestRecord,
  AgentBridgeStore,
} from "./AgentBridgeStore.ts";
import { AGENT_BRIDGE_LIMITS, type AgentBridgeLimiters } from "./rateLimits.ts";

export const AGENT_BRIDGE_PROMPT_MAX_BYTES = 32 * 1024;
export const AGENT_BRIDGE_MESSAGE_MAX_BYTES = 32 * 1024;
export const AGENT_BRIDGE_DIFF_MAX_BYTES = 200 * 1024;
export const AGENT_BRIDGE_RECENT_MESSAGES = 50;
export const AGENT_BRIDGE_MAX_WAIT_SECONDS = 45;
const SUMMARY_MAX_BYTES = 1024;
const WAIT_POLL_MS = 5_000;
export const AGENT_BRIDGE_COMMAND_PREFIX = "agent-bridge:";

const WORKSPACE_NOTE =
  "F5 is a coding-workspace service. This tool works only inside F5 and does not control your computer.";

export class AgentBridgeToolError extends Data.TaggedError("AgentBridgeToolError")<{
  readonly message: string;
  readonly retryAfterSeconds?: number;
  /** Set when the credential lacks a scope; surfaced as `insufficient_scope`. */
  readonly requiredScope?: AgentBridgeScope;
}> {}

export interface AgentBridgeCaller {
  readonly client: AgentBridgeClientRecord;
  /** Exposed projects intersected with the client's allowlist. */
  readonly visibleProjectIds: ReadonlySet<string>;
}

export interface AgentBridgeToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly scope: AgentBridgeScope;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: false;
    readonly idempotentHint: boolean;
    readonly openWorldHint: false;
  };
  readonly run: (
    args: unknown,
    caller: AgentBridgeCaller,
  ) => Effect.Effect<unknown, AgentBridgeToolError>;
}

export interface ThreadToolsDeps {
  readonly host: AgentBridgeHostShape;
  readonly store: AgentBridgeStore;
  readonly limiters: AgentBridgeLimiters;
  readonly mintId?: () => string;
  readonly now?: () => Date;
  /** Called after a receipt write so the UI can refetch. */
  readonly onWorkspaceChanged?: (revision: number, affectedIds: ReadonlyArray<string>) => void;
}

// ── helpers ──────────────────────────────────────────────────────────

export function truncateUtf8(
  text: string,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  const bytes = Buffer.from(text, "utf8").subarray(0, maxBytes);
  // Drop a trailing partial multi-byte sequence.
  return { text: bytes.toString("utf8").replace(/�+$/u, ""), truncated: true };
}

const toolError = (message: string, extra?: { retryAfterSeconds?: number }) =>
  new AgentBridgeToolError({ message, ...extra });

const notFound = (kind: string) => toolError(`${kind} not found.`);

const decodeArgs =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (args: unknown): Effect.Effect<S["Type"], AgentBridgeToolError> =>
    Schema.decodeUnknownEffect(schema)(args ?? {}).pipe(
      Effect.mapError((error) =>
        toolError(`Invalid arguments: ${SchemaIssue.makeFormatterDefault()(error.issue)}`),
      ),
    );

export function supportsSupervisedTurns(driver: string): boolean {
  return isKnownProviderKind(driver) && runtimeModeCapabilities(driver).has("approval-required");
}

const providerLabel = (provider: ServerProvider) => provider.displayName ?? provider.instanceId;

/**
 * Whether a turn sent now could start: the same rule as the model picker.
 * `isProviderAvailable` alone only says the driver exists in this build; a
 * CLI that is not installed or not signed in reports `installed: false` or
 * status `error`.
 */
export function isProviderUsable(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    isProviderAvailable(provider) &&
    provider.status !== "error" &&
    provider.status !== "disabled"
  );
}

function visibleThread(
  snapshot: OrchestrationReadModel,
  caller: AgentBridgeCaller,
  threadId: string,
): OrchestrationThread | undefined {
  return snapshot.threads.find(
    (thread) =>
      thread.id === threadId &&
      thread.deletedAt === null &&
      caller.visibleProjectIds.has(thread.projectId),
  );
}

interface PendingApprovalSummary {
  readonly requestKind: string;
  readonly detail: string | null;
  readonly createdAt: string;
}

/** Open approvals, read-only: agents can see that F5 is waiting, never answer. */
export function pendingApprovalSummaries(
  thread: OrchestrationThread,
): ReadonlyArray<PendingApprovalSummary> {
  const open = new Map<string, PendingApprovalSummary>();
  const ordered = [...thread.activities].toSorted(
    (left, right) =>
      (left.sequence ?? 0) - (right.sequence ?? 0) || left.createdAt.localeCompare(right.createdAt),
  );
  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (!requestId) continue;
    if (activity.kind === "approval.requested") {
      const detail = typeof payload?.detail === "string" ? payload.detail : null;
      open.set(requestId, {
        requestKind: typeof payload?.requestKind === "string" ? payload.requestKind : "unknown",
        detail: detail === null ? null : truncateUtf8(detail, SUMMARY_MAX_BYTES).text,
        createdAt: activity.createdAt,
      });
    } else if (activity.kind === "approval.resolved") {
      open.delete(requestId);
    }
  }
  return [...open.values()];
}

function threadStatus(thread: OrchestrationThread): string {
  if ((thread.pendingUserInputs?.length ?? 0) > 0) return "awaiting-input";
  if (pendingApprovalSummaries(thread).length > 0) return "awaiting-approval";
  if (thread.latestTurn?.state === "running") return "running";
  return thread.session?.status ?? "idle";
}

const isThreadRunning = (thread: OrchestrationThread) =>
  thread.latestTurn?.state === "running" ||
  thread.session?.status === "running" ||
  thread.session?.status === "starting";

// ── submission status ────────────────────────────────────────────────

export const SUBMISSION_STATUSES = [
  "queued",
  "preparing-worktree",
  "blocked",
  "running",
  "awaiting-approval",
  "awaiting-input",
  "completed",
  "failed",
  "interrupted",
  "rejected",
] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

/** Streamed output never changes a submission's status, so it does not wake waiters. */
const isStreamingOutput = (event: OrchestrationEvent) =>
  (event.type === "thread.message-sent" && event.payload.streaming) ||
  event.type === "thread.command-execution-output-appended" ||
  event.type === "thread.usage-recorded";

/** Statuses a waiter keeps waiting through. */
const IN_FLIGHT_STATUSES = new Set<SubmissionStatus>(["queued", "preparing-worktree", "running"]);

export interface SubmissionStatusResult {
  readonly submissionId: string;
  readonly threadId: string;
  readonly status: SubmissionStatus;
  readonly reason?: string;
  readonly turnId?: string;
}

// ── tool argument schemas ────────────────────────────────────────────

const ClientRequestId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9._:-]+$/u),
);
const Prompt = Schema.String.check(
  Schema.isMinLength(1),
  Schema.makeFilter(
    (value: string) =>
      Buffer.byteLength(value, "utf8") <= AGENT_BRIDGE_PROMPT_MAX_BYTES ||
      `Prompts are limited to ${AGENT_BRIDGE_PROMPT_MAX_BYTES / 1024} KB.`,
  ),
);

const ListThreadsArgs = Schema.Struct({
  projectId: Schema.optional(Schema.String),
  createdByMe: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
const ThreadArgs = Schema.Struct({ threadId: Schema.String });
const ThreadDiffArgs = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.optional(Schema.String),
});
const CreateThreadArgs = Schema.Struct({
  projectId: Schema.String,
  prompt: Prompt,
  title: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  providerInstanceId: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  useWorktree: Schema.optional(Schema.Boolean),
  interactionMode: Schema.optional(Schema.Literals(["default", "plan"])),
  clientRequestId: Schema.optional(ClientRequestId),
});
const SendMessageArgs = Schema.Struct({
  threadId: Schema.String,
  prompt: Prompt,
  clientRequestId: Schema.optional(ClientRequestId),
});
const WaitArgs = Schema.Struct({
  submissionId: Schema.String,
  timeoutSeconds: Schema.optional(
    Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: AGENT_BRIDGE_MAX_WAIT_SECONDS })),
  ),
});

const stringProp = (description: string, extra: Record<string, unknown> = {}) => ({
  type: "string",
  description,
  ...extra,
});
const objectSchema = (
  properties: Record<string, unknown>,
  required: ReadonlyArray<string> = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});
const CLIENT_REQUEST_ID_PROP = stringProp(
  "Optional idempotency key. Retrying with the same key returns the original result; reusing it with different arguments fails. Generated when omitted.",
  { maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" },
);
const PROMPT_PROP = stringProp("The message to send, up to 32 KB.", { minLength: 1 });

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const writes = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

// ── tools ─────────────────────────────────────────────────────────────

export const resolveBridgeProvider = (
  providers: ReadonlyArray<ServerProvider>,
  settings: ServerSettings,
  requested: { readonly instanceId?: string; readonly model?: string },
): Effect.Effect<{ provider: ServerProvider; model: string }, AgentBridgeToolError> =>
  Effect.gen(function* () {
    const usable = providers.filter(isProviderUsable);
    const textDefault = settings.textGenerationModelSelection;
    let provider: ServerProvider | undefined;
    if (requested.instanceId !== undefined) {
      const requestedProvider = providers.find(
        (entry) => entry.enabled && entry.instanceId === requested.instanceId,
      );
      if (!requestedProvider) return yield* toolError("Provider not found or not enabled.");
      if (!isProviderUsable(requestedProvider))
        return yield* toolError(
          `${providerLabel(requestedProvider)} is not ready in F5 (not installed, not signed in, or failing its health check).`,
        );
      provider = requestedProvider;
      if (!supportsSupervisedTurns(provider.driver))
        return yield* toolError(
          `${providerLabel(provider)} cannot run supervised turns, so the Agent Bridge cannot use it.`,
        );
    } else {
      provider =
        usable.find(
          (entry) =>
            entry.instanceId === textDefault.instanceId && supportsSupervisedTurns(entry.driver),
        ) ?? usable.find((entry) => supportsSupervisedTurns(entry.driver));
      if (!provider) return yield* toolError("No ready provider in F5 supports supervised turns.");
    }
    if (requested.model !== undefined) {
      if (
        provider.models.length > 0 &&
        !provider.models.some((model) => model.slug === requested.model && isListedModel(model))
      )
        return yield* toolError(`Unknown model for ${providerLabel(provider)}.`);
      return { provider, model: requested.model };
    }
    // The text-generation setting picks the provider only: its model is the
    // small one F5 uses for titles and commit messages, not for coding turns.
    const driverDefault = isKnownProviderKind(provider.driver)
      ? DEFAULT_MODEL_BY_PROVIDER[provider.driver as ProviderKind]
      : undefined;
    const model =
      pickPreferredModel(provider.models, driverDefault ? [driverDefault] : [])?.slug ??
      (provider.models.length === 0 ? driverDefault : undefined);
    if (!model) return yield* toolError(`${providerLabel(provider)} reports no models.`);
    return { provider, model };
  });

export const decodeAgentBridgeArgs = decodeArgs;

export function makeThreadTools(deps: ThreadToolsDeps): ReadonlyArray<AgentBridgeToolDefinition> {
  const { host, store, limiters } = deps;
  const mintId = deps.mintId ?? (() => crypto.randomUUID());
  const now = deps.now ?? (() => new Date());
  const notify = (revision: number, affectedIds: ReadonlyArray<string>) =>
    Effect.sync(() => deps.onWorkspaceChanged?.(revision, affectedIds));

  const hostError = Effect.mapError((error: { readonly message: string }) =>
    toolError(error.message),
  );
  const storeError = Effect.mapError(() =>
    toolError("F5 could not record this request. Try again."),
  );
  const snapshot = host.readSnapshot.pipe(hostError);

  const requireThread = (caller: AgentBridgeCaller, threadId: string) =>
    snapshot.pipe(
      Effect.flatMap((model) => {
        const thread = visibleThread(model, caller, threadId);
        return thread ? Effect.succeed({ model, thread }) : Effect.fail(notFound("Thread"));
      }),
    );

  // ── idempotent turn submission ──

  interface Admission {
    readonly command: ClientThreadTurnStartCommand;
    readonly submissionId: string;
    readonly threadId: string;
    readonly intent: TurnSubmissionIntent;
    readonly createsThread: boolean;
  }

  interface InflightSubmission {
    readonly clientId: string;
    readonly argsHash: string;
    readonly done: Deferred.Deferred<unknown, AgentBridgeToolError>;
    /** Set once admitted; counted by the limits until the queue holds it. */
    admitted?: Admission;
  }
  const inflight = new Map<string, InflightSubmission>();

  // Admission checks and the limits they count run one at a time, so a burst
  // of requests with different clientRequestIds cannot all pass a check
  // before any of them is admitted.
  const admissionLock = Semaphore.makeUnsafe(1);

  /** Admitted submissions of this process that the queue may not show yet. */
  const inflightAdmissions = () =>
    [...inflight.values()].flatMap((entry) =>
      entry.admitted ? [{ clientId: entry.clientId, admission: entry.admitted }] : [],
    );

  const isSettledRejection = (error: { readonly code?: string }) =>
    error.code === BOOTSTRAP_THREAD_NOT_CREATED_ERROR_CODE ||
    error.code === BOOTSTRAP_THREAD_DELETED_ERROR_CODE;

  /**
   * Why a stored command may no longer be submitted, or null. Retries of a
   * pending receipt skip `admit`, so access is checked again here.
   */
  const revokedReason = (caller: AgentBridgeCaller, admission: Admission) =>
    snapshot.pipe(
      Effect.map((model) => {
        if (admission.createsThread) {
          const projectId = admission.command.bootstrap?.createThread?.projectId;
          const shared = model.projects.some(
            (project) =>
              project.id === projectId &&
              project.deletedAt === null &&
              caller.visibleProjectIds.has(project.id),
          );
          return shared ? null : "The project is no longer shared with this client.";
        }
        const thread = visibleThread(model, caller, admission.threadId);
        if (!thread) return "The thread is no longer shared with this client.";
        if (thread.runtimeMode !== "approval-required")
          return "The thread is no longer supervised.";
        return null;
      }),
    );

  const submitOnce = (input: {
    readonly caller: AgentBridgeCaller;
    readonly tool: string;
    readonly requestId: string;
    readonly argsHash: string;
    readonly entry: InflightSubmission;
    readonly admit: Effect.Effect<Admission, AgentBridgeToolError>;
    readonly consume: () => void;
  }): Effect.Effect<unknown, AgentBridgeToolError> =>
    Effect.gen(function* () {
      const namespace = input.caller.client.id;
      const conflict = toolError(
        "That clientRequestId was already used with different arguments. Use a new clientRequestId.",
      );
      type Receipt =
        | { readonly kind: "completed"; readonly result: unknown }
        | { readonly kind: "resumed" | "admitted"; readonly admission: Admission };
      const fromExisting = (
        existing: AgentBridgeRequestRecord,
      ): Effect.Effect<Receipt, AgentBridgeToolError> =>
        Effect.gen(function* () {
          if (existing.tool !== input.tool || existing.argsHash !== input.argsHash)
            return yield* conflict;
          return existing.status === "completed"
            ? { kind: "completed", result: existing.result }
            : { kind: "resumed", admission: existing.command as Admission };
        });
      const existing = yield* store.getRequest(namespace, input.requestId).pipe(storeError);
      const receipt: Receipt = existing
        ? yield* fromExisting(existing)
        : yield* admissionLock.withPermits(1)(
            Effect.gen(function* () {
              const admission = yield* input.admit;
              const inserted = yield* store
                .insertPendingRequest({
                  namespace,
                  requestId: input.requestId,
                  tool: input.tool,
                  argsHash: input.argsHash,
                  command: admission,
                  relatedIds: {
                    threadId: admission.threadId,
                    submissionId: admission.submissionId,
                  },
                  ...(admission.createsThread
                    ? { createdThread: { threadId: admission.threadId, clientId: namespace } }
                    : {}),
                  at: now().toISOString(),
                })
                .pipe(storeError);
              if (!inserted.inserted) return yield* fromExisting(inserted.existing);
              input.entry.admitted = admission;
              input.consume();
              yield* notify(inserted.revision, [admission.threadId]);
              return { kind: "admitted", admission } satisfies Receipt;
            }),
          );
      if (receipt.kind === "completed") return receipt.result;
      const { admission } = receipt;
      input.entry.admitted = admission;

      // A resumed receipt may predate an unshare or a mode change. Once the
      // queue has accepted the submission, the retry only reads its result.
      const revoked =
        receipt.kind === "resumed" &&
        (yield* host
          .getSubmission(CommandId.makeUnsafe(admission.submissionId))
          .pipe(hostError)) === null
          ? yield* revokedReason(input.caller, admission)
          : null;

      // The stored command is identical on every retry, so the queue's
      // canonical hash matches and it replays its own result.
      const submitted =
        revoked !== null
          ? { ok: false as const, reason: revoked }
          : yield* host
              .submitTurnSubmission(
                {
                  submissionId: CommandId.makeUnsafe(admission.submissionId),
                  command: admission.command,
                  intent: admission.intent,
                },
                { submissionSource: "automation" },
              )
              .pipe(
                Effect.map((result) => ({ ok: true as const, result })),
                Effect.catch((error) =>
                  isSettledRejection(error)
                    ? Effect.succeed({ ok: false as const, reason: error.message })
                    : Effect.fail(toolError(error.message)),
                ),
              );

      const disposition = submitted.ok ? submissionDisposition(submitted.result) : "rejected";
      if (disposition !== "rejected") {
        const createdAt = now().toISOString();
        yield* host
          .dispatch({
            type: "thread.activity.append",
            commandId: CommandId.makeUnsafe(`bridge-activity:${admission.submissionId}`),
            threadId: ThreadId.makeUnsafe(admission.threadId),
            activity: {
              id: EventId.makeUnsafe(`bridge-activity:${admission.submissionId}`),
              tone: "info",
              kind: AGENT_BRIDGE_TURN_SUBMITTED_ACTIVITY_KIND,
              summary: `Sent by ${input.caller.client.name} via F5 Agent Bridge`,
              payload: {
                clientId: input.caller.client.id,
                clientName: input.caller.client.name,
                submissionId: admission.submissionId,
              },
              turnId: null,
              createdAt,
            },
            createdAt,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("agentBridge.activity.append.failed", {
                threadId: admission.threadId,
                submissionId: admission.submissionId,
                detail: error.message,
              }),
            ),
          );
      }
      const result = {
        ...(admission.createsThread ? { threadId: admission.threadId } : {}),
        submissionId: admission.submissionId,
        clientRequestId: input.requestId,
        disposition,
        ...(submitted.ok ? {} : { reason: submitted.reason }),
      };
      const revision = yield* store
        .completeRequest({
          namespace,
          requestId: input.requestId,
          result,
          at: now().toISOString(),
        })
        .pipe(storeError);
      yield* notify(revision, [admission.threadId]);
      return result;
    });

  /** Serializes concurrent callers per key; a joiner with other arguments is rejected. */
  const submitIdempotent = (input: {
    readonly caller: AgentBridgeCaller;
    readonly tool: string;
    readonly args: Record<string, unknown>;
    readonly clientRequestId: string | undefined;
    readonly admit: Effect.Effect<Admission, AgentBridgeToolError>;
    readonly consume: () => void;
  }): Effect.Effect<unknown, AgentBridgeToolError> =>
    Effect.gen(function* () {
      const requestId = input.clientRequestId ?? mintId();
      const { clientRequestId: _omitted, ...hashed } = input.args;
      const argsHash = canonicalJsonHash({ tool: input.tool, args: hashed });
      const key = `${input.caller.client.id}\u0000${requestId}`;
      const joined = inflight.get(key);
      if (joined) {
        if (joined.argsHash !== argsHash)
          return yield* toolError(
            "That clientRequestId was already used with different arguments. Use a new clientRequestId.",
          );
        return yield* Deferred.await(joined.done);
      }
      const entry: InflightSubmission = {
        clientId: input.caller.client.id,
        argsHash,
        done: yield* Deferred.make<unknown, AgentBridgeToolError>(),
      };
      inflight.set(key, entry);
      return yield* submitOnce({ ...input, requestId, argsHash, entry }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => inflight.delete(key)).pipe(
            Effect.andThen(Deferred.done(entry.done, exit)),
          ),
        ),
      );
    });

  /**
   * Bridge-created threads that hold work: running, or with their first turn
   * still being admitted, queued, or preparing its worktree.
   */
  const busyBridgeThreads = (model: OrchestrationReadModel) =>
    Effect.gen(function* () {
      const created = new Set(yield* store.listCreatedThreadIds().pipe(storeError));
      const busy = new Set(
        inflightAdmissions()
          .filter((entry) => entry.admission.createsThread)
          .map((entry) => entry.admission.threadId),
      );
      for (const thread of model.threads) {
        if (!created.has(thread.id) || thread.deletedAt !== null || busy.has(thread.id)) continue;
        if (isThreadRunning(thread)) {
          busy.add(thread.id);
          continue;
        }
        if (thread.latestTurn !== null) continue;
        const queue = yield* host.getQueueSnapshot(thread.id).pipe(hostError);
        if (
          queue.items.length > 0 &&
          queue.blockedKind !== "paused" &&
          queue.blockedKind !== "error"
        )
          busy.add(thread.id);
      }
      return busy.size;
    });

  // ── submission status ──

  /**
   * `knownTurns` caches submission → turn id for one waiter: once a turn has
   * started, the message never moves to another turn.
   */
  const submissionStatus = (
    caller: AgentBridgeCaller,
    submissionId: string,
    knownTurns: Map<string, TurnId> = new Map(),
  ): Effect.Effect<SubmissionStatusResult, AgentBridgeToolError> =>
    Effect.gen(function* () {
      const receipt = yield* store
        .findRequestBySubmissionId({ namespace: caller.client.id, submissionId })
        .pipe(storeError);
      const threadId = receipt?.relatedIds.threadId;
      if (!receipt || !threadId) return yield* notFound("Submission");
      const base = { submissionId, threadId };
      const stored = receipt.result as { disposition?: string; reason?: string } | null;
      if (stored?.disposition === "rejected")
        return {
          ...base,
          status: "rejected" as const,
          ...(stored.reason ? { reason: stored.reason } : {}),
        };
      const model = yield* snapshot;
      const thread = visibleThread(model, caller, threadId);
      if (!thread) {
        // A worktree send creates its thread before admission completes.
        return receipt.status === "pending"
          ? { ...base, status: "queued" as const }
          : yield* notFound("Thread");
      }
      const queue = yield* host.getQueueSnapshot(thread.id).pipe(hostError);
      const item = queue.items.find((entry) => entry.submissionId === submissionId);
      if (item) {
        if (queue.reasonCode === "worktree_setup")
          return { ...base, status: "preparing-worktree" as const };
        if (
          item.status === "failed" ||
          queue.blockedKind === "paused" ||
          queue.blockedKind === "error"
        )
          return {
            ...base,
            status: "blocked" as const,
            reason: queue.reasonDetail ?? queue.reasonCode ?? item.lastErrorDetail ?? "Blocked.",
          };
        return { ...base, status: "queued" as const };
      }
      const record = yield* host.getSubmission(CommandId.makeUnsafe(submissionId)).pipe(hostError);
      if (record === null || record.disposition === "pending" || record.disposition === "queued")
        return { ...base, status: "queued" as const };
      if (
        record.disposition === "canceled" ||
        record.disposition === "cleared" ||
        record.disposition === "rejected"
      )
        return {
          ...base,
          status: "rejected" as const,
          reason: record.reasonCode ?? record.disposition,
        };
      // Started: follow the turn that carries the submitted message.
      let turnId = knownTurns.get(submissionId) ?? null;
      if (turnId === null) {
        const details = yield* host.getThreadDetails(thread.id).pipe(hostError);
        turnId = details.messages.find((entry) => entry.id === record.messageId)?.turnId ?? null;
        if (turnId !== null) knownTurns.set(submissionId, turnId);
      }
      if (turnId === null) return { ...base, status: "running" as const };
      const withTurn = { ...base, turnId };
      if (thread.latestTurn?.turnId !== turnId) {
        // A later turn has started; report how this one ended.
        const state = yield* host.getTurnState({ threadId: thread.id, turnId }).pipe(hostError);
        switch (state) {
          case "completed":
            return { ...withTurn, status: "completed" as const };
          case "interrupted":
            return { ...withTurn, status: "interrupted" as const };
          case "error":
            return { ...withTurn, status: "failed" as const };
          default:
            return { ...withTurn, status: "running" as const };
        }
      }
      switch (thread.latestTurn.state) {
        case "completed":
          return { ...withTurn, status: "completed" as const };
        case "interrupted":
          return { ...withTurn, status: "interrupted" as const };
        case "error":
          return {
            ...withTurn,
            status: "failed" as const,
            ...(thread.session?.lastError ? { reason: thread.session.lastError } : {}),
          };
        case "running":
          if ((thread.pendingUserInputs?.length ?? 0) > 0)
            return { ...withTurn, status: "awaiting-input" as const };
          if (pendingApprovalSummaries(thread).length > 0)
            return { ...withTurn, status: "awaiting-approval" as const };
          return { ...withTurn, status: "running" as const };
      }
    });

  const waitForSubmission = (
    caller: AgentBridgeCaller,
    submissionId: string,
    timeoutSeconds: number,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const knownTurns = new Map<string, TurnId>();
        const first = yield* submissionStatus(caller, submissionId, knownTurns);
        if (!IN_FLIGHT_STATUSES.has(first.status) || timeoutSeconds <= 0)
          return {
            ...first,
            timedOut: timeoutSeconds <= 0 && IN_FLIGHT_STATUSES.has(first.status),
          };
        const release = limiters.waiters.acquire(caller.client.id);
        if (!release)
          return yield* toolError(
            `At most ${AGENT_BRIDGE_LIMITS.concurrentWaitersPerClient} waits may run at once.`,
            { retryAfterSeconds: 5 },
          );
        yield* Effect.addFinalizer(() => Effect.sync(release));
        let wake = yield* Deferred.make<void>();
        const signal = Effect.suspend(() => Deferred.succeed(wake, undefined)).pipe(Effect.asVoid);
        yield* host.queueChanges.pipe(
          Stream.filter((threadId) => threadId === first.threadId),
          Stream.runForEach(() => signal),
          Effect.forkScoped,
        );
        yield* host.domainEvents.pipe(
          Stream.filter(
            (event) => event.aggregateId === first.threadId && !isStreamingOutput(event),
          ),
          Stream.runForEach(() => signal),
          Effect.forkScoped,
        );
        const deadline = (yield* Clock.currentTimeMillis) + timeoutSeconds * 1000;
        while (true) {
          wake = yield* Deferred.make<void>();
          const status = yield* submissionStatus(caller, submissionId, knownTurns);
          if (!IN_FLIGHT_STATUSES.has(status.status)) return { ...status, timedOut: false };
          const remaining = deadline - (yield* Clock.currentTimeMillis);
          if (remaining <= 0) return { ...status, timedOut: true };
          yield* Deferred.await(wake).pipe(
            Effect.timeoutOption(Duration.millis(Math.min(remaining, WAIT_POLL_MS))),
          );
        }
      }),
    );

  // ── definitions ──

  const listProjects: AgentBridgeToolDefinition = {
    name: "list_projects",
    title: "List projects",
    description: `List the F5 projects shared with you. ${WORKSPACE_NOTE}`,
    scope: "f5.read",
    inputSchema: objectSchema({}),
    annotations: readOnly,
    run: (_args, caller) =>
      snapshot.pipe(
        Effect.map((model) => ({
          projects: model.projects
            .filter(
              (project) => project.deletedAt === null && caller.visibleProjectIds.has(project.id),
            )
            .map((project) => ({
              id: project.id,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
            })),
        })),
      ),
  };

  const listProviders: AgentBridgeToolDefinition = {
    name: "list_providers",
    title: "List providers",
    description: `List coding agents and models available globally or in an exposed project. Only providers with supportsSupervised can be used for bridge turns. ${WORKSPACE_NOTE}`,
    scope: "f5.read",
    inputSchema: objectSchema({
      projectId: stringProp("Use this exposed project's provider choices."),
    }),
    annotations: readOnly,
    run: (args, caller) =>
      Effect.gen(function* () {
        const input = yield* decodeArgs(
          Schema.Struct({ projectId: Schema.optionalKey(ProjectId) }),
        )(args);
        if (input.projectId) {
          const model = yield* snapshot;
          if (
            !caller.visibleProjectIds.has(input.projectId) ||
            !model.projects.some(
              (project) => project.id === input.projectId && project.deletedAt === null,
            )
          )
            return yield* notFound("Project");
        }
        const [providers, settings] = yield* Effect.all([
          host.listProviderInstances,
          host.getSettings.pipe(hostError),
        ]);
        return {
          providers: projectProviderSnapshots(providers, settings, input.projectId)
            .filter((provider) => provider.enabled)
            .map((provider) => ({
              instanceId: provider.instanceId,
              driver: provider.driver,
              displayName: providerLabel(provider),
              available: isProviderUsable(provider),
              supportsSupervised: supportsSupervisedTurns(provider.driver),
              models: provider.models
                .filter(isListedModel)
                .map((model) => ({ slug: model.slug, name: model.name })),
            })),
        };
      }),
  };

  const listThreads: AgentBridgeToolDefinition = {
    name: "list_threads",
    title: "List threads",
    description: `List recent threads in the projects shared with you, newest first. ${WORKSPACE_NOTE}`,
    scope: "f5.read",
    inputSchema: objectSchema({
      projectId: stringProp("Only threads in this project."),
      createdByMe: { type: "boolean", description: "Only threads this connection created." },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "Defaults to 20." },
    }),
    annotations: readOnly,
    run: (args, caller) =>
      Effect.gen(function* () {
        const input = yield* decodeArgs(ListThreadsArgs)(args);
        const model = yield* snapshot;
        const mine = input.createdByMe
          ? new Set(yield* store.listCreatedThreadIds(caller.client.id).pipe(storeError))
          : null;
        const threads = model.threads
          .filter(
            (thread) =>
              thread.deletedAt === null &&
              caller.visibleProjectIds.has(thread.projectId) &&
              (input.projectId === undefined || thread.projectId === input.projectId) &&
              (mine === null || mine.has(thread.id)),
          )
          .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .slice(0, input.limit ?? 20);
        return {
          threads: threads.map((thread) => ({
            id: thread.id,
            projectId: thread.projectId,
            title: thread.title,
            providerInstanceId:
              thread.modelSelection?.instanceId ?? thread.session?.providerInstanceId ?? null,
            model: thread.model,
            runtimeMode: thread.runtimeMode,
            status: threadStatus(thread),
            updatedAt: thread.updatedAt,
          })),
        };
      }),
  };

  const getThread: AgentBridgeToolDefinition = {
    name: "get_thread",
    title: "Get thread",
    description: `Read a thread: up to ${AGENT_BRIDGE_RECENT_MESSAGES} recent messages, the latest turn, its proposed plan, and a read-only summary of pending approvals. ${WORKSPACE_NOTE}`,
    scope: "f5.read",
    inputSchema: objectSchema({ threadId: stringProp("The thread id.") }, ["threadId"]),
    annotations: readOnly,
    run: (args, caller) =>
      Effect.gen(function* () {
        const input = yield* decodeArgs(ThreadArgs)(args);
        const { thread } = yield* requireThread(caller, input.threadId);
        const details = yield* host.getThreadDetails(thread.id).pipe(hostError);
        const recent = details.messages.slice(-AGENT_BRIDGE_RECENT_MESSAGES);
        const plan = thread.proposedPlans.at(-1);
        const planText = plan
          ? truncateUtf8(plan.planMarkdown, AGENT_BRIDGE_MESSAGE_MAX_BYTES)
          : null;
        return {
          id: thread.id,
          projectId: thread.projectId,
          title: thread.title,
          model: thread.model,
          runtimeMode: thread.runtimeMode,
          status: threadStatus(thread),
          olderMessagesOmitted: details.messages.length > recent.length,
          messages: recent.map((message) => {
            const text = truncateUtf8(message.text, AGENT_BRIDGE_MESSAGE_MAX_BYTES);
            return {
              id: message.id,
              role: message.role,
              text: text.text,
              truncated: text.truncated,
              turnId: message.turnId,
              createdAt: message.createdAt,
            };
          }),
          latestTurn: thread.latestTurn
            ? {
                turnId: thread.latestTurn.turnId,
                state: thread.latestTurn.state,
                startedAt: thread.latestTurn.startedAt,
                completedAt: thread.latestTurn.completedAt,
              }
            : null,
          proposedPlan:
            plan && planText
              ? { id: plan.id, markdown: planText.text, truncated: planText.truncated }
              : null,
          pendingApprovals: pendingApprovalSummaries(thread),
          awaitingInput: (thread.pendingUserInputs?.length ?? 0) > 0,
        };
      }),
  };

  const getThreadDiff: AgentBridgeToolDefinition = {
    name: "get_thread_diff",
    title: "Get thread diff",
    description: `Read the code changes a thread made, for the whole thread or one turn, capped at 200 KB. ${WORKSPACE_NOTE}`,
    scope: "f5.read",
    inputSchema: objectSchema(
      {
        threadId: stringProp("The thread id."),
        turnId: stringProp("Only this turn's changes."),
      },
      ["threadId"],
    ),
    annotations: readOnly,
    run: (args, caller) =>
      Effect.gen(function* () {
        const input = yield* decodeArgs(ThreadDiffArgs)(args);
        const { thread } = yield* requireThread(caller, input.threadId);
        let range: { fromTurnCount?: number; toTurnCount: number };
        if (input.turnId !== undefined) {
          const checkpoint = thread.checkpoints.find((entry) => entry.turnId === input.turnId);
          if (!checkpoint) return yield* notFound("Turn");
          range = {
            fromTurnCount: Math.max(0, checkpoint.checkpointTurnCount - 1),
            toTurnCount: checkpoint.checkpointTurnCount,
          };
        } else {
          range = {
            toTurnCount: thread.checkpoints.reduce(
              (max, entry) => Math.max(max, entry.checkpointTurnCount),
              0,
            ),
          };
        }
        const diff =
          range.toTurnCount === 0
            ? ""
            : yield* host.getThreadDiff({ threadId: thread.id, ...range }).pipe(hostError);
        const capped = truncateUtf8(diff, AGENT_BRIDGE_DIFF_MAX_BYTES);
        return {
          threadId: thread.id,
          ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
          diff: capped.text,
          truncated: capped.truncated,
        };
      }),
  };

  const createThread: AgentBridgeToolDefinition = {
    name: "create_thread",
    title: "Create thread",
    description: `Start a new F5 thread in a shared project with a first message. The turn always runs supervised: F5 asks its user before actions, and you cannot answer those approvals. Returns ids to pass to wait_for_submission. ${WORKSPACE_NOTE}`,
    scope: "f5.turns",
    inputSchema: objectSchema(
      {
        projectId: stringProp("The project id from list_projects."),
        prompt: PROMPT_PROP,
        title: stringProp("Thread title. Generated when omitted.", { maxLength: 200 }),
        providerInstanceId: stringProp(
          "A provider from list_providers with supportsSupervised. Defaults to F5's default provider.",
        ),
        model: stringProp("A model slug for that provider."),
        useWorktree: {
          type: "boolean",
          description:
            "Work in a separate git worktree (default true). Ignored for non-git projects.",
        },
        interactionMode: { type: "string", enum: ["default", "plan"] },
        clientRequestId: CLIENT_REQUEST_ID_PROP,
      },
      ["projectId", "prompt"],
    ),
    annotations: writes,
    run: (args, caller) =>
      Effect.gen(function* () {
        const input = yield* decodeArgs(CreateThreadArgs)(args);
        return yield* submitIdempotent({
          caller,
          tool: "create_thread",
          args: { ...input },
          clientRequestId: input.clientRequestId,
          consume: () => limiters.createThread.consume(caller.client.id),
          admit: Effect.gen(function* () {
            const model = yield* snapshot;
            const project = model.projects.find(
              (entry) =>
                entry.id === input.projectId &&
                entry.deletedAt === null &&
                caller.visibleProjectIds.has(entry.id),
            );
            if (!project) return yield* notFound("Project");
            const limited = limiters.createThread.check(caller.client.id);
            if (limited)
              return yield* toolError(
                `At most ${AGENT_BRIDGE_LIMITS.createThreadPerHour} threads per hour.`,
                { retryAfterSeconds: limited.retryAfterSeconds },
              );
            if ((yield* busyBridgeThreads(model)) >= AGENT_BRIDGE_LIMITS.runningBridgeThreadsGlobal)
              return yield* toolError(
                `F5 is busy: ${AGENT_BRIDGE_LIMITS.runningBridgeThreadsGlobal} bridge threads are already running.`,
                { retryAfterSeconds: 60 },
              );
            const [providers, settings] = yield* Effect.all([
              host.listProviderInstances,
              host.getSettings.pipe(hostError),
            ]);
            const { provider, model: modelSlug } = yield* resolveBridgeProvider(
              projectProviderSnapshots(providers, settings, project.id),
              settings,
              {
                ...(input.providerInstanceId !== undefined
                  ? { instanceId: input.providerInstanceId }
                  : {}),
                ...(input.model !== undefined ? { model: input.model } : {}),
              },
            );
            const branch = yield* host.getProjectGitBranch(project.workspaceRoot);
            const useWorktree = (input.useWorktree ?? true) && branch !== null;
            const createdAt = now().toISOString();
            const threadId = mintId();
            const submissionId = `${AGENT_BRIDGE_COMMAND_PREFIX}${mintId()}`;
            const modelSelection = createModelSelection(provider.instanceId, modelSlug);
            const interactionMode = input.interactionMode ?? "default";
            const command = buildNewThreadSubmission({
              project,
              threadId: ThreadId.makeUnsafe(threadId),
              commandId: CommandId.makeUnsafe(submissionId),
              messageId: MessageId.makeUnsafe(mintId()),
              prompt: input.prompt,
              modelSelection,
              runtimeMode: "approval-required",
              interactionMode,
              branch,
              useWorktree,
              createdAt,
              ...(input.title ? { title: input.title } : {}),
              ...(isKnownProviderKind(provider.driver) ? { provider: provider.driver } : {}),
            });
            return {
              command,
              submissionId,
              threadId,
              intent: "auto",
              createsThread: true,
            } satisfies Admission;
          }),
        });
      }),
  };

  const sendMessage: AgentBridgeToolDefinition = {
    name: "send_message",
    title: "Send message",
    description: `Queue a message at the end of an existing thread's queue. Only supervised threads accept bridge messages. ${WORKSPACE_NOTE}`,
    scope: "f5.turns",
    inputSchema: objectSchema(
      {
        threadId: stringProp("The thread id."),
        prompt: PROMPT_PROP,
        clientRequestId: CLIENT_REQUEST_ID_PROP,
      },
      ["threadId", "prompt"],
    ),
    annotations: writes,
    run: (args, caller) =>
      Effect.gen(function* () {
        const input = yield* decodeArgs(SendMessageArgs)(args);
        return yield* submitIdempotent({
          caller,
          tool: "send_message",
          args: { ...input },
          clientRequestId: input.clientRequestId,
          consume: () => limiters.sendMessage.consume(caller.client.id),
          admit: Effect.gen(function* () {
            const { thread } = yield* requireThread(caller, input.threadId);
            if (thread.runtimeMode !== "approval-required")
              return yield* toolError(
                "This thread is not supervised, so the Agent Bridge cannot send to it.",
              );
            const limited = limiters.sendMessage.check(caller.client.id);
            if (limited)
              return yield* toolError(
                `At most ${AGENT_BRIDGE_LIMITS.sendMessagePerHour} messages per hour.`,
                { retryAfterSeconds: limited.retryAfterSeconds },
              );
            const queue = yield* host.getQueueSnapshot(thread.id).pipe(hostError);
            const mine = new Set(
              yield* store
                .listSubmissionIdsForThread({ namespace: caller.client.id, threadId: thread.id })
                .pipe(storeError),
            );
            // Admitted messages the queue does not show yet count too.
            const waiting = new Set(
              queue.items
                .filter((item) => mine.has(item.submissionId))
                .map((item) => item.submissionId as string),
            );
            for (const entry of inflightAdmissions())
              if (entry.clientId === caller.client.id && entry.admission.threadId === thread.id)
                waiting.add(entry.admission.submissionId);
            if (waiting.size >= AGENT_BRIDGE_LIMITS.queuedBridgeItemsPerThread)
              return yield* toolError(
                `At most ${AGENT_BRIDGE_LIMITS.queuedBridgeItemsPerThread} of your messages may wait in one thread's queue.`,
                { retryAfterSeconds: 30 },
              );
            const submissionId = `${AGENT_BRIDGE_COMMAND_PREFIX}${mintId()}`;
            const command: ClientThreadTurnStartCommand = {
              type: "thread.turn.start",
              commandId: CommandId.makeUnsafe(submissionId),
              threadId: thread.id,
              message: {
                messageId: MessageId.makeUnsafe(mintId()),
                role: "user",
                text: input.prompt,
                attachments: [],
              },
              model: thread.model,
              ...(thread.modelSelection ? { modelSelection: thread.modelSelection } : {}),
              runtimeMode: "approval-required",
              interactionMode: thread.interactionMode,
              createdAt: now().toISOString(),
            };
            return {
              command,
              submissionId,
              threadId: thread.id,
              intent: "queue-tail",
              createsThread: false,
            } satisfies Admission;
          }),
        });
      }),
  };

  const waitTool: AgentBridgeToolDefinition = {
    name: "wait_for_submission",
    title: "Wait for submission",
    description: `Wait up to ${AGENT_BRIDGE_MAX_WAIT_SECONDS} seconds for a submitted turn to make progress. Returns its status (queued, preparing-worktree, blocked, running, awaiting-approval, awaiting-input, completed, failed, interrupted, or rejected) and timedOut when it expires. ${WORKSPACE_NOTE}`,
    scope: "f5.turns",
    inputSchema: objectSchema(
      {
        submissionId: stringProp("From create_thread or send_message."),
        timeoutSeconds: {
          type: "number",
          minimum: 0,
          maximum: AGENT_BRIDGE_MAX_WAIT_SECONDS,
          description: "Defaults to 30.",
        },
      },
      ["submissionId"],
    ),
    annotations: readOnly,
    run: (args, caller) =>
      Effect.gen(function* () {
        const input = yield* decodeArgs(WaitArgs)(args);
        return yield* waitForSubmission(caller, input.submissionId, input.timeoutSeconds ?? 30);
      }),
  };

  return [
    listProjects,
    listProviders,
    listThreads,
    getThread,
    getThreadDiff,
    createThread,
    sendMessage,
    waitTool,
  ];
}

function submissionDisposition(result: TurnSubmissionResult | null): string {
  return result?.disposition ?? "queued";
}
