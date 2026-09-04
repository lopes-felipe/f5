import assert from "node:assert/strict";
import {
  ApprovalRequestId,
  EventId,
  ProviderItemId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, it, vi } from "@effect/vitest";

import { Effect, Fiber, Layer, Option, Stream } from "effect";

import {
  CodexAppServerManager,
  type CodexAppServerStartSessionInput,
  type CodexAppServerSendTurnInput,
} from "../../codexAppServerManager.ts";
import { ServerConfig } from "../../config.ts";
import { CodexAdapter } from "../Services/CodexAdapter.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  hookTargetItemId,
  makeCodexAdapterLive,
  normalizeCodexThreadItemType,
} from "./CodexAdapter.ts";

it("maps exact current Codex item types and legacy aliases without substring collisions", () => {
  const aliases = {
    userMessage: "user_message",
    hookPrompt: "hook_prompt",
    agentMessage: "assistant_message",
    plan: "plan",
    reasoning: "reasoning",
    commandExecution: "command_execution",
    fileChange: "file_change",
    mcpToolCall: "mcp_tool_call",
    dynamicToolCall: "dynamic_tool_call",
    collabAgentToolCall: "collab_agent_tool_call",
    subAgentActivity: "subagent_activity",
    webSearch: "web_search",
    imageView: "image_view",
    sleep: "sleep",
    imageGeneration: "image_generation",
    enteredReviewMode: "review_entered",
    exitedReviewMode: "review_exited",
    contextCompaction: "context_compaction",
    user_message: "user_message",
    hook_prompt: "hook_prompt",
    assistant_message: "assistant_message",
    command_execution: "command_execution",
    file_change: "file_change",
    mcp_tool_call: "mcp_tool_call",
    dynamic_tool_call: "dynamic_tool_call",
    collab_agent_tool_call: "collab_agent_tool_call",
    sub_agent_activity: "subagent_activity",
    web_search: "web_search",
    image_view: "image_view",
    image_generation: "image_generation",
    review_entered: "review_entered",
    review_exited: "review_exited",
    context_compaction: "context_compaction",
    patch_apply_end: "file_change",
  } as const;

  for (const [rawType, expected] of Object.entries(aliases)) {
    assert.equal(normalizeCodexThreadItemType(rawType), expected, rawType);
  }
  assert.equal(normalizeCodexThreadItemType("imageGenerationPreview"), "unknown");
});

it("correlates only hook ids ending in a validated exec provider item id", () => {
  const execId = "exec-4c585f9f-caa8-4cec-86a1-d7e292df4d65";
  assert.equal(hookTargetItemId(`pre-tool-use:0:C:\\hooks\\hooks-codex.json:${execId}`), execId);
  assert.equal(hookTargetItemId("pre-tool-use:0:C:\\hooks\\hooks-codex.json"), undefined);
  assert.equal(hookTargetItemId("pre-tool-use:0:/tmp/hook:exec-not-a-uuid"), undefined);
});

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.makeUnsafe(value);

class FakeCodexManager extends CodexAppServerManager {
  public startSessionImpl = vi.fn(
    async (input: CodexAppServerStartSessionInput): Promise<ProviderSession> => {
      const now = new Date().toISOString();
      return {
        provider: "codex",
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        cwd: input.cwd,
        createdAt: now,
        updatedAt: now,
      };
    },
  );

