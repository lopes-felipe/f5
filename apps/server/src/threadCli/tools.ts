import { randomUUID } from "node:crypto";
import {
  CommandId,
  MessageId,
  ThreadId,
  type OrchestrationThread,
  type OrchestrationMessage,
} from "@t3tools/contracts";
import { Deferred, Effect, Stream } from "effect";
import { z } from "zod";
import { createModelSelection } from "@t3tools/shared/model";
import type { AgentBridgeHostShape } from "../agentBridge/AgentBridgeHost.ts";
import {
  AgentBridgeToolError,
  type AgentBridgeToolDefinition,
  resolveBridgeProvider,
  isProviderUsable,
} from "../agentBridge/threadTools.ts";
import { pendingApprovalActivities } from "../orchestration/pendingApprovals.ts";
import { resolveTurnSubmissionStatus } from "../nextTurnQueue/submissionStatus.ts";
import { readProjectSettings } from "../project/projectSettings.ts";
import { buildExistingThreadSubmission, buildNewThreadSubmission } from "../turnSubmission.ts";
import { MAX_MESSAGE_BYTES, READ_PAGE_MESSAGES, READ_TEXT_CHARS } from "./protocol.ts";
import { projectProviderSnapshots } from "@t3tools/shared/serverSettings";

const id = z.string().trim().min(1).max(512);
const prompt = z
  .string()
  .refine((s) => s.trim().length > 0, "The message is empty.")
  .refine((s) => Buffer.byteLength(s) <= MAX_MESSAGE_BYTES, "Message exceeds 128 KiB.");
const fail = (message: string) => new AgentBridgeToolError({ message });
const messageChunk = (message: OrchestrationMessage, offset = 0) => ({
  id: message.id,
  role: message.role,
  turnId: message.turnId,
  text: message.text.slice(offset, offset + READ_TEXT_CHARS),
  nextTextOffset: offset + READ_TEXT_CHARS < message.text.length ? offset + READ_TEXT_CHARS : null,
});
const status = (thread: OrchestrationThread) =>
  (thread.pendingUserInputs?.length ?? 0) > 0 || pendingApprovalActivities(thread).length > 0
    ? "waiting"
    : (thread.latestTurn?.state ?? thread.session?.status ?? "idle");
const summary = (thread: OrchestrationThread) => ({
  id: thread.id,
  projectId: thread.projectId,
  title: thread.title,
  status: status(thread),
  model: thread.model,
  provider: thread.modelSelection?.instanceId ?? thread.session?.providerInstanceId ?? null,
  runtimeMode: thread.runtimeMode,
  branch: thread.branch,
  worktreePath: thread.worktreePath,
  pendingRequestCount:
    (thread.pendingUserInputs?.length ?? 0) + pendingApprovalActivities(thread).length,
});

