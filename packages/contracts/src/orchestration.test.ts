import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  ClientOrchestrationCommand,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  OrchestrationCreateCodeReviewWorkflowInput,
  OrchestrationEvent,
  OrchestrationEventType,
  OrchestrationCreateWorkflowInput,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetThreadHistoryPageInput,
  OrchestrationThread,
  OrchestrationGetTurnDiffInput,
  OrchestrationProposedPlan,
  OrchestrationRetryWorkflowInput,
  OrchestrationRetryWorkflowResult,
  OrchestrationMessage,
  OrchestrationProject,
  OrchestrationSession,
  OrchestrationThreadActivityCursor,
  RuntimeMode,
  TaskItem,
  ProjectCreateCommand,
  ThreadArchivedPayload,
  ThreadMessageSentPayload,
  ThreadTurnStartCommand,
  ThreadCreatedPayload,
  ThreadTurnDiff,
  ThreadTurnStartRequestedPayload,
  ThreadUnarchivedPayload,
} from "./orchestration";
import { MessageId, ThreadId } from "./baseSchemas";

const decodeTurnDiffInput = Schema.decodeUnknownEffect(OrchestrationGetTurnDiffInput);
const decodeFullThreadDiffInput = Schema.decodeUnknownEffect(OrchestrationGetFullThreadDiffInput);
const decodeThreadTurnDiff = Schema.decodeUnknownEffect(ThreadTurnDiff);
const decodeProjectCreateCommand = Schema.decodeUnknownEffect(ProjectCreateCommand);
const decodeClientOrchestrationCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
const decodeThreadTurnStartCommand = Schema.decodeUnknownEffect(ThreadTurnStartCommand);
const decodeThreadTurnStartRequestedPayload = Schema.decodeUnknownEffect(
  ThreadTurnStartRequestedPayload,
);
const decodeOrchestrationMessage = Schema.decodeUnknownEffect(OrchestrationMessage);
const decodeOrchestrationProject = Schema.decodeUnknownEffect(OrchestrationProject);
const decodeThreadMessageSentPayload = Schema.decodeUnknownEffect(ThreadMessageSentPayload);
const encodeThreadMessageSentPayloadJson = Schema.encodeEffect(
  Schema.fromJsonString(ThreadMessageSentPayload),
);
const decodeOrchestrationProposedPlan = Schema.decodeUnknownEffect(OrchestrationProposedPlan);
const decodeOrchestrationSession = Schema.decodeUnknownEffect(OrchestrationSession);
const decodeThreadCreatedPayload = Schema.decodeUnknownEffect(ThreadCreatedPayload);
const decodeThreadArchivedPayload = Schema.decodeUnknownEffect(ThreadArchivedPayload);
const decodeThreadUnarchivedPayload = Schema.decodeUnknownEffect(ThreadUnarchivedPayload);
const decodeOrchestrationThread = Schema.decodeUnknownEffect(OrchestrationThread);
const decodeTaskItem = Schema.decodeUnknownEffect(TaskItem);
const decodeCreateWorkflowInput = Schema.decodeUnknownEffect(OrchestrationCreateWorkflowInput);
const decodeCreateCodeReviewWorkflowInput = Schema.decodeUnknownEffect(
  OrchestrationCreateCodeReviewWorkflowInput,
);
const decodeRetryWorkflowInput = Schema.decodeUnknownEffect(OrchestrationRetryWorkflowInput);
const decodeRetryWorkflowResult = Schema.decodeUnknownEffect(OrchestrationRetryWorkflowResult);

it("keeps every declared orchestration event type in the persisted event union", () => {
  type TypeAst = {
    readonly _tag?: string;
    readonly literal?: unknown;
    readonly types?: ReadonlyArray<TypeAst>;
  };
  const collectLiterals = (ast: TypeAst | undefined): ReadonlyArray<string> => {
    if (ast?._tag === "Literal" && typeof ast.literal === "string") {
      return [ast.literal];
    }
    return (ast?.types ?? []).flatMap(collectLiterals);
  };
  const unionAst = OrchestrationEvent.ast as unknown as {
    readonly types?: ReadonlyArray<{
      readonly propertySignatures?: ReadonlyArray<{
        readonly name?: PropertyKey;
        readonly type?: TypeAst;
      }>;
    }>;
  };
  const schemaEventTypes = (unionAst.types ?? []).flatMap((variant) => {
    const typeProperty = variant.propertySignatures?.find((property) => property.name === "type");
    return collectLiterals(typeProperty?.type);
  });

  assert.deepEqual(
    [...new Set(schemaEventTypes)].sort(),
    [...OrchestrationEventType.literals].sort(),
  );
});