  public sendTurnImpl = vi.fn(
    async (_input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> => ({
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-1"),
    }),
  );

  public interruptTurnImpl = vi.fn(
    async (_threadId: ThreadId, _turnId?: TurnId): Promise<void> => undefined,
  );

  public readThreadImpl = vi.fn(async (_threadId: ThreadId) => ({
    threadId: asThreadId("thread-1"),
    turns: [],
  }));

  public rollbackThreadImpl = vi.fn(async (_threadId: ThreadId, _numTurns: number) => ({
    threadId: asThreadId("thread-1"),
    turns: [],
  }));

  public respondToRequestImpl = vi.fn(
    async (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _decision: ProviderApprovalDecision,
    ): Promise<void> => undefined,
  );

  public respondToUserInputImpl = vi.fn(
    async (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _answers: ProviderUserInputAnswers,
    ): Promise<void> => undefined,
  );

  public runOneOffPromptImpl = vi.fn(
    async (_input: Parameters<CodexAppServerManager["runOneOffPrompt"]>[0]): Promise<string> =>
      "one-off-result",
  );

  public stopAllImpl = vi.fn(() => undefined);

  override startSession(input: CodexAppServerStartSessionInput): Promise<ProviderSession> {
    return this.startSessionImpl(input);
  }

  override sendTurn(input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> {
    return this.sendTurnImpl(input);
  }

  override interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void> {
    return this.interruptTurnImpl(threadId, turnId);
  }

  override readThread(threadId: ThreadId) {
    return this.readThreadImpl(threadId);
  }

  override rollbackThread(threadId: ThreadId, numTurns: number) {
    return this.rollbackThreadImpl(threadId, numTurns);
  }

  override respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    return this.respondToRequestImpl(threadId, requestId, decision);
  }

  override respondToUserInput(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Promise<void> {
    return this.respondToUserInputImpl(threadId, requestId, answers);
  }

  override runOneOffPrompt(
    input: Parameters<CodexAppServerManager["runOneOffPrompt"]>[0],
  ): Promise<string> {
    return this.runOneOffPromptImpl(input);
  }

  override stopSession(_threadId: ThreadId): void {}

  override listSessions(): ProviderSession[] {
    return [];
  }

  override hasSession(_threadId: ThreadId): boolean {
    return false;
  }

  override stopAll(): void {
    this.stopAllImpl();
  }
}

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
  listBindingsByProject: () => Effect.succeed([]),
});
const validationManager = new FakeCodexManager();
const validationLayer = it.layer(
  makeCodexAdapterLive({ manager: validationManager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

validationLayer("CodexAdapterLive validation", (it) => {
  it.effect("maps codex model options before starting a session", () =>
    Effect.gen(function* () {
      validationManager.startSessionImpl.mockClear();
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        provider: "codex",
        threadId: asThreadId("thread-1"),
        model: "gpt-5.3-codex",
        projectTitle: "Project title",
        threadTitle: "Thread title",
        turnCount: 4,
        priorWorkSummary: "Earlier work",
        preservedTranscriptBefore: "Before transcript",
        preservedTranscriptAfter: "After transcript",
        restoredRecentFileRefs: ["apps/server/src/index.ts"],
        restoredActivePlan: "1. Ship it",
        restoredTasks: ["[pending] Ship it"],
        sessionNotes: {
          title: "Notes",
          currentState: "State",
          taskSpecification: "Task",
          filesAndFunctions: "Files",
          workflow: "Workflow",
          errorsAndCorrections: "Errors",
          codebaseAndSystemDocumentation: "Docs",
          learnings: "Learnings",
          keyResults: "Results",
          worklog: "Worklog",
          updatedAt: "2026-04-08T10:00:00.000Z",
          sourceLastInteractionAt: "2026-04-08T10:00:00.000Z",
        },
        projectMemories: [],
        modelOptions: {
          codex: {
            fastMode: true,
          },
        },
        runtimeMode: "full-access",
      });

      assert.deepStrictEqual(validationManager.startSessionImpl.mock.calls[0]?.[0], {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        model: "gpt-5.3-codex",
        projectTitle: "Project title",
        threadTitle: "Thread title",
        turnCount: 4,
        priorWorkSummary: "Earlier work",
        preservedTranscriptBefore: "Before transcript",
        preservedTranscriptAfter: "After transcript",
        restoredRecentFileRefs: ["apps/server/src/index.ts"],
        restoredActivePlan: "1. Ship it",
        restoredTasks: ["[pending] Ship it"],
        sessionNotes: {
          title: "Notes",
          currentState: "State",
          taskSpecification: "Task",
          filesAndFunctions: "Files",
          workflow: "Workflow",
          errorsAndCorrections: "Errors",
          codebaseAndSystemDocumentation: "Docs",
          learnings: "Learnings",
          keyResults: "Results",
          worklog: "Worklog",
          updatedAt: "2026-04-08T10:00:00.000Z",
          sourceLastInteractionAt: "2026-04-08T10:00:00.000Z",
        },
        projectMemories: [],
        serviceTier: "fast",
        runtimeMode: "full-access",
      });
    }),
  );

  it.effect("maps one-off prompts to the manager", () =>
    Effect.gen(function* () {
      validationManager.runOneOffPromptImpl.mockClear();
      const adapter = yield* CodexAdapter;

      const result = yield* adapter.runOneOffPrompt!({
        threadId: asThreadId("thread-1"),
        provider: "codex",
        prompt: "Summarize this",
        cwd: "/tmp/project",
        model: "gpt-5.3-codex",
        runtimeMode: "approval-required",
        timeoutMs: 5_000,
      });

      assert.deepStrictEqual(result, { text: "one-off-result" });
      assert.deepStrictEqual(validationManager.runOneOffPromptImpl.mock.calls[0]?.[0], {
        prompt: "Summarize this",
        cwd: "/tmp/project",
        model: "gpt-5.3-codex",
        runtimeMode: "approval-required",
        timeoutMs: 5_000,
      });
    }),
  );
});

const configuredManager = new FakeCodexManager();
const configuredLayer = it.layer(
  makeCodexAdapterLive({
    manager: configuredManager,
    defaultProviderOptions: {
      codex: {
        binaryPath: "/configured/codex",
        homePath: "/configured/home",
        launchArgs: ["--enable=configured"],
      },
    },
    processEnvironment: { PATH: "/configured/bin" },
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

configuredLayer("CodexAdapterLive configured launch identity", (it) => {
  it.effect("hydrates instance defaults and appends explicit launch arguments", () =>
    Effect.gen(function* () {
      configuredManager.startSessionImpl.mockClear();
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: "codex",
        threadId: asThreadId("thread-configured"),
        providerOptions: {
          codex: {
            binaryPath: "/explicit/codex",
            launchArgs: ["--disable=explicit"],
          },
        },
        runtimeMode: "auto-accept-edits",
      });

      const managerInput = configuredManager.startSessionImpl.mock.calls[0]?.[0];
      assert.deepStrictEqual(managerInput?.processEnvironment, { PATH: "/configured/bin" });
      assert.deepStrictEqual(managerInput?.providerOptions, {
        codex: {
          binaryPath: "/explicit/codex",
          homePath: "/configured/home",
          launchArgs: ["--enable=configured", "--disable=explicit"],
        },
      });
    }),
  );
});

const sessionErrorManager = new FakeCodexManager();
sessionErrorManager.sendTurnImpl.mockImplementation(async () => {
  throw new Error("Unknown session: sess-missing");
});
const sessionErrorLayer = it.layer(
  makeCodexAdapterLive({ manager: sessionErrorManager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

sessionErrorLayer("CodexAdapterLive session errors", (it) => {
  it.effect("maps unknown-session sendTurn errors to ProviderAdapterSessionNotFoundError", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "hello",
          attachments: [],
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }

      assert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
      if (result.failure._tag !== "ProviderAdapterSessionNotFoundError") {
        return;
      }
      assert.equal(result.failure.provider, "codex");
      assert.equal(result.failure.threadId, "sess-missing");
      assert.equal(result.failure.cause instanceof Error, true);
    }),
  );

  it.effect("maps codex model options before sending a turn", () =>
    Effect.gen(function* () {
      sessionErrorManager.sendTurnImpl.mockClear();
      const adapter = yield* CodexAdapter;

      yield* Effect.ignore(
        adapter.sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "hello",
          model: "gpt-5.3-codex",
          modelOptions: {
            codex: {
              reasoningEffort: "high",
              fastMode: true,
            },
          },
          attachments: [],
        }),
      );

      assert.deepStrictEqual(sessionErrorManager.sendTurnImpl.mock.calls[0]?.[0], {
        threadId: asThreadId("sess-missing"),
        input: "hello",
        model: "gpt-5.3-codex",
        effort: "high",
        serviceTier: "fast",
      });
    }),
  );

  it.effect("appends provider-only attachment paths to the Codex turn input", () =>
    Effect.gen(function* () {
      sessionErrorManager.sendTurnImpl.mockClear();
      const adapter = yield* CodexAdapter;
      const localPath = "/tmp/f5/attachments/screenshot.png";

      yield* Effect.ignore(
        adapter.sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "inspect this image",
          attachments: [],
          resolvedAttachments: [
            {
              type: "image",
              id: "thread-context-12345678-1234-1234-1234-123456789abc",
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 4,
              localPath,
            },
          ],
        }),
      );

      const managerInput = sessionErrorManager.sendTurnImpl.mock.calls[0]?.[0];
      assert.equal(managerInput?.input?.startsWith("inspect this image\n\n"), true);
      assert.equal(managerInput?.input?.includes("sandbox may prevent opening"), true);
      assert.equal(managerInput?.input?.includes(JSON.stringify(localPath)), true);
    }),
  );
});

