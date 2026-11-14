import { randomUUID } from "node:crypto";
import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { Deferred, Effect, Stream } from "effect";
import { z } from "zod";
import { createModelSelection } from "@t3tools/shared/model";
import type { AgentBridgeHostShape } from "../agentBridge/AgentBridgeHost.ts";
import {
  AgentBridgeToolError,
  type AgentBridgeToolDefinition,
} from "../agentBridge/threadTools.ts";
import { pendingApprovalActivities } from "../orchestration/pendingApprovals.ts";
import { resolveTurnSubmissionStatus } from "../nextTurnQueue/submissionStatus.ts";
import { readProjectSettings } from "../project/projectSettings.ts";
import { buildExistingThreadSubmission, buildNewThreadSubmission } from "../turnSubmission.ts";
import { MAX_MESSAGE_BYTES } from "./protocol.ts";

const id = z.string().trim().min(1).max(512);
const prompt = z
  .string()
  .refine((s) => s.trim().length > 0, "The message is empty.")
  .refine((s) => Buffer.byteLength(s) <= MAX_MESSAGE_BYTES, "Message exceeds 128 KiB.");
const fail = (message: string) => new AgentBridgeToolError({ message });
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
    scope: "f5.read",
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
      if (result.disposition === "rejected") return yield* fail("F5 rejected the submission.");
      return { threadId: command.threadId, submissionId: command.commandId };
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
    wrap("f5_thread_list", z.object({ projectId: id }), true, ({ projectId }) =>
      Effect.gen(function* () {
        const ids = (yield* host.readSnapshot).threads
          .filter((t) => t.projectId === projectId && t.deletedAt === null)
          .map((t) => t.id);
        yield* host.ensureThreadActivities?.(ids) ?? Effect.void;
        const threads = (yield* host.readSnapshot).threads.filter(
          (t) => t.projectId === projectId && t.deletedAt === null,
        );
        if (threads.some((t) => t.activitiesOmitted))
          return yield* fail("Thread activities could not be loaded. Retry.");
        return {
          threads: threads.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(summary),
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
          const defaults = (yield* readProjectSettings(yield* host.getSettings, project)).settings;
          const selection =
            input.provider && input.model
              ? createModelSelection(ProviderInstanceId.makeUnsafe(input.provider), input.model)
              : project.defaultModelSelection;
          if (!selection)
            return yield* fail(
              "Set a default model for this project, or pass --provider and --model.",
            );
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
              branch: input.worktree ?? null,
              useWorktree: input.worktree !== undefined,
              requireWorktree: input.worktree !== undefined,
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
        if (!thread.modelSelection) return yield* fail("This thread has no model selection.");
        return yield* submit(
          buildExistingThreadSubmission({
            threadId: thread.id,
            commandId: CommandId.makeUnsafe(randomUUID()),
            messageId: MessageId.makeUnsafe(randomUUID()),
            prompt: input.prompt,
            modelSelection: thread.modelSelection,
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
      }),
      true,
      (input) =>
        Effect.gen(function* () {
          const thread = yield* findThread(input.threadId);
          const details = yield* host.getThreadDetails(thread.id);
          return {
            thread: summary(thread),
            messages:
              input.messages === 0
                ? []
                : details.messages
                    .filter((m) => m.role === "user" || m.role === "assistant")
                    .slice(-input.messages)
                    .map((m) => ({ role: m.role, text: m.text, turnId: m.turnId })),
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
            const active = ["queued", "running", "preparing-worktree"].includes(result.status);
            if (waiting || !active || Date.now() >= deadline) {
              const details =
                result.status === "completed" ? yield* host.getThreadDetails(thread.id) : null;
              return {
                ...input,
                ...result,
                status: waiting ? "waiting" : result.status,
                timedOut: active && !waiting,
                reply:
                  details?.messages.findLast(
                    (m) => m.role === "assistant" && m.turnId === result.turnId,
                  )?.text ?? null,
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
