import {
  ApprovalRequestId,
  CommandId,
  MessageId,
  OrchestrationCommandExecutionId,
  ProviderApprovalOption,
  ProviderApprovalPresentation,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationMessage,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import type {
  MobileApproval,
  MobileCommandExecution,
  MobileMessage,
  MobilePendingInput,
  MobileShell,
  MobileThreadShell,
  MobileThreadTail,
} from "@t3tools/contracts/mobile/v1";
import {
  compareActivities,
  pendingApprovalActivities,
} from "@t3tools/shared/pendingActivityWindow";
import { requestKindFromRequestType } from "@t3tools/shared/pendingApprovals";
import { resolveApprovalOptions } from "@t3tools/shared/approvalOptions";
import {
  archivedWorkflowThreadIds,
  threadIdsForPlanningWorkflow,
  threadIdsForCodeReviewWorkflow,
  threadIdsForInvestigationWorkflow,
} from "@t3tools/shared/workflowThreads";
import {
  findLatestProposedPlan,
  hasActionableProposedPlan,
  isLatestTurnSettled,
} from "@t3tools/shared/threadAttention";
import { timeOrderedUuid } from "@t3tools/shared/ids";
import { Effect, Schema, Stream } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type {
  OrchestrationCommandGuard,
  OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ThreadCommandExecutionQueryShape } from "../orchestration/Services/ThreadCommandExecutionQuery.ts";
import { MobileRouteError, type MobileCall } from "./listener.ts";

function readPlan(thread: OrchestrationThread) {
  return findLatestProposedPlan(thread.proposedPlans, thread.latestTurn?.turnId);
}

function readApprovals(thread: OrchestrationThread): (typeof MobileApproval.Type)[] {
  return pendingApprovalActivities(thread.activities.toSorted(compareActivities)).map(
    (activity) => {
      const payload = (activity.payload ?? {}) as Record<string, unknown>;
      const presentation = Schema.decodeUnknownOption(ProviderApprovalPresentation)(
        payload.presentation,
      );
      const prompt = presentation._tag === "Some" ? presentation.value : undefined;
      const legacyKind = requestKindFromRequestType(payload.requestType);
      const kind =
        typeof payload.requestKind === "string" ? payload.requestKind : (legacyKind ?? "unknown");
      const supported =
        (kind === "command" || kind === "file-read" || kind === "file-change") &&
        payload.requestedPermissions == null &&
        legacyKind !== "permission" &&
        legacyKind !== "mcp-elicitation" &&
        prompt?.fullAccessOverride === undefined &&
        prompt?.blockedPath === undefined &&
        // Malformed presentation data cannot be assumed to omit a host-only control.
        (payload.presentation == null || presentation._tag === "Some") &&
        [prompt?.description, prompt?.decisionReason, payload.detail].every(
          (value) => typeof value !== "string" || encodedBytes(value) <= 4096,
        );
      const advertised =
        Array.isArray(payload.approvalOptions) && payload.approvalOptions.length
          ? payload.approvalOptions.filter(Schema.is(ProviderApprovalOption))
          : undefined;
      const available =
        supported && (advertised === undefined || advertised.length > 0)
          ? resolveApprovalOptions({
              requestKind: kind,
              approvalOptions: advertised,
              suppressAlwaysAllowRule: true,
            }).map((option) => option.decision)
          : [];
      const ordered = prompt?.defaultToNo
        ? (["decline", "accept", "cancel"] as const)
        : (["accept", "decline", "cancel"] as const);
      return {
        requestId: payload.requestId as string,
        kind,
        title: boundedText(prompt?.title ?? activity.summary, 1024),
        ...(typeof payload.detail === "string"
          ? { detail: boundedText(payload.detail, 4096) }
          : {}),
        ...(prompt?.description ? { description: boundedText(prompt.description, 4096) } : {}),
        ...(prompt?.decisionReason
          ? { decisionReason: boundedText(prompt.decisionReason, 4096) }
          : {}),
        ...(prompt?.defaultToNo ? { defaultToNo: true } : {}),
        decisions: supported ? ordered.filter((decision) => available.includes(decision)) : [],
      };
    },
  );
}

function readInputs(thread: OrchestrationThread): (typeof MobilePendingInput.Type)[] {
  return (thread.pendingUserInputs ?? []).map((input) => ({
    requestId: input.requestId,
    hostOnly: input.elicitation !== undefined,
    responseMode: input.responseMode === "message" ? "message" : "native",
    questions: input.elicitation
      ? []
      : input.questions.map((question) => ({
          id: question.id,
          header: question.header,
          question: question.question,
          options: question.options.map(({ label, description, value }) => ({
            label,
            description,
            ...(value === undefined ? {} : { value }),
          })),
          ...(question.initialAnswer !== undefined
            ? { initialAnswer: question.initialAnswer }
            : {}),
          ...(question.multiSelect !== undefined ? { multiSelect: question.multiSelect } : {}),
          ...(question.optional !== undefined ? { optional: question.optional } : {}),
          ...(question.allowCustomAnswer !== undefined
            ? { allowCustomAnswer: question.allowCustomAnswer }
            : {}),
        })),
  }));
}

export function mobileThreadShell(
  thread: OrchestrationThread,
  pendingApprovalRequestIds: readonly string[],
  workflow = false,
  workflowArchived = false,
): typeof MobileThreadShell.Type {
  const latest = thread.latestTurn;
  const status = thread.session?.status ?? null;
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    branch: thread.branch,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    latestActivityAt: thread.lastInteractionAt,
    archivedAt: thread.archivedAt ?? (workflowArchived ? thread.updatedAt : null),
    snoozedUntil: thread.snoozedUntil ?? null,
    settledAt: thread.settledAt ?? null,
    interactionMode: thread.interactionMode,
    runtimeMode: thread.runtimeMode,
    sessionStatus: status === "starting" ? "connecting" : status,
    activeTurnId: thread.session?.activeTurnId ?? null,
    latestTurn: latest && {
      turnId: latest.turnId,
      state: latest.state,
      completedAt: latest.completedAt,
    },
    workflowRole: workflow ? "step" : null,
    isSideChat: thread.sideChatOf != null,
    attention: {
      pendingApprovalRequestIds,
      pendingInputRequestIds: (thread.pendingUserInputs ?? []).map((input) => input.requestId),
      planReady:
        thread.interactionMode === "plan" &&
        thread.proposedPlansOmitted !== true &&
        isLatestTurnSettled(latest, status) &&
        hasActionableProposedPlan(readPlan(thread)),
      latestFailedTurnId: latest?.state === "error" ? latest.turnId : null,
      latestCompletedTurnId: latest?.state === "completed" ? latest.turnId : null,
    },
  };
}

function encodedBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value));
}

function boundedText(value: string, maxBytes: number): string {
  if (encodedBytes(value) <= maxBytes) return value;
  // A UTF-16 unit requires at most six bytes in JSON, including escaped controls.
  return value.slice(0, Math.floor((maxBytes - 80) / 6)) + "\n[Open on the host for the full text]";
}

function boundedRows<T>(rows: readonly T[], budget: number): T[] {
  const kept: T[] = [];
  for (const row of rows) {
    budget -= encodedBytes(row) + 1;
    if (budget < 0) break;
    kept.push(row);
  }
  return kept;
}

function message(message: OrchestrationMessage): typeof MobileMessage.Type {
  return {
    messageId: message.id,
    text: boundedText(message.text, 64 * 1024),
    role: message.role,
    streaming: message.streaming,
    createdAt: message.createdAt,
  };
}

function checkAnswers(
  input: typeof MobilePendingInput.Type,
  answers: Readonly<Record<string, string | readonly string[]>>,
) {
  if (Object.keys(answers).some((key) => !input.questions.some(({ id }) => key === id)))
    throw new MobileRouteError("invalid-request");
  for (const question of input.questions) {
    const answer = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined;
    const values = typeof answer === "string" ? [answer] : (answer ?? []);
    if (question.optional && values.every((value) => value === "")) continue;
    if (
      values.length === 0 ||
      (values.length > 1 && !question.multiSelect) ||
      new Set(values).size !== values.length ||
      values.some(
        (value) =>
          !value.trim() ||
          (question.allowCustomAnswer === false &&
            !question.options.some((option) => (option.value ?? option.label) === value)),
      )
    )
      throw new MobileRouteError("invalid-request");
  }
}

type ApiCall = Exclude<
  MobileCall,
  {
    method:
      | "subscribe"
      | "probe"
      | "registerPush"
      | "setPresence"
      | "setNotificationPrefs"
      | "unregisterPush";
  }
>;