it.effect("defaults planning workflow duplicate-risk confirmation to false", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeRetryWorkflowInput({ workflowId: "workflow-1" });
    assert.equal(parsed.allowPossibleDuplicate, false);
  }),
);

it.effect("decodes planning workflow retry confirmation results", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeRetryWorkflowResult({
      status: "confirmation_required",
      threadIds: ["thread-1"],
    });
    assert.deepEqual(parsed, {
      status: "confirmation_required",
      threadIds: ["thread-1"],
    });
  }),
);

it.effect("parses turn diff input when fromTurnCount <= toTurnCount", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeTurnDiffInput({
      threadId: "thread-1",
      fromTurnCount: 1,
      toTurnCount: 2,
    });
    assert.strictEqual(parsed.fromTurnCount, 1);
    assert.strictEqual(parsed.toTurnCount, 2);
  }),
);

it.effect("decodes additive turn diff options and rejects null options", () =>
  Effect.gen(function* () {
    const oldShape = yield* decodeTurnDiffInput({
      threadId: "thread-1",
      fromTurnCount: 1,
      toTurnCount: 2,
    });
    assert.equal(oldShape.options, undefined);

    const newShape = yield* decodeTurnDiffInput({
      threadId: "thread-1",
      fromTurnCount: 1,
      toTurnCount: 2,
      options: { ignoreWhitespace: true },
    });
    assert.deepEqual(newShape.options, { ignoreWhitespace: true });

    const nullResult = yield* Schema.decodeUnknownEffect(OrchestrationGetTurnDiffInput)({
      threadId: "thread-1",
      fromTurnCount: 1,
      toTurnCount: 2,
      options: null,
    }).pipe(Effect.exit);
    assert.equal(nullResult._tag, "Failure");
  }),
);

it.effect("decodes additive full-thread diff options", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeFullThreadDiffInput({
      threadId: "thread-1",
      toTurnCount: 2,
      options: { ignoreWhitespace: true },
    });
    assert.deepEqual(parsed.options, { ignoreWhitespace: true });
  }),
);

it.effect("decodes messages without skill call metadata", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationMessage({
      id: "message-1",
      role: "user",
      text: "$review target",
      turnId: null,
      streaming: false,
      createdAt: "2026-04-01T09:00:00.000Z",
      updatedAt: "2026-04-01T09:00:00.000Z",
    });

    assert.strictEqual(parsed.skillCall, undefined);
  }),
);

it.effect("decodes message-sent payloads without skill call metadata", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadMessageSentPayload({
      threadId: "thread-1",
      messageId: "message-1",
      role: "user",
      text: "$review target",
      turnId: null,
      streaming: false,
      createdAt: "2026-04-01T09:00:00.000Z",
      updatedAt: "2026-04-01T09:00:00.000Z",
    });

    assert.strictEqual(parsed.skillCall, undefined);
  }),
);

it.effect("preserves message-sent skill call metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadMessageSentPayload({
      threadId: "thread-1",
      messageId: "message-1",
      role: "user",
      text: "$review target",
      skillCall: { name: "review" },
      turnId: null,
      streaming: false,
      createdAt: "2026-04-01T09:00:00.000Z",
      updatedAt: "2026-04-01T09:00:00.000Z",
    });

    assert.deepStrictEqual(parsed.skillCall, { name: "review" });
  }),
);

it.effect("omits undefined skill call metadata from encoded JSON payloads", () =>
  Effect.gen(function* () {
    const encodedJson = yield* encodeThreadMessageSentPayloadJson({
      threadId: ThreadId.makeUnsafe("thread-1"),
      messageId: MessageId.makeUnsafe("message-1"),
      role: "user",
      text: "$review target",
      skillCall: undefined,
      turnId: null,
      streaming: false,
      createdAt: "2026-04-01T09:00:00.000Z",
      updatedAt: "2026-04-01T09:00:00.000Z",
    });

    assert.strictEqual(encodedJson.includes('"skillCall"'), false);
  }),
);