const lifecycleManager = new FakeCodexManager();
const lifecycleLayer = it.layer(
  makeCodexAdapterLive({ manager: lifecycleManager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

lifecycleLayer("CodexAdapterLive lifecycle", (it) => {
  it.effect("preserves the legacy turn/aborted notification", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-turn-aborted"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "turn/aborted",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        message: "Interrupted by user",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag === "Some") {
        assert.equal(firstEvent.value.type, "turn.aborted");
        if (firstEvent.value.type === "turn.aborted") {
          assert.equal(firstEvent.value.payload.reason, "Interrupted by user");
        }
      }
    }),
  );

  it.effect("surfaces unknown thread item variants as protocol warnings", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-unknown-item"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("future-item-1"),
        payload: {
          item: { type: "imageGenerationPreview", id: "future-item-1" },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      assert.equal(
        firstEvent._tag === "Some" ? firstEvent.value.type : undefined,
        "runtime.warning",
      );
      if (firstEvent._tag === "Some" && firstEvent.value.type === "runtime.warning") {
        assert.equal(firstEvent.value.payload.category, "protocol");
        assert.equal(firstEvent.value.payload.actionable, true);
        assert.equal(
          firstEvent.value.payload.message,
          "Unsupported Codex thread item: imageGenerationPreview",
        );
        assert.equal(firstEvent.value.payload.protocolMethod, "item/completed");
        assert.equal(firstEvent.value.payload.protocolValue, "imageGenerationPreview");
      }
    }),
  );

  it.effect("suppresses hook prompts and raw response item duplicates", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      const base = {
        kind: "notification" as const,
        provider: "codex" as const,
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
      };

      lifecycleManager.emit("event", {
        ...base,
        id: asEventId("evt-raw-response"),
        method: "rawResponseItem/completed",
        payload: { item: { type: "message" } },
      } satisfies ProviderEvent);
      lifecycleManager.emit("event", {
        ...base,
        id: asEventId("evt-hook-prompt"),
        method: "item/completed",
        itemId: asItemId("hook-prompt-1"),
        payload: { item: { type: "hookPrompt", id: "hook-prompt-1" } },
      } satisfies ProviderEvent);
      lifecycleManager.emit("event", {
        ...base,
        id: asEventId("evt-after-duplicates"),
        method: "warning",
        payload: { message: "Visible event" },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      assert.equal(
        firstEvent._tag === "Some" ? firstEvent.value.type : undefined,
        "runtime.warning",
      );
      if (firstEvent._tag === "Some" && firstEvent.value.type === "runtime.warning") {
        assert.equal(firstEvent.value.payload.message, "Visible event");
      }
    }),
  );

  it.effect("maps completed agent message items to canonical item.completed events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-msg-complete"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("msg_1"),
        payload: {
          item: {
            type: "agentMessage",
            id: "msg_1",
          },
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "item.completed");
      if (firstEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(firstEvent.value.itemId, "msg_1");
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.itemType, "assistant_message");
    }),
  );

  it.effect("keeps Codex collaboration fields in the raw lifecycle payload", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      const item = {
        type: "collabAgentToolCall",
        id: "collab_1",
        tool: "wait",
        senderThreadId: "thread-1",
        receiverThreadIds: ["agent-a"],
        agentsStates: { "agent-a": { status: "completed", message: "Done" } },
      };
      lifecycleManager.emit("event", {
        id: asEventId("evt-collab-complete"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("collab_1"),
        payload: { item },
      } satisfies ProviderEvent);
      const event = yield* Fiber.join(firstEventFiber);
      assert.equal(event._tag, "Some");
      if (event._tag !== "Some" || event.value.type !== "item.completed") return;
      assert.equal(event.value.payload.itemType, "collab_agent_tool_call");
      assert.deepEqual(event.value.payload.data, { item });
    }),
  );

  it.effect("maps completed plan items to canonical proposed-plan completion events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-plan-complete"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("plan_1"),
        payload: {
          item: {
            type: "Plan",
            id: "plan_1",
            text: "## Final plan\n\n- one\n- two",
          },
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "turn.proposed.completed");
      if (firstEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.planMarkdown, "## Final plan\n\n- one\n- two");
    }),
  );

  it.effect("resolves web-search detail in canonical query fallback order", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
        Effect.forkChild,
      );
      const createdAt = new Date().toISOString();
      const items = [
        {
          id: "web-search-item-query",
          query: "item query",
          action: {
            query: "action query",
            queries: ["query list"],
            pattern: "pattern",
            url: "url",
          },
        },
        {
          id: "web-search-action-query",
          action: {
            query: "action query",
            queries: ["query list"],
            pattern: "pattern",
            url: "url",
          },
        },
        {
          id: "web-search-query-list",
          action: { queries: ["query list", "second query"], pattern: "pattern", url: "url" },
        },
        { id: "web-search-pattern", action: { pattern: "pattern", url: "url" } },
        { id: "web-search-url", action: { url: "https://example.com" } },
      ];

      for (const item of items) {
        lifecycleManager.emit("event", {
          id: asEventId(`evt-${item.id}`),
          kind: "notification",
          provider: "codex",
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-1"),
          itemId: asItemId(item.id),
          createdAt,
          method: "item/completed",
          payload: { item: { type: "webSearch", ...item } },
        } satisfies ProviderEvent);
      }

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.deepEqual(
        events.map((event) => (event.type === "item.completed" ? event.payload.detail : undefined)),
        ["item query", "action query", "query list", "pattern", "https://example.com"],
      );
    }),
  );

  it.effect("maps generated images, waits, and subagent activity as distinct current items", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 3)).pipe(
        Effect.forkChild,
      );
      const createdAt = new Date().toISOString();

      lifecycleManager.emit("event", {
        id: asEventId("evt-image-generation"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("image-1"),
        createdAt,
        method: "item/completed",
        payload: {
          item: {
            type: "imageGeneration",
            id: "image-1",
            status: "completed",
            result: "image-result",
            savedPath: "/tmp/generated.png",
          },
        },
      } satisfies ProviderEvent);
      lifecycleManager.emit("event", {
        id: asEventId("evt-sleep"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("sleep-1"),
        createdAt,
        method: "item/completed",
        payload: {
          item: { type: "sleep", id: "sleep-1", durationMs: 1_500 },
        },
      } satisfies ProviderEvent);
      lifecycleManager.emit("event", {
        id: asEventId("evt-subagent"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("subagent-activity-1"),
        createdAt,
        method: "item/completed",
        payload: {
          item: {
            type: "subAgentActivity",
            id: "subagent-activity-1",
            kind: "interacted",
            agentThreadId: "agent-thread-1",
            agentPath: "/root/reviewer",
          },
        },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(events[0]?.type, "item.completed");
      assert.equal(
        events[0]?.type === "item.completed" ? events[0].payload.itemType : undefined,
        "image_generation",
      );
      assert.equal(events[1]?.type, "item.completed");
      assert.equal(
        events[1]?.type === "item.completed" ? events[1].payload.itemType : undefined,
        "sleep",
      );
      assert.equal(events[2]?.type, "subagent.activity");
      if (events[2]?.type === "subagent.activity") {
        assert.deepEqual(events[2].payload, {
          kind: "interacted",
          agentThreadId: "agent-thread-1",
          agentPath: "/root/reviewer",
        });
      }
    }),
  );

  it.effect("maps approval reviews and patch updates onto their existing lifecycles", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 3)).pipe(
        Effect.forkChild,
      );
      const createdAt = new Date().toISOString();
      const review = {
        status: "inProgress",
        riskLevel: "high",
        userAuthorization: "medium",
        rationale: "Network access needs review",
      };

      lifecycleManager.emit("event", {
        id: asEventId("evt-review-started"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt,
        method: "item/autoApprovalReview/started",
        payload: {
          reviewId: "review-1",
          targetItemId: "exec-1",
          startedAtMs: 1_000,
          review,
          action: { type: "command", command: "git status" },
        },
      } satisfies ProviderEvent);
      lifecycleManager.emit("event", {
        id: asEventId("evt-review-completed"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt,
        method: "item/autoApprovalReview/completed",
        payload: {
          reviewId: "review-1",
          targetItemId: "exec-1",
          startedAtMs: 1_000,
          completedAtMs: 1_020,
          decisionSource: "guardian",
          review: { ...review, status: "denied" },
          action: { type: "command", command: "git status" },
        },
      } satisfies ProviderEvent);
      lifecycleManager.emit("event", {
        id: asEventId("evt-patch-updated"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt,
        method: "item/fileChange/patchUpdated",
        payload: {
          itemId: "patch-1",
          changes: [{ path: "README.md", kind: "update" }],
        },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(events[0]?.type, "approval-review.started");
      assert.deepEqual(events[0]?.payload, {
        reviewId: "review-1",
        targetItemId: "exec-1",
        status: "inProgress",
        actionType: "command",
        riskLevel: "high",
        userAuthorization: "medium",
        rationale: "Network access needs review",
        startedAtMs: 1_000,
        action: { type: "command", command: "git status" },
      });
      assert.equal(events[1]?.type, "approval-review.completed");
      assert.deepEqual(events[1]?.payload, {
        reviewId: "review-1",
        targetItemId: "exec-1",
        status: "denied",
        actionType: "command",
        riskLevel: "high",
        userAuthorization: "medium",
        rationale: "Network access needs review",
        decisionSource: "guardian",
        startedAtMs: 1_000,
        completedAtMs: 1_020,
        durationMs: 20,
        action: { type: "command", command: "git status" },
      });
      assert.equal(events[2]?.type, "item.updated");
      if (events[2]?.type === "item.updated") {
        assert.equal(events[2].itemId, "patch-1");
        assert.equal(events[2].payload.itemType, "file_change");
      }
    }),
  );

  it.effect("categorizes new warnings and maps auth and deletion state", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
        Effect.forkChild,
      );
      const createdAt = new Date().toISOString();
      const base = {
        kind: "notification" as const,
        provider: "codex" as const,
        threadId: asThreadId("thread-1"),
        createdAt,
      };

      lifecycleManager.emit("event", {
        ...base,
        id: asEventId("evt-warning"),
        method: "warning",
        payload: { message: "Provider is retrying" },
      } satisfies ProviderEvent);
      lifecycleManager.emit("event", {
        ...base,
        id: asEventId("evt-guardian-warning"),
        method: "guardianWarning",
        payload: { message: "Review network access" },
      } satisfies ProviderEvent);
      lifecycleManager.emit("event", {
        ...base,
        id: asEventId("evt-verification"),
        turnId: asTurnId("turn-1"),
        method: "model/verification",
        payload: { verifications: ["trustedAccessForCyber"] },
      } satisfies ProviderEvent);
      lifecycleManager.emit("event", {
        ...base,
        id: asEventId("evt-login-completed"),
        method: "account/login/completed",
        payload: { success: false, error: "Login expired" },
      } satisfies ProviderEvent);
      lifecycleManager.emit("event", {
        ...base,
        id: asEventId("evt-thread-deleted"),
        method: "thread/deleted",
        payload: { threadId: "thread-1" },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.deepEqual(
        events.map((event) => event.type),
        [
          "runtime.warning",
          "runtime.warning",
          "runtime.warning",
          "auth.status",
          "thread.state.changed",
        ],
      );
      if (events[0]?.type === "runtime.warning") {
        assert.deepEqual(events[0].payload, {
          message: "Provider is retrying",
          category: "provider",
          actionable: false,
          detail: { message: "Provider is retrying" },
        });
      }
      if (events[1]?.type === "runtime.warning") {
        assert.equal(events[1].payload.category, "guardian");
        assert.equal(events[1].payload.actionable, true);
      }
      if (events[2]?.type === "runtime.warning") {
        assert.equal(events[2].payload.category, "verification");
        assert.equal(events[2].payload.actionable, true);
      }
      if (events[3]?.type === "auth.status") {
        assert.equal(events[3].payload.error, "Login expired");
      }
      if (events[4]?.type === "thread.state.changed") {
        assert.equal(events[4].payload.state, "closed");
      }
    }),
  );

  it.effect("decodes generated Codex ThreadStatus objects", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
        Effect.forkChild,
      );
      const createdAt = new Date().toISOString();
      const statuses = [
        { type: "notLoaded" },
        { type: "idle" },
        { type: "systemError" },
        { type: "active", activeFlags: [] },
      ] as const;

      statuses.forEach((status, index) => {
        lifecycleManager.emit("event", {
          id: asEventId(`evt-thread-status-${index}`),
          kind: "notification",
          provider: "codex",
          threadId: asThreadId("thread-1"),
          createdAt,
          method: "thread/status/changed",
          payload: { threadId: "thread-1", status },
        } satisfies ProviderEvent);
      });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.deepEqual(
        events.map((event) =>
          event.type === "thread.state.changed" ? event.payload.state : event.type,
        ),
        ["idle", "idle", "error", "active"],
      );
    }),
  );

  it.effect("logs registered unnormalized notifications without user-facing warnings", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      const createdAt = new Date().toISOString();

      lifecycleManager.emit("event", {
        id: asEventId("evt-realtime-error-unhandled"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt,
        method: "thread/realtime/error",
        payload: { message: "realtime unavailable" },
      } satisfies ProviderEvent);
      lifecycleManager.emit("event", {
        id: asEventId("evt-visible-warning"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt,
        method: "warning",
        payload: { message: "visible warning" },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag === "Some" && firstEvent.value.type === "runtime.warning") {
        assert.equal(firstEvent.value.eventId, "evt-visible-warning");
      }
    }),
  );

  it.effect("turns malformed subagent and unknown updated items into protocol warnings", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );
      const createdAt = new Date().toISOString();

      lifecycleManager.emit("event", {
        id: asEventId("evt-malformed-subagent"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt,
        method: "item/completed",
        payload: {
          item: { type: "subAgentActivity", id: "subagent-1", kind: "started" },
        },
      } satisfies ProviderEvent);
      lifecycleManager.emit("event", {
        id: asEventId("evt-unknown-updated-item"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt,
        method: "item/reasoning/summaryPartAdded",
        payload: {
          item: { type: "futureItem", id: "future-1" },
        },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.deepEqual(
        events.map((event) =>
          event.type === "runtime.warning"
            ? {
                message: event.payload.message,
                protocolMethod: event.payload.protocolMethod,
                protocolValue: event.payload.protocolValue,
              }
            : event.type,
        ),
        [
          {
            message:
              "Malformed Codex subagent activity: expected kind, agentThreadId, and agentPath.",
            protocolMethod: "item/completed",
            protocolValue: "subAgentActivity",
          },
          {
            message: "Unsupported Codex thread item: futureItem",
            protocolMethod: "item/reasoning/summaryPartAdded",
            protocolValue: "futureItem",
          },
        ],
      );
    }),
  );

  it.effect("maps plan deltas to canonical proposed-plan delta events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-plan-delta"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/plan/delta",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("plan_1"),
        payload: {
          delta: "## Final plan",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "turn.proposed.delta");
      if (firstEvent.value.type !== "turn.proposed.delta") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.delta, "## Final plan");
    }),
  );

  it.effect("maps patch_apply_end notifications to file-change item.updated events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-patch-apply-end"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "codex/event/patch_apply_end",
        threadId: asThreadId("thread-1"),
        payload: {
          id: "turn-1",
          msg: {
            type: "patch_apply_end",
            turn_id: "turn-1",
            call_id: "call-file-change-1",
            status: "completed",
            changes: {
              "README.md": {
                type: "update",
                unified_diff: "@@ -1 +1,2 @@\n hello\n+world\n",
                move_path: null,
              },
            },
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "item.updated");
      if (firstEvent.value.type !== "item.updated") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.itemId, "call-file-change-1");
      assert.equal(firstEvent.value.payload.itemType, "file_change");
      assert.deepEqual(firstEvent.value.payload.data, {
        item: {
          type: "fileChange",
          id: "call-file-change-1",
          status: "completed",
          changes: [
            {
              path: "README.md",
              kind: {
                type: "update",
              },
              diff: "@@ -1 +1,2 @@\n hello\n+world\n",
            },
          ],
        },
      });
    }),
  );

  it.effect("maps session/closed lifecycle events to canonical session.exited runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-session-closed"),
        kind: "session",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "session/closed",
        message: "Session stopped",
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "session.exited");
      if (firstEvent.value.type !== "session.exited") {
        return;
      }
      assert.equal(firstEvent.value.threadId, "thread-1");
      assert.equal(firstEvent.value.payload.reason, "Session stopped");
    }),
  );

  it.effect("filters synthetic one-off events from the runtime stream", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-one-off"),
        kind: "notification",
        provider: "codex",
        createdAt: new Date().toISOString(),
        method: "item/agentMessage/delta",
        threadId: asThreadId("one-off:test"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("msg_1"),
        textDelta: "ignored",
        payload: {
          delta: "ignored",
        },
      } satisfies ProviderEvent);

      lifecycleManager.emit("event", {
        id: asEventId("evt-session-closed-after-one-off"),
        kind: "session",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "session/closed",
        message: "Session stopped",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "session.exited");
      assert.equal(firstEvent.value.threadId, "thread-1");
    }),
  );

  it.effect("maps retryable Codex error notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-retryable-error"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "error",
        turnId: asTurnId("turn-1"),
        payload: {
          error: {
            message: "Reconnecting... 2/5",
          },
          willRetry: true,
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.message, "Reconnecting... 2/5");
    }),
  );

  it.effect("maps hook/started notifications to hook.started runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-hook-started"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "hook/started",
        turnId: asTurnId("turn-1"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          run: {
            id: "hook-1",
            eventName: "pre_tool_use",
            status: "running",
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "hook.started");
      if (firstEvent.value.type !== "hook.started") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.deepEqual(firstEvent.value.payload, {
        hookId: "hook-1",
        hookName: "pre_tool_use",
        hookEvent: "pre_tool_use",
      });
    }),
  );

  it.effect("maps hook/completed notifications with normalized outcomes and output", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-hook-completed"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "hook/completed",
        turnId: asTurnId("turn-1"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          run: {
            id: "hook-1",
            eventName: "post_tool_use",
            status: "completed",
            statusMessage: "Saved context",
            entries: [{ text: "First line" }, { text: "Second line" }],
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "hook.completed");
      if (firstEvent.value.type !== "hook.completed") {
        return;
      }
      assert.deepEqual(firstEvent.value.payload, {
        hookId: "hook-1",
        hookName: "post_tool_use",
        hookEvent: "post_tool_use",
        outcome: "success",
        rawStatus: "completed",
        statusMessage: "Saved context",
        entries: [{ text: "First line" }, { text: "Second line" }],
        output: "Saved context\n\nFirst line\n\nSecond line",
      });
    }),
  );

  it.effect("maps defensive hook/completed running status to an error outcome", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-hook-running"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "hook/completed",
        payload: {
          threadId: "thread-1",
          run: {
            id: "hook-2",
            eventName: "post_tool_use",
            status: "running",
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "hook.completed");
      if (firstEvent.value.type !== "hook.completed") {
        return;
      }
      assert.equal(firstEvent.value.payload.outcome, "error");
    }),
  );

  it.effect("maps stopped postToolUse hooks to successful output replacements", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-hook-output-replaced"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "hook/completed",
        turnId: asTurnId("turn-1"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          run: {
            id: "hook-output-replaced",
            eventName: "post_tool_use",
            status: "stopped",
            entries: [{ text: "PostToolUse hook stopped execution" }],
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "hook.completed") {
        return;
      }
      assert.deepEqual(firstEvent.value.payload, {
        hookId: "hook-output-replaced",
        hookName: "post_tool_use",
        hookEvent: "post_tool_use",
        outcome: "success",
        rawStatus: "stopped",
        entries: [{ text: "PostToolUse hook stopped execution" }],
        output: "PostToolUse hook stopped execution",
      });
    }),
  );

  it.effect("keeps other stopped hook events cancelled", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-hook-cancelled"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "hook/completed",
        payload: {
          threadId: "thread-1",
          run: {
            id: "hook-cancelled",
            eventName: "preToolUse",
            status: "stopped",
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "hook.completed") {
        return;
      }
      assert.equal(firstEvent.value.payload.outcome, "cancelled");
      assert.equal(firstEvent.value.payload.rawStatus, "stopped");
    }),
  );

  it.effect("preserves completed hook metadata and correlates Windows source paths safely", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      const providerItemId = "exec-4c585f9f-caa8-4cec-86a1-d7e292df4d65";

      lifecycleManager.emit("event", {
        id: asEventId("evt-hook-metadata"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "hook/completed",
        turnId: asTurnId("turn-1"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          run: {
            id: `pre-tool-use:2:C:\\Users\\dev\\hooks-codex.json:${providerItemId}`,
            eventName: "preToolUse",
            handlerType: "command",
            executionMode: "sync",
            scope: "turn",
            source: "plugin",
            sourcePath: "C:\\Users\\dev\\hooks-codex.json",
            displayOrder: 2,
            status: "blocked",
            statusMessage: "Policy blocked the command",
            startedAt: 1_000,
            completedAt: 1_025,
            durationMs: 25,
            entries: [{ kind: "stderr", text: "blocked" }],
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "hook.completed") {
        return;
      }
      assert.equal(firstEvent.value.itemId, providerItemId);
      assert.deepEqual(firstEvent.value.payload, {
        hookId: `pre-tool-use:2:C:\\Users\\dev\\hooks-codex.json:${providerItemId}`,
        hookName: "preToolUse",
        hookEvent: "preToolUse",
        outcome: "error",
        targetItemId: providerItemId,
        handlerType: "command",
        executionMode: "sync",
        scope: "turn",
        source: "plugin",
        sourcePath: "C:\\Users\\dev\\hooks-codex.json",
        displayOrder: 2,
        rawStatus: "blocked",
        statusMessage: "Policy blocked the command",
        startedAt: 1_000,
        completedAt: 1_025,
        durationMs: 25,
        entries: [{ kind: "stderr", text: "blocked" }],
        output: "Policy blocked the command\n\nblocked",
      });
    }),
  );

  it.effect("maps MCP startup status notifications to mcp.status.updated runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-mcp-startup-status"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "mcpServer/startupStatus/updated",
        payload: {
          name: "filesystem",
          status: "failed",
          error: "connection refused",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "mcp.status.updated");
      if (firstEvent.value.type !== "mcp.status.updated") {
        return;
      }
      assert.deepEqual(firstEvent.value.payload.status, {
        name: "filesystem",
        status: "failed",
        error: "connection refused",
      });
    }),
  );

  it.effect("preserves request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-request-resolved"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "serverRequest/resolved",
        requestId: ApprovalRequestId.makeUnsafe("req-1"),
        payload: {
          request: {
            method: "item/commandExecution/requestApproval",
          },
          decision: "accept",
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      assert.equal(firstEvent.value.payload.requestType, "command_execution_approval");
    }),
  );

  it.effect("normalizes Codex thread token usage snapshots", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      const usagePayload = {
        threadId: "codex-thread-1",
        turnId: "turn-usage-1",
        tokenUsage: {
          total: {
            totalTokens: 56_249_600,
            inputTokens: 56_103_983,
            cachedInputTokens: 53_735_936,
            outputTokens: 145_617,
            reasoningOutputTokens: 64_521,
          },
          last: {
            totalTokens: 157_823,
            inputTokens: 157_043,
            cachedInputTokens: 153_984,
            outputTokens: 780,
            reasoningOutputTokens: 516,
          },
          modelContextWindow: 258_400,
        },
      };

      const event: ProviderEvent = {
        id: asEventId("evt-thread-token-usage"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "thread/tokenUsage/updated",
        turnId: asTurnId("turn-usage-1"),
        payload: usagePayload,
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "thread.token-usage.updated");
      if (firstEvent.value.type !== "thread.token-usage.updated") {
        return;
      }
      assert.deepEqual(firstEvent.value.payload, {
        usage: usagePayload,
        contextTokens: 157_823,
        modelContextWindowTokens: 258_400,
      });
    }),
  );

  it.effect("preserves file-read request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-file-read-request-resolved"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "serverRequest/resolved",
        requestId: ApprovalRequestId.makeUnsafe("req-file-read-1"),
        payload: {
          request: {
            method: "item/fileRead/requestApproval",
          },
          decision: "accept",
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      assert.equal(firstEvent.value.payload.requestType, "file_read_approval");
    }),
  );

  it.effect("maps Codex permission approval requests to canonical request events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-permission-request"),
        kind: "request",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "item/permissions/requestApproval",
        requestId: ApprovalRequestId.makeUnsafe("req-permissions-1"),
        payload: {
          reason: "Network access requested",
          permissions: {
            network: true,
          },
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "request.opened");
      if (firstEvent.value.type !== "request.opened") {
        return;
      }
      assert.equal(firstEvent.value.payload.requestType, "permissions_approval");
      assert.equal(firstEvent.value.payload.detail, "Network access requested");
      assert.deepEqual(firstEvent.value.payload.requestedPermissions, {
        network: true,
      });
    }),
  );

  it.effect("preserves explicit empty multi-select user-input answers", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-user-input-empty"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "item/tool/requestUserInput/answered",
        payload: {
          answers: {
            scope: [],
          },
        },
      };

      lifecycleManager.emit("event", event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "user-input.resolved");
      if (firstEvent.value.type !== "user-input.resolved") {
        return;
      }
      assert.deepEqual(firstEvent.value.payload.answers, {
        scope: [],
      });
    }),
  );

  it.effect("maps fatal websocket stderr notifications to runtime.error", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-process-stderr-fatal"),
        kind: "error",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "process/stderr",
        message: "Failed to connect to websocket after retrying",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.error");
      if (firstEvent.value.type !== "runtime.error") {
        return;
      }
      assert.equal(firstEvent.value.payload.class, "provider_error");
      assert.equal(
        firstEvent.value.payload.message,
        "Failed to connect to websocket after retrying",
      );
    }),
  );

  it.effect("maps malformed protocol records to non-terminal protocol warnings", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 3)).pipe(
        Effect.forkChild,
      );
      const createdAt = new Date().toISOString();

      for (const [index, method] of [
        "protocol/parseError",
        "protocol/invalidMessage",
        "protocol/unrecognizedMessage",
      ].entries()) {
        lifecycleManager.emit("event", {
          id: asEventId(`evt-protocol-warning-${index}`),
          kind: "error",
          provider: "codex",
          threadId: asThreadId("thread-1"),
          createdAt,
          method,
          message: `Malformed record ${index + 1}`,
          payload: {
            recordByteLength: 1_024 + index,
            recordSha256: `${index}`.repeat(64),
            occurrence: index + 1,
          },
        } satisfies ProviderEvent);
      }

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.deepEqual(
        events.map((event) => event.type),
        ["runtime.warning", "runtime.warning", "runtime.warning"],
      );
      for (const [index, event] of events.entries()) {
        assert.equal(event.type, "runtime.warning");
        if (event.type !== "runtime.warning") {
          continue;
        }
        assert.equal(event.payload.category, "protocol");
        assert.equal(event.payload.actionable, false);
        assert.equal(
          event.payload.protocolMethod,
          ["protocol/parseError", "protocol/invalidMessage", "protocol/unrecognizedMessage"][index],
        );
        assert.deepEqual(event.payload.detail, {
          recordByteLength: 1_024 + index,
          recordSha256: `${index}`.repeat(64),
          occurrence: index + 1,
        });
      }
    }),
  );

  it.effect("maps non-fatal stderr notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-process-stderr-warning"),
        kind: "error",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "process/stderr",
        message: "Codex process emitted a deprecation warning",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.payload.message, "Codex process emitted a deprecation warning");
    }),
  );

  it.effect("ignores benign opentelemetry stderr notifications", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      lifecycleManager.emit("event", {
        id: asEventId("evt-process-stderr-opentelemetry"),
        kind: "error",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "process/stderr",
        message:
          '2026-04-10T15:53:06.704277Z ERROR opentelemetry_sdk:  name="BatchSpanProcessor.Flush.ExportError" reason="InternalFailure(\\"reqwest::Error { kind: Status(400, None), url: \\\\\\"https://otel-mobile.doordash.com/v1/logs\\\\\\" }\\")" Failed during the export process',
      } satisfies ProviderEvent);

      lifecycleManager.emit("event", {
        id: asEventId("evt-process-stderr-warning-after-opentelemetry"),
        kind: "error",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "process/stderr",
        message: "Codex process emitted a deprecation warning",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.payload.message, "Codex process emitted a deprecation warning");
    }),
  );

  it.effect("maps windowsSandbox/setupCompleted to session state and warning on failure", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );

      const event: ProviderEvent = {
        id: asEventId("evt-windows-sandbox-failed"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "windowsSandbox/setupCompleted",
        message: "Sandbox setup failed",
        payload: {
          success: false,
          detail: "unsupported environment",
        },
      };

      lifecycleManager.emit("event", event);
      const events = Array.from(yield* Fiber.join(eventsFiber));

      assert.equal(events.length, 2);

      const firstEvent = events[0];
      const secondEvent = events[1];

      assert.equal(firstEvent?.type, "session.state.changed");
      if (firstEvent?.type === "session.state.changed") {
        assert.equal(firstEvent.payload.state, "error");
        assert.equal(firstEvent.payload.reason, "Sandbox setup failed");
      }

      assert.equal(secondEvent?.type, "runtime.warning");
      if (secondEvent?.type === "runtime.warning") {
        assert.equal(secondEvent.payload.message, "Sandbox setup failed");
      }
    }),
  );

  it.effect(
    "maps requestUserInput requests and answered notifications to canonical user-input events",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
          Effect.forkChild,
        );

        lifecycleManager.emit("event", {
          id: asEventId("evt-user-input-requested"),
          kind: "request",
          provider: "codex",
          threadId: asThreadId("thread-1"),
          createdAt: new Date().toISOString(),
          method: "item/tool/requestUserInput",
          requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
          payload: {
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "workspace-write",
                    description: "Allow workspace writes only",
                  },
                ],
              },
            ],
          },
        } satisfies ProviderEvent);
        lifecycleManager.emit("event", {
          id: asEventId("evt-user-input-resolved"),
          kind: "notification",
          provider: "codex",
          threadId: asThreadId("thread-1"),
          createdAt: new Date().toISOString(),
          method: "item/tool/requestUserInput/answered",
          requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
          payload: {
            answers: {
              sandbox_mode: {
                answers: ["workspace-write"],
              },
            },
          },
        } satisfies ProviderEvent);

        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.equal(events[0]?.type, "user-input.requested");
        if (events[0]?.type === "user-input.requested") {
          assert.equal(events[0].requestId, "req-user-input-1");
          assert.equal(events[0].payload.questions[0]?.id, "sandbox_mode");
        }

        assert.equal(events[1]?.type, "user-input.resolved");
        if (events[1]?.type === "user-input.resolved") {
          assert.equal(events[1].requestId, "req-user-input-1");
          assert.deepEqual(events[1].payload.answers, {
            sandbox_mode: "workspace-write",
          });
        }
      }),
  );

  it.effect("maps Codex task and reasoning event chunks into canonical runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
        Effect.forkChild,
      );

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-task-started"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "codex/event/task_started",
        payload: {
          id: "turn-structured-1",
          msg: {
            type: "task_started",
            turn_id: "turn-structured-1",
            collaboration_mode_kind: "plan",
          },
        },
      } satisfies ProviderEvent);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-agent-reasoning"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "codex/event/agent_reasoning",
        payload: {
          id: "turn-structured-1",
          msg: {
            type: "agent_reasoning",
            text: "Need to compare both transport layers before finalizing the plan.",
          },
        },
      } satisfies ProviderEvent);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-reasoning-delta"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "codex/event/reasoning_content_delta",
        payload: {
          id: "turn-structured-1",
          msg: {
            type: "reasoning_content_delta",
            turn_id: "turn-structured-1",
            item_id: "rs_reasoning_1",
            delta: "**Compare** transport boundaries",
            summary_index: 0,
          },
        },
      } satisfies ProviderEvent);

      lifecycleManager.emit("event", {
        id: asEventId("evt-codex-task-complete"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "codex/event/task_complete",
        payload: {
          id: "turn-structured-1",
          msg: {
            type: "task_complete",
            turn_id: "turn-structured-1",
            last_agent_message: "<proposed_plan>\n# Ship it\n</proposed_plan>",
          },
        },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));

      assert.equal(events[0]?.type, "task.started");
      if (events[0]?.type === "task.started") {
        assert.equal(events[0].turnId, "turn-structured-1");
        assert.equal(events[0].payload.taskId, "turn-structured-1");
        assert.equal(events[0].payload.taskType, "plan");
      }

      assert.equal(events[1]?.type, "task.progress");
      if (events[1]?.type === "task.progress") {
        assert.equal(events[1].payload.taskId, "turn-structured-1");
        assert.equal(
          events[1].payload.description,
          "Need to compare both transport layers before finalizing the plan.",
        );
      }

      assert.equal(events[2]?.type, "content.delta");
      if (events[2]?.type === "content.delta") {
        assert.equal(events[2].turnId, "turn-structured-1");
        assert.equal(events[2].itemId, "rs_reasoning_1");
        assert.equal(events[2].payload.streamKind, "reasoning_summary_text");
        assert.equal(events[2].payload.summaryIndex, 0);
      }

      assert.equal(events[3]?.type, "task.completed");
      if (events[3]?.type === "task.completed") {
        assert.equal(events[3].turnId, "turn-structured-1");
        assert.equal(events[3].payload.taskId, "turn-structured-1");
        assert.equal(events[3].payload.summary, "<proposed_plan>\n# Ship it\n</proposed_plan>");
      }

      assert.equal(events[4]?.type, "turn.proposed.completed");
      if (events[4]?.type === "turn.proposed.completed") {
        assert.equal(events[4].turnId, "turn-structured-1");
        assert.equal(events[4].payload.planMarkdown, "# Ship it");
      }
    }),
  );
});

afterAll(() => {
  if (lifecycleManager.stopAllImpl.mock.calls.length === 0) {
    lifecycleManager.stopAll();
  }
  assert.ok(lifecycleManager.stopAllImpl.mock.calls.length >= 1);
});