export function makeMobileApi(options: {
  incarnation: string;
  engine: () => Promise<OrchestrationEngineShape>;
  history: ProjectionSnapshotQueryShape["getThreadHistoryPage"];
  commandExecution: ThreadCommandExecutionQueryShape["getThreadCommandExecution"];
  pendingApprovals: (
    threadIds?: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, readonly string[]>, SqlError>;
  dispatch: (
    engine: OrchestrationEngineShape,
    command: OrchestrationCommand,
    guard: OrchestrationCommandGuard,
  ) => Promise<unknown>;
}) {
  async function readModel(): Promise<OrchestrationReadModel> {
    const engine = await options.engine();
    return Effect.runPromise(engine.getReadModel());
  }

  async function shell(ids?: readonly string[]): Promise<typeof MobileShell.Type> {
    const selected = ids ? new Set(ids) : null;
    const model = await readModel();
    const archived = archivedWorkflowThreadIds(
      model.planningWorkflows,
      model.codeReviewWorkflows,
      model.investigationWorkflows,
    );
    const workflow = new Set([
      ...model.planningWorkflows.flatMap(threadIdsForPlanningWorkflow),
      ...model.codeReviewWorkflows.flatMap(threadIdsForCodeReviewWorkflow),
      ...model.investigationWorkflows.flatMap(threadIdsForInvestigationWorkflow),
    ]);
    const pending = await Effect.runPromise(options.pendingApprovals(ids));
    return {
      snapshotSequence: model.snapshotSequence,
      backendIncarnation: options.incarnation,
      projects: ids
        ? []
        : model.projects
            .filter((p) => p.deletedAt === null)
            .map((p) => ({ id: p.id, name: p.title })),
      threads: model.threads
        .filter((thread) => thread.deletedAt === null && (!selected || selected.has(thread.id)))
        .map((thread) =>
          mobileThreadShell(
            thread,
            pending.get(thread.id) ?? [],
            workflow.has(thread.id),
            archived.has(thread.id),
          ),
        ),
    };
  }

  return {
    shell,
    readModel,
    async replay(afterSequence: number, throughSequence: number) {
      if (throughSequence - afterSequence > 128) return null;
      if (throughSequence === afterSequence) return [];
      const engine = await options.engine();
      const events = (
        await Effect.runPromise(
          Stream.runCollect(
            engine.readEvents(afterSequence, {
              limit: throughSequence - afterSequence,
            }),
          ),
        )
      ).filter((event) => event.sequence <= throughSequence);
      if (events.length !== throughSequence - afterSequence) return null;
      return events;
    },
    async call(call: ApiCall, authorized: () => boolean): Promise<unknown> {
      if (call.method === "getThreadShells") return shell(call.body.threadIds);
      const engine = await options.engine();
      const threadId = ThreadId.makeUnsafe(call.body.threadId);
      await Effect.runPromise(engine.ensureThreadActivities?.([threadId]) ?? Effect.void);
      const current = await Effect.runPromise(engine.getReadModel());
      const thread = current.threads.find(
        (entry) => entry.id === threadId && entry.deletedAt === null,
      );
      if (!thread) throw new MobileRouteError("stale-action");
      if (call.method === "getCommandExecution") {
        const { commandExecution: execution } = await Effect.runPromise(
          options.commandExecution({
            threadId,
            commandExecutionId: OrchestrationCommandExecutionId.makeUnsafe(call.body.id),
          }),
        );
        return (execution && {
          id: execution.id,
          title: boundedText(execution.title ?? execution.command, 4096),
          status: execution.status,
          output: boundedText(execution.output, 256 * 1024),
          truncated: execution.outputTruncated || encodedBytes(execution.output) > 256 * 1024,
        }) satisfies typeof MobileCommandExecution.Type;
      }
      if (call.method === "getThreadHistory") {
        const page = await Effect.runPromise(
          options.history({
            threadId,
            beforeMessageCursor: {
              createdAt: call.body.cursor.createdAt,
              messageId: MessageId.makeUnsafe(call.body.cursor.messageId),
            },
            beforeCheckpointTurnCount: null,
            beforeCommandExecutionCursor: null,
            activityCursor: null,
            messageLimit: call.body.limit,
            checkpointLimit: 0,
            commandExecutionLimit: 0,
            activityLimit: 0,
          }),
        );
        const messages = boundedRows(page.messages.map(message).reverse(), 512 * 1024).reverse();
        const oldest = messages[0];
        return {
          snapshotSequence: page.detailSequence,
          messages,
          cursor:
            oldest && (messages.length < page.messages.length || page.hasOlderMessages)
              ? { createdAt: oldest.createdAt, messageId: oldest.messageId }
              : null,
        };
      }
      if (call.method === "getThreadTail") {
        const approvals = boundedRows(readApprovals(thread), 96 * 1024);
        const messages = boundedRows(
          thread.messages.slice(-call.body.messageLimit).map(message).reverse(),
          512 * 1024,
        ).reverse();
        const plan = readPlan(thread);
        return {
          snapshotSequence: current.snapshotSequence,
          messages,
          hasOlderMessages:
            thread.messages.length >= call.body.messageLimit ||
            messages.length < thread.messages.length,
          approvals,
          pendingInputs: boundedRows(
            readInputs(thread).map((input) =>
              encodedBytes(input) > 48 * 1024 ? { ...input, hostOnly: true, questions: [] } : input,
            ),
            128 * 1024,
          ),
          plan: plan ? boundedText(plan.planMarkdown, 48 * 1024) : null,
          activity: thread.activities
            .filter(
              (item) =>
                item.kind === "tool.started" ||
                item.kind === "tool.completed" ||
                item.kind === "runtime.error",
            )
            .slice(-24)
            .map(({ id, createdAt, kind, summary }) => ({
              id,
              createdAt,
              kind,
              summary: summary.slice(0, 300),
            })),
        } satisfies typeof MobileThreadTail.Type;
      }
      const base = {
        threadId,
        commandId: CommandId.makeUnsafe(timeOrderedUuid()),
        createdAt: new Date().toISOString(),
      };
      const dispatch = (
        command: OrchestrationCommand,
        check?: (current: OrchestrationThread) => boolean,
      ) =>
        options.dispatch(engine, command, (snapshot) => {
          if (!authorized()) return false;
          const currentThread = snapshot.threads.find(
            (item) => item.id === threadId && item.deletedAt === null,
          );
          return Boolean(currentThread && (check?.(currentThread) ?? true));
        });
      switch (call.method) {
        case "respondToApproval": {
          const { requestId, decision } = call.body;
          const approval = readApprovals(thread).find(
            (candidate) => candidate.requestId === requestId,
          );
          if (!approval) throw new MobileRouteError("stale-action");
          if (!approval.decisions.length) throw new MobileRouteError("host-only");
          if (!approval.decisions.includes(decision)) throw new MobileRouteError("invalid-request");
          return dispatch(
            {
              ...base,
              type: "thread.approval.respond",
              requestId: ApprovalRequestId.makeUnsafe(requestId),
              decision,
            },
            (currentThread) =>
              readApprovals(currentThread).some(
                (option) => option.requestId === requestId && option.decisions.includes(decision),
              ),
          );
        }
        case "respondToQuestion":
        case "dismissQuestion": {
          const requestId = ApprovalRequestId.makeUnsafe(call.body.requestId);
          const input = readInputs(thread).find((candidate) => candidate.requestId === requestId);
          if (!input) throw new MobileRouteError("stale-action");
          if (input.hostOnly) throw new MobileRouteError("host-only");
          const check = (currentThread: OrchestrationThread) =>
            currentThread.pendingUserInputs?.some(
              (pending) => pending.requestId === requestId && !pending.elicitation,
            ) ?? false;
          if (call.method === "dismissQuestion")
            return dispatch({ ...base, type: "thread.user-input.dismiss", requestId }, check);
          checkAnswers(input, call.body.answers);
          return dispatch(
            {
              ...base,
              type: "thread.user-input.respond",
              requestId,
              answers: call.body.answers,
            },
            check,
          );
        }
        case "interrupt": {
          const turnId = TurnId.makeUnsafe(call.body.turnId);
          if (thread.session?.activeTurnId !== turnId) throw new MobileRouteError("stale-action");
          return dispatch(
            { ...base, type: "thread.turn.interrupt", turnId },
            (currentThread) => currentThread.session?.activeTurnId === turnId,
          );
        }
        case "settle":
          return dispatch({ ...base, type: "thread.settle", expectedUpdatedAt: thread.updatedAt });
        case "unsettle":
          return dispatch({ ...base, type: "thread.unsettle", reason: "user" });
        case "snooze": {
          const time = Date.parse(call.body.until);
          if (!Number.isFinite(time) || time <= Date.now() || time > Date.now() + 365 * 86_400_000)
            throw new MobileRouteError("invalid-request");
          return dispatch({ ...base, type: "thread.snooze", until: new Date(time).toISOString() });
        }
        case "unsnooze":
          return dispatch({
            ...base,
            type: "thread.unsnooze",
            ...(thread.snoozedUntil ? { expectedSnoozedUntil: thread.snoozedUntil } : {}),
          });
        case "archive":
          return dispatch({ ...base, type: "thread.archive" });
      }
    },
  };
}

export function mobileEventAffectsShell(event: OrchestrationEvent): boolean {
  switch (event.type) {
    case "thread.activity-appended":
      return /^(approval\.|provider\.approval\.respond\.failed$|user-input\.|elicitation\.)/.test(
        event.payload.activity.kind,
      );
    case "thread.message-sent":
      return !event.payload.streaming;
    case "thread.session-set":
    case "thread.turn-start-requested":
    case "thread.user-input-resolved":
    case "thread.proposed-plan-upserted":
    case "thread.turn-processing-quiesced":
    case "thread.reverted":
    case "thread.created":
    case "thread.meta-updated":
    case "thread.deleted":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.settled":
    case "thread.unsettled":
    case "thread.snoozed":
    case "thread.unsnoozed":
      return true;
    default:
      return (
        event.type === "project.created" ||
        event.type === "project.meta-updated" ||
        event.type === "project.deleted" ||
        (event.aggregateKind === "project" && event.type.includes("workflow"))
      );
  }
}