it.effect("rejects turn diff input when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeTurnDiffInput({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("rejects thread turn diff when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeThreadTurnDiff({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
        diff: "patch",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("trims branded ids and command string fields at decode boundaries", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreateCommand({
      type: "project.create",
      commandId: " cmd-1 ",
      projectId: " project-1 ",
      title: " Project Title ",
      workspaceRoot: " /tmp/workspace ",
      defaultModel: " gpt-5.2 ",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.commandId, "cmd-1");
    assert.strictEqual(parsed.projectId, "project-1");
    assert.strictEqual(parsed.title, "Project Title");
    assert.strictEqual(parsed.workspaceRoot, "/tmp/workspace");
    assert.strictEqual(parsed.defaultModel, "gpt-5.2");
  }),
);

it.effect("decodes legacy projects without local environment or icon overrides", () =>
  Effect.gen(function* () {
    const project = yield* decodeOrchestrationProject({
      id: "project-legacy",
      title: "Legacy project",
      workspaceRoot: "/tmp/legacy",
      defaultModel: null,
      defaultModelSelection: null,
      scripts: [],
      memories: [],
      skills: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    });
    assert.strictEqual(project.defaultEnvMode, null);
    assert.strictEqual(project.icon, null);
  }),
);

it.effect("rejects command fields that become empty after trim", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeProjectCreateCommand({
        type: "project.create",
        commandId: "cmd-1",
        projectId: "project-1",
        title: "  ",
        workspaceRoot: "/tmp/workspace",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("decodes thread.turn.start defaults for provider and runtime mode", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-1",
      threadId: "thread-1",
      message: {
        messageId: "msg-1",
        role: "user",
        text: "hello",
        attachments: [],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.provider, undefined);
    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
  }),
);

it.effect("preserves explicit provider and runtime mode in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-2",
      threadId: "thread-1",
      message: {
        messageId: "msg-2",
        role: "user",
        text: "hello",
        attachments: [],
      },
      provider: "codex",
      runtimeMode: "full-access",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.provider, "codex");
    assert.strictEqual(parsed.runtimeMode, "full-access");
    assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
  }),
);

it.effect("decodes orchestration sessions with token usage fields when provided", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationSession({
      threadId: "thread-1",
      status: "ready",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      estimatedContextTokens: 45_000,
      modelContextWindowTokens: 400_000,
      tokenUsageSource: "provider",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.estimatedContextTokens, 45_000);
    assert.strictEqual(parsed.modelContextWindowTokens, 400_000);
    assert.strictEqual(parsed.tokenUsageSource, "provider");
    assert.strictEqual(parsed.lastErrorId, null);
    assert.strictEqual(parsed.lastErrorOccurredAt, null);
  }),
);

it.effect("keeps orchestration sessions backward-compatible when token usage is absent", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationSession({
      threadId: "thread-1",
      status: "ready",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.estimatedContextTokens, undefined);
    assert.strictEqual(parsed.modelContextWindowTokens, undefined);
    assert.strictEqual(parsed.tokenUsageSource, undefined);
    assert.strictEqual(parsed.lastErrorId, null);
    assert.strictEqual(parsed.lastErrorOccurredAt, null);
  }),
);

it.effect("decodes structured session error identity alongside the legacy message", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationSession({
      threadId: "thread-1",
      status: "error",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: "Provider failed",
      lastErrorId: "error-123",
      lastErrorOccurredAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.lastError, "Provider failed");
    assert.strictEqual(parsed.lastErrorId, "error-123");
    assert.strictEqual(parsed.lastErrorOccurredAt, "2026-01-01T00:00:00.000Z");
  }),
);

it.effect("decodes threads without persisted token usage and defaults to null", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationThread({
      id: "thread-1",
      projectId: "project-1",
      title: "Thread",
      model: "gpt-5-codex",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      archivedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastInteractionAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      tasks: [],
      tasksTurnId: null,
      tasksUpdatedAt: null,
      compaction: null,
      sessionNotes: null,
      threadReferences: [],
      activities: [],
      checkpoints: [],
      session: null,
    });
    assert.strictEqual(parsed.estimatedContextTokens, null);
    assert.strictEqual(parsed.modelContextWindowTokens, null);
    assert.strictEqual(parsed.pinnedAt, null);
    assert.strictEqual(parsed.pinOrderKey, null);
    assert.strictEqual(parsed.snoozedUntil, null);
    assert.strictEqual(parsed.snoozedAt, null);
    assert.strictEqual(parsed.titleSource, "legacy");
    assert.strictEqual(parsed.titleRevision, 0);
    assert.strictEqual(parsed.titleUpdatedAt, null);
    assert.strictEqual(parsed.titleRegeneration, null);
  }),
);