/** Owner-only tools. They are never installed in the external Agent Bridge catalog. */
export function makeOwnerThreadTools(
  host: AgentBridgeHostShape,
): ReadonlyArray<AgentBridgeToolDefinition> {
  const wrap = <S extends z.ZodType>(
    name: string,
    schema: S,
    readOnly: boolean,
    run: (input: z.output<S>) => Effect.Effect<unknown, { readonly message: string }>,
  ): AgentBridgeToolDefinition => ({
    name,
    title: name,
    description: "Local F5 thread CLI tool.",
    scope: readOnly ? "f5.read" : "f5.turns",
    inputSchema: z.toJSONSchema(schema) as Record<string, unknown>,
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: false,
      idempotentHint: readOnly,
      openWorldHint: false,
    },
    run: (args) =>
      Effect.try({
        try: () => schema.parse(args),
        catch: () => fail("Invalid thread CLI arguments."),
      }).pipe(
        Effect.flatMap(run),
        Effect.mapError((error) => fail(error.message)),
      ),
  });
  const findThread = (threadId: string) =>
    Effect.gen(function* () {
      const thread = (yield* host.readSnapshot).threads.find(
        (t) => t.id === threadId && t.deletedAt === null,
      );
      if (!thread) return yield* fail("Thread not found.");
      yield* host.ensureThreadActivities?.([thread.id]) ?? Effect.void;
      const current = (yield* host.readSnapshot).threads.find(
        (t) => t.id === threadId && t.deletedAt === null,
      );
      if (!current) return yield* fail("Thread not found.");
      if (current.activitiesOmitted)
        return yield* fail("Thread activities could not be loaded. Retry.");
      return current;
    });
  const submit = (
    command: Parameters<typeof host.submitTurnSubmission>[0]["command"],
    intent: "auto" | "queue-tail",
  ) =>
    Effect.gen(function* () {
      const result = yield* host.submitTurnSubmission(
        { submissionId: command.commandId, command, intent },
        { submissionSource: "automation" },
      );
      if (!result) return yield* fail("F5 did not accept the submission.");
      if (
        result.disposition === "rejected" ||
        result.disposition === "canceled" ||
        result.disposition === "cleared"
      )
        return yield* fail(
          "F5 rejected the submission: " +
            result.reasonCode +
            (result.detail ? " — " + result.detail : ""),
        );
      return {
        threadId: command.threadId,
        submissionId: command.commandId,
        delivery: result.disposition === "started" ? "started" : "queued",
      };
    });
  return [
    wrap("f5_project_list", z.object({}), true, () =>
      host.readSnapshot.pipe(
        Effect.map((model) => ({
          projects: model.projects
            .filter((p) => p.deletedAt === null)
            .map((p) => ({
              id: p.id,
              title: p.title,
              workspaceRoot: p.workspaceRoot,
            })),
        })),
      ),
    ),
    wrap(
      "f5_thread_list",
      z.object({ projectId: id, limit: z.number().int().min(1).max(100).default(100) }),
      true,
      ({ projectId, limit }) =>
        Effect.gen(function* () {
          const ids = (yield* host.readSnapshot).threads
            .filter((t) => t.projectId === projectId && t.deletedAt === null)
            .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
            .slice(0, limit)
            .map((t) => t.id);
          yield* host.ensureThreadActivities?.(ids) ?? Effect.void;
          const threads = (yield* host.readSnapshot).threads.filter(
            (t) => ids.includes(t.id) && t.deletedAt === null,
          );
          if (threads.some((t) => t.activitiesOmitted))
            return yield* fail("Thread activities could not be loaded. Retry.");
          return {
            threads: threads
              .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
              .map(summary),
          };
        }),
    ),
    wrap(
      "f5_thread_launch",
      z.object({
        projectId: id,
        prompt,
        title: z.string().trim().min(1).max(200),
        provider: id.optional(),
        model: id.optional(),
        worktree: id.optional(),
        branch: id.optional(),
      }),
      false,
      (input) =>
        Effect.gen(function* () {
          if (!!input.provider !== !!input.model)
            return yield* fail("--provider and --model go together.");
          if (input.branch && !input.worktree) return yield* fail("--branch needs --worktree.");
          const project = (yield* host.readSnapshot).projects.find(
            (p) => p.id === input.projectId && p.deletedAt === null,
          );
          if (!project) return yield* fail("Project not found.");
          const settings = yield* host.getSettings;
          const defaults = (yield* readProjectSettings(settings, project)).settings;
          const providers = projectProviderSnapshots(
            yield* host.listProviderInstances,
            settings,
            project.id,
          );
          const preferred = project.defaultModelSelection;
          const requested =
            input.provider && input.model
              ? { instanceId: input.provider, model: input.model }
              : preferred &&
                  providers.some(
                    (p) => p.instanceId === preferred.instanceId && isProviderUsable(p),
                  )
                ? { instanceId: preferred.instanceId, model: preferred.model }
                : {};
          const resolve = (request: { instanceId?: string; model?: string }) =>
            resolveBridgeProvider(providers, defaults, request, { supervisedOnly: false });
          const resolved = yield* input.provider
            ? resolve(requested)
            : resolve(requested).pipe(Effect.catch(() => resolve({})));
          const selection =
            preferred?.instanceId === resolved.provider.instanceId &&
            preferred.model === resolved.model
              ? preferred
              : createModelSelection(resolved.provider.instanceId, resolved.model);
          const useWorktree =
            input.worktree !== undefined || defaults.defaultThreadEnvMode === "worktree";
          const base =
            input.worktree ??
            (useWorktree ? yield* host.getProjectGitBranch(project.workspaceRoot) : null);
          const threadId = ThreadId.makeUnsafe(randomUUID());
          return yield* submit(
            buildNewThreadSubmission({
              project,
              threadId,
              commandId: CommandId.makeUnsafe(randomUUID()),
              messageId: MessageId.makeUnsafe(randomUUID()),
              prompt: input.prompt,
              title: input.title,
              modelSelection: selection,
              runtimeMode: defaults.defaultRuntimeMode,
              branch: base,
              useWorktree: useWorktree && base !== null,
              requireWorktree: useWorktree && base !== null,
              ...(input.branch ? { worktreeBranch: input.branch } : {}),
              createdAt: new Date().toISOString(),
            }),
            "auto",
          );
        }),
    ),
    wrap("f5_thread_send", z.object({ threadId: id, prompt }), false, (input) =>
      Effect.gen(function* () {
        const thread = yield* findThread(input.threadId);
        return yield* submit(
          buildExistingThreadSubmission({
            threadId: thread.id,
            commandId: CommandId.makeUnsafe(randomUUID()),
            messageId: MessageId.makeUnsafe(randomUUID()),
            prompt: input.prompt,
            ...(thread.modelSelection
              ? { modelSelection: thread.modelSelection }
              : { model: thread.model }),
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            createdAt: new Date().toISOString(),
          }),
          "queue-tail",
        );
      }),
    ),
    wrap(
      "f5_thread_read",
      z.object({
        threadId: id,
        messages: z.number().int().min(0).max(1000).default(10),
        cursor: z.number().int().min(0).default(0),
        itemId: id.optional(),
        anchorId: id.optional().nullable(),
        textOffset: z.number().int().min(0).default(0),
      }),
      true,
      (input) =>
        Effect.gen(function* () {
          const thread = yield* findThread(input.threadId);
          const details = yield* host.getThreadDetails(thread.id);
          const conversation = details.messages.filter(
            (m) => m.role === "user" || m.role === "assistant",
          );
          if (input.itemId) {
            const item = conversation.find((m) => m.id === input.itemId);
            if (!item) return yield* fail("Message not found.");
            return {
              thread: summary(thread),
              messages: [messageChunk(item, input.textOffset)],
              nextCursor: null,
              anchorId: item.id,
            };
          }
          const anchor = input.anchorId
            ? conversation.findIndex((m) => m.id === input.anchorId)
            : conversation.length - 1;
          if (input.anchorId && anchor < 0) return yield* fail("Message anchor not found.");
          const selected =
            input.messages === 0 ? [] : conversation.slice(0, anchor + 1).slice(-input.messages);
          const page = selected.slice(input.cursor, input.cursor + READ_PAGE_MESSAGES);
          return {
            thread: summary(thread),
            messages: page.map((m) => messageChunk(m)),
            nextCursor:
              input.cursor + page.length < selected.length ? input.cursor + page.length : null,
            anchorId: conversation[anchor]?.id ?? null,
          };
        }),
    ),
    wrap("f5_thread_wait", z.object({ threadId: id, submissionId: id }), true, (input) =>
      Effect.scoped(
        Effect.gen(function* () {
          const deadline = Date.now() + 15_000;
          let wake = yield* Deferred.make<void>();
          const signal = Effect.suspend(() => Deferred.succeed(wake, undefined)).pipe(
            Effect.asVoid,
          );
          yield* host.queueChanges.pipe(
            Stream.filter((threadId) => threadId === input.threadId),
            Stream.runForEach(() => signal),
            Effect.forkScoped,
          );
          yield* host.domainEvents.pipe(
            Stream.filter(
              (event) =>
                event.aggregateId === input.threadId &&
                !(event.type === "thread.message-sent" && event.payload.streaming) &&
                event.type !== "thread.command-execution-output-appended",
            ),
            Stream.runForEach(() => signal),
            Effect.forkScoped,
          );
          let knownTurnId: import("@t3tools/contracts").TurnId | undefined;
          while (true) {
            wake = yield* Deferred.make<void>();
            const thread = yield* findThread(input.threadId);
            const record = yield* host.getSubmission(CommandId.makeUnsafe(input.submissionId));
            if (!record || record.threadId !== thread.id)
              return yield* fail("Submission not found in this thread.");
            const result = yield* resolveTurnSubmissionStatus(
              {
                ...host,
                getThreadDetails: host.getSubmissionThreadDetails ?? host.getThreadDetails,
              },
              { thread, submissionId: input.submissionId, knownTurnId },
            );
            knownTurnId = result.turnId ?? knownTurnId;
            const waiting =
              result.status === "awaiting-input" ||
              result.status === "awaiting-approval" ||
              (result.status === "queued" && status(thread) === "waiting");
            const queue =
              result.status === "blocked" ? yield* host.getQueueSnapshot(thread.id) : null;
            const needsInput = waiting || queue?.blockedKind === "paused";
            const active = ["queued", "running", "preparing-worktree"].includes(result.status);
            if (needsInput || !active || Date.now() >= deadline) {
              const details =
                result.status === "completed" ? yield* host.getThreadDetails(thread.id) : null;
              const reply = details?.messages.findLast(
                (m) => m.role === "assistant" && m.turnId === result.turnId,
              );
              return {
                ...input,
                ...result,
                status: needsInput ? "waiting" : result.status,
                timedOut: active && !needsInput,
                reply: reply ? messageChunk(reply).text : null,
                ...(reply
                  ? { replyMessageId: reply.id, nextTextOffset: messageChunk(reply).nextTextOffset }
                  : {}),
              };
            }
            yield* Deferred.await(wake).pipe(
              Effect.timeoutOption(Math.min(5000, Math.max(1, deadline - Date.now()))),
            );
          }
        }),
      ),
    ),
  ];
}