it.effect("accepts title regeneration intent and rejects title plus regeneration", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeClientOrchestrationCommand({
      type: "thread.meta.update",
      commandId: "cmd-title-regenerate",
      threadId: "thread-1",
      regenerateTitle: true,
    });
    assert.strictEqual(parsed.type, "thread.meta.update");
    assert.strictEqual(parsed.regenerateTitle, true);

    const rejected = yield* Effect.exit(
      decodeClientOrchestrationCommand({
        type: "thread.meta.update",
        commandId: "cmd-title-conflict",
        threadId: "thread-1",
        title: "Manual title",
        regenerateTitle: true,
      }),
    );
    assert.strictEqual(rejected._tag, "Failure");
  }),
);

it.effect("decodes thread.turn.start title generation fields when provided", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-title-fields",
      threadId: "thread-1",
      message: {
        messageId: "msg-title-fields",
        role: "user",
        text: "hello",
        attachments: [],
      },
      titleGenerationModel: "gpt-5.3-codex",
      titleSourceText: "",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.titleGenerationModel, "gpt-5.3-codex");
    assert.strictEqual(parsed.titleSourceText, "");
  }),
);

it.effect("decodes client thread.turn.start title generation fields when provided", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeClientOrchestrationCommand({
      type: "thread.turn.start",
      commandId: "cmd-client-turn-title-fields",
      threadId: "thread-1",
      message: {
        messageId: "msg-client-title-fields",
        role: "user",
        text: "hello",
        attachments: [],
      },
      titleGenerationModel: "gpt-5.3-codex",
      titleSourceText: "",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.type, "thread.turn.start");
    assert.strictEqual(parsed.titleGenerationModel, "gpt-5.3-codex");
    assert.strictEqual(parsed.titleSourceText, "");
  }),
);

it.effect("rejects server-only workflow execution profiles at the client command boundary", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeClientOrchestrationCommand({
        type: "thread.turn.start",
        commandId: "cmd-client-profile-injection",
        threadId: "thread-1",
        message: {
          messageId: "msg-client-profile-injection",
          role: "user",
          text: "hello",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "plan",
        workflowExecutionProfile: "unattended-readonly",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("decodes thread.turn.start bootstrap metadata when provided", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-bootstrap",
      threadId: "thread-1",
      message: {
        messageId: "msg-bootstrap",
        role: "user",
        text: "hello",
        attachments: [],
      },
      bootstrap: {
        createThread: {
          projectId: "project-1",
          title: "New thread",
          model: "gpt-5-codex",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        prepareWorktree: {
          projectCwd: "/repo/project",
          baseBranch: "main",
          branch: "t3code/1234abcd",
        },
        runSetupScript: true,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.bootstrap?.createThread?.projectId, "project-1");
    assert.strictEqual(parsed.bootstrap?.createThread?.title, "New thread");
    assert.strictEqual(parsed.bootstrap?.prepareWorktree?.baseBranch, "main");
    assert.strictEqual(parsed.bootstrap?.runSetupScript, true);
  }),
);

it.effect("decodes client thread.turn.start bootstrap metadata when provided", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeClientOrchestrationCommand({
      type: "thread.turn.start",
      commandId: "cmd-client-turn-bootstrap",
      threadId: "thread-1",
      message: {
        messageId: "msg-client-bootstrap",
        role: "user",
        text: "hello",
        attachments: [],
      },
      bootstrap: {
        createThread: {
          projectId: "project-1",
          title: "New thread",
          model: "gpt-5-codex",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        prepareWorktree: {
          projectCwd: "/repo/project",
          baseBranch: "main",
        },
        runSetupScript: true,
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.type, "thread.turn.start");
    assert.strictEqual(parsed.bootstrap?.createThread?.model, "gpt-5-codex");
    assert.strictEqual(parsed.bootstrap?.prepareWorktree?.projectCwd, "/repo/project");
    assert.strictEqual(parsed.bootstrap?.runSetupScript, true);
  }),
);

it.effect("decodes createWorkflow without a manual title", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeCreateWorkflowInput({
      projectId: "project-1",
      requirementPrompt: "Plan the feature",
      titleGenerationModel: "gpt-5.3-codex",
      selfReviewEnabled: true,
      branchA: { provider: "codex", model: "gpt-5-codex" },
      branchB: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
      merge: { provider: "codex", model: "gpt-5-codex" },
    });
    assert.strictEqual(parsed.title, undefined);
    assert.strictEqual(parsed.titleGenerationModel, "gpt-5.3-codex");
  }),
);

it.effect("decodes createCodeReviewWorkflow without a manual title", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeCreateCodeReviewWorkflowInput({
      projectId: "project-1",
      reviewPrompt: "Review the branch",
      titleGenerationModel: "gpt-5.3-codex",
      reviewerA: { provider: "codex", model: "gpt-5-codex" },
      reviewerB: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
      consolidation: { provider: "codex", model: "gpt-5-codex" },
    });
    assert.strictEqual(parsed.title, undefined);
    assert.strictEqual(parsed.titleGenerationModel, "gpt-5.3-codex");
  }),
);

it.effect("decodes thread.created runtime mode for historical events", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadCreatedPayload({
      threadId: "thread-1",
      projectId: "project-1",
      title: "Thread title",
      model: "gpt-5.4",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
  }),
);

it.effect("decodes archive and unarchive client commands", () =>
  Effect.gen(function* () {
    const archived = yield* decodeClientOrchestrationCommand({
      type: "thread.archive",
      commandId: "cmd-archive-1",
      threadId: "thread-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const unarchived = yield* decodeClientOrchestrationCommand({
      type: "thread.unarchive",
      commandId: "cmd-unarchive-1",
      threadId: "thread-1",
      createdAt: "2026-01-01T00:00:01.000Z",
    });

    assert.strictEqual(archived.type, "thread.archive");
    assert.strictEqual(unarchived.type, "thread.unarchive");
  }),
);

it.effect("decodes archive lifecycle payloads", () =>
  Effect.gen(function* () {
    const archived = yield* decodeThreadArchivedPayload({
      threadId: "thread-1",
      archivedAt: "2026-01-01T00:00:00.000Z",
    });
    const unarchived = yield* decodeThreadUnarchivedPayload({
      threadId: "thread-1",
      unarchivedAt: "2026-01-01T00:05:00.000Z",
    });

    assert.strictEqual(archived.archivedAt, "2026-01-01T00:00:00.000Z");
    assert.strictEqual(unarchived.unarchivedAt, "2026-01-01T00:05:00.000Z");
  }),
);

it.effect("defaults thread archivedAt to null for historical snapshots", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationThread({
      id: "thread-1",
      projectId: "project-1",
      title: "Thread title",
      model: "gpt-5.4",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastInteractionAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      tasks: [
        {
          id: "task-1",
          content: "Run tests",
          activeForm: "Running tests",
          status: "completed",
        },
      ],
      activities: [],
      checkpoints: [],
      session: null,
    });

    assert.strictEqual(parsed.archivedAt, null);
    assert.strictEqual(parsed.pinnedAt, null);
    assert.strictEqual(parsed.snoozedUntil, null);
    assert.strictEqual(parsed.compaction, null);
    assert.strictEqual(parsed.tasksTurnId, null);
    assert.strictEqual(parsed.tasksUpdatedAt, null);
    assert.strictEqual(parsed.tasks[0]?.activeForm, "Running tests");
  }),
);

it.effect("decodes thread.compact.request with manual defaults", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeClientOrchestrationCommand({
      type: "thread.compact.request",
      commandId: "cmd-compact-1",
      threadId: "thread-1",
      createdAt: "2026-04-03T00:00:00.000Z",
    });

    assert.strictEqual(parsed.type, "thread.compact.request");
    assert.strictEqual(parsed.trigger, "manual");
    assert.strictEqual(parsed.direction, undefined);
    assert.strictEqual(parsed.pivotMessageId, undefined);
  }),
);

it.effect("decodes task items with TodoWrite-compatible statuses", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeTaskItem({
      id: "task-1",
      content: "Update the API contract",
      activeForm: "Updating the API contract",
      status: "in_progress",
    });

    assert.strictEqual(parsed.status, "in_progress");
    assert.strictEqual(parsed.activeForm, "Updating the API contract");
  }),
);

it.effect("accepts provider-scoped model options in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-options",
      threadId: "thread-1",
      message: {
        messageId: "msg-options",
        role: "user",
        text: "hello",
        attachments: [],
      },
      provider: "codex",
      model: "gpt-5.3-codex",
      modelOptions: {
        codex: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.provider, "codex");
    assert.strictEqual(parsed.modelOptions?.codex?.reasoningEffort, "high");
    assert.strictEqual(parsed.modelOptions?.codex?.fastMode, true);
  }),
);

it.effect("accepts a source proposed plan reference in thread.turn.start", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-source-plan",
      threadId: "thread-2",
      message: {
        messageId: "msg-source-plan",
        role: "user",
        text: "implement this",
        attachments: [],
      },
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect(
  "decodes thread.turn-start-requested defaults for provider, runtime mode, and interaction mode",
  () =>
    Effect.gen(function* () {
      const parsed = yield* decodeThreadTurnStartRequestedPayload({
        threadId: "thread-1",
        messageId: "msg-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      assert.strictEqual(parsed.provider, undefined);
      assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
      assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
      assert.strictEqual(parsed.sourceProposedPlan, undefined);
    }),
);

it.effect("decodes thread.turn-start-requested title generation fields when provided", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-1",
      messageId: "msg-1",
      titleGenerationModel: "gpt-5.3-codex",
      titleSourceText: "",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.titleGenerationModel, "gpt-5.3-codex");
    assert.strictEqual(parsed.titleSourceText, "");
  }),
);

it.effect("decodes thread.turn-start-requested source proposed plan metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-2",
      messageId: "msg-2",
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect("decodes orchestration session runtime mode defaults", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationSession({
      threadId: "thread-1",
      status: "idle",
      providerName: null,
      providerSessionId: null,
      providerThreadId: null,
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
  }),
);

it("widens runtime modes with an explicit clean legacy-client failure", () => {
  const LegacyRuntimeMode = Schema.Literals(["approval-required", "full-access"]);

  assert.equal(Schema.decodeUnknownSync(RuntimeMode)("auto"), "auto");
  assert.equal(Schema.decodeUnknownSync(RuntimeMode)("auto-accept-edits"), "auto-accept-edits");
  assert.throws(() => Schema.decodeUnknownSync(LegacyRuntimeMode)("auto"));
  assert.equal(Schema.decodeUnknownSync(RuntimeMode)("approval-required"), "approval-required");
});

it("validates nullable activity cursor sequence identity", () => {
  const decode = Schema.decodeUnknownSync(OrchestrationThreadActivityCursor);
  assert.deepStrictEqual(
    decode({
      sequenceIsNull: true,
      sequence: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      activityId: "activity-1",
    }),
    {
      sequenceIsNull: true,
      sequence: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      activityId: "activity-1",
    },
  );
  assert.throws(() =>
    decode({
      sequenceIsNull: true,
      sequence: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      activityId: "activity-1",
    }),
  );
});

it("rejects ambiguous message history window selectors", () => {
  const decode = Schema.decodeUnknownSync(OrchestrationGetThreadHistoryPageInput);
  assert.throws(() =>
    decode({
      threadId: "thread-1",
      anchorMessageId: "message-1",
      beforeMessageCursor: {
        createdAt: "2026-01-01T00:00:00.000Z",
        messageId: "message-0",
      },
      beforeCheckpointTurnCount: null,
      activityCursor: null,
      beforeCommandExecutionCursor: null,
    }),
  );
});

it.effect("defaults proposed plan implementation metadata for historical rows", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationProposedPlan({
      id: "plan-1",
      turnId: "turn-1",
      planMarkdown: "# Plan",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.implementedAt, null);
    assert.strictEqual(parsed.implementationThreadId, null);
  }),
);

it.effect("preserves proposed plan implementation metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationProposedPlan({
      id: "plan-2",
      turnId: "turn-2",
      planMarkdown: "# Plan",
      implementedAt: "2026-01-02T00:00:00.000Z",
      implementationThreadId: "thread-2",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    assert.strictEqual(parsed.implementedAt, "2026-01-02T00:00:00.000Z");
    assert.strictEqual(parsed.implementationThreadId, "thread-2");
  }),
);
