import assert from "node:assert/strict";
import {
  ApprovalRequestId,
  EventId,
  ProviderItemId,
  ProviderInstanceId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, it, vi } from "@effect/vitest";

import { Deferred, Effect, Fiber, Layer, Option, Stream } from "effect";
import { holdsAutomaticResume, isBlockingUserInput } from "@t3tools/shared/pendingUserInputs";
import { getDefaultReasoningEffort, normalizeCodexModelOptions } from "@t3tools/shared/model";

import {
  CodexAppServerManager,
  CodexJsonRpcError,
  buildCodexTurnStartParams,
  type CodexAppServerStartSessionInput,
  type CodexAppServerSendTurnInput,
} from "../../codexAppServerManager.ts";
import { ServerConfig } from "../../config.ts";
import * as browserAccess from "../../mcp/browserAccess.ts";
import * as codexChromeIntegration from "../codexChromeIntegration.ts";
import * as codexExecutable from "../codexExecutable.ts";
import { CommandNotFoundError } from "../../spawn/resolveCommand.ts";
import { CodexAdapter, type CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { readRuntimeConfiguredPayload } from "@t3tools/shared/orchestrationActivityPayload";
import {
  codexReasoningTokensSinceBaseline,
  hookTargetItemId,
  makeCodexAdapterLive,
  normalizeCodexThreadItemType,
  observeCodexChrome,
  trackCodexChromeCall,
  withAgentBrowserPreview,
  type CodexAdapterLiveOptions,
} from "./CodexAdapter.ts";
import { CodexChromeSession } from "../codexChromeSession.ts";
import { normalizeTurnUsage } from "../../usage/usageMetrics.ts";

it("reports Codex's preview as verified, so its chip can reach ready", () => {
  const [event] = withAgentBrowserPreview(
    [
      {
        type: "session.configured",
        eventId: EventId.makeUnsafe("evt-configured"),
        provider: "codex",
        threadId: ThreadId.makeUnsafe("thread-preview"),
        createdAt: "2026-10-09T00:00:00.000Z",
        payload: { config: { model: "gpt-5.5" } },
      },
    ],
    "f5_preview",
  );
  assert.equal(event?.type, "session.configured");
  if (event?.type !== "session.configured") return;
  assert.deepEqual(readRuntimeConfiguredPayload(event.payload)?.agentBrowser?.preview, {
    serverName: "f5_preview",
    installed: true,
    verified: true,
  });
});

it("diffs Codex reasoning totals against the session baseline", () => {
  const frame = (total: number | undefined, last: number | undefined) => ({
    tokenUsage: {
      ...(total !== undefined ? { total: { reasoningOutputTokens: total } } : {}),
      ...(last !== undefined ? { last: { reasoningOutputTokens: last } } : {}),
    },
  });
  assert.deepEqual(codexReasoningTokensSinceBaseline(frame(9_000, 300), undefined), {
    tokens: 300,
    baseline: 9_000,
  });
  assert.deepEqual(codexReasoningTokensSinceBaseline(frame(9_250, 250), 9_000), {
    tokens: 250,
    baseline: 9_250,
  });
  assert.deepEqual(codexReasoningTokensSinceBaseline(frame(9_000, 0), 9_000), {
    tokens: 0,
    baseline: 9_000,
  });
  // A total that went backwards (new rollout) restarts from `last`.
  assert.deepEqual(codexReasoningTokensSinceBaseline(frame(100, 100), 9_000), {
    tokens: 100,
    baseline: 100,
  });
  assert.equal(codexReasoningTokensSinceBaseline({}, undefined), undefined);
  // A `last`-only frame keeps a missing baseline missing, so the next `total`
  // (a resumed thread's whole history) is not attributed.
  const lastOnly = codexReasoningTokensSinceBaseline(frame(undefined, 120), undefined);
  assert.deepEqual(lastOnly, { tokens: 120, baseline: undefined });
  assert.deepEqual(codexReasoningTokensSinceBaseline(frame(64_521, 80), lastOnly?.baseline), {
    tokens: 80,
    baseline: 64_521,
  });
});

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

  public rollbackThreadImpl = vi.fn(
    async (_threadId: ThreadId, _numTurns: number, _beforeTurnId?: string) => ({
      threadId: asThreadId("thread-1"),
      turns: [],
    }),
  );

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

  override rollbackThread(threadId: ThreadId, numTurns: number, beforeTurnId?: string) {
    return this.rollbackThreadImpl(threadId, numTurns, beforeTurnId);
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

it.effect(
  "matches the reactor's disabled computer fingerprint in web mode despite enabled settings",
  () => {
    const manager = new FakeCodexManager();
    const policy = vi
      .spyOn(browserAccess, "resolveAgentBrowserPolicy")
      .mockReturnValue(Effect.succeed({ computerUse: true, codexChrome: false } as never));
    const layer = makeCodexAdapterLive({ manager }).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "codex-web-computer-" }, { mode: "web" }),
      ),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => policy.mockRestore()));
      const adapter = yield* CodexAdapter;
      const session = yield* adapter.startSession({
        threadId: asThreadId("web-computer"),
        runtimeMode: "full-access",
      });
      // Reconciliation compares this recorded launch fingerprint on every turn.
      assert.equal(JSON.parse(session.computerConfigurationFingerprint!).enabled, false);
      assert.equal(session.computerToolsInstalled, false);
      assert.equal(session.computerBackendSelection, undefined);
    }).pipe(Effect.provide(layer), Effect.scoped);
  },
);

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
  updateMcpStateIfCurrent: () => Effect.succeed(true),
  updateHistoryReconciliationIfCurrent: () => Effect.succeed(true),
  updateTerminalLifecycleIfCurrent: () => Effect.succeed(true),
  listBindingsByProject: () => Effect.succeed([]),
});
const validationManager = new FakeCodexManager();
it.effect(
  "leaves inherited tiers to Codex and honors explicit choices on every prompt path",
  () => {
    const manager = new FakeCodexManager();
    const layer = makeCodexAdapterLive({
      manager,
      getEffectiveModelCapabilities: () =>
        new Map([
          [
            "gpt-test",
            {
              source: "reported" as const,
              supportsFastMode: true,
              defaultServiceTier: "priority",
            },
          ],
        ]),
    }).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );
    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      for (const [options, expected] of [
        [[], null],
        [[{ id: "fastMode", value: false }], "default"],
        [[{ id: "fastMode", value: true }], "fast"],
      ] as const) {
        manager.sendTurnImpl.mockClear();
        yield* adapter.sendTurn({
          threadId: asThreadId("inherited-tier"),
          input: "Go",
          model: "gpt-test",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-test",
            options,
          },
        });
        assert.equal(manager.sendTurnImpl.mock.calls.length, 1);
        assert.equal(manager.sendTurnImpl.mock.calls.at(-1)?.[0].serviceTier, expected);
      }
      yield* adapter.sendTurn({
        threadId: asThreadId("inherited-tier"),
        input: "Continue",
        model: "gpt-test",
      });
      assert.equal(manager.sendTurnImpl.mock.calls.length, 2);
      assert.equal(Object.hasOwn(manager.sendTurnImpl.mock.calls.at(-1)![0], "serviceTier"), false);
      for (const [fastMode, expected] of [
        [undefined, undefined],
        [false, "default"],
        [true, "fast"],
      ] as const) {
        const modelSelection = {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-test",
          options: fastMode === undefined ? [] : [{ id: "fastMode", value: fastMode }],
        };
        yield* adapter.runOneOffPrompt!({
          threadId: asThreadId("inherited-tier"),
          provider: "codex",
          prompt: "Summarize",
          modelSelection,
        });
        assert.equal(manager.runOneOffPromptImpl.mock.calls.at(-1)![0].serviceTier, expected);
        yield* adapter.startSession({
          threadId: asThreadId("inherited-tier"),
          runtimeMode: "full-access",
          model: "gpt-test",
          modelSelection,
        });
        assert.equal(manager.startSessionImpl.mock.calls.at(-1)![0].serviceTier, expected);
      }
      assert.equal(manager.runOneOffPromptImpl.mock.calls.length, 3);
      assert.equal(manager.startSessionImpl.mock.calls.length, 3);
    }).pipe(Effect.provide(layer), Effect.scoped);
  },
);

const validationLayer = it.layer(
  makeCodexAdapterLive({ manager: validationManager }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

validationLayer("CodexAdapterLive validation", (it) => {
  it.effect("rejects excessive MCP start and reload inputs before manager mutation", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const mcpServers = Object.fromEntries(
        Array.from({ length: 33 }, (_, i) => [
          `s${i}`,
          { type: "stdio" as const, command: "node" },
        ]),
      );
      validationManager.startSessionImpl.mockClear();
      const reload = vi.spyOn(validationManager, "reloadMcpConfig");
      try {
        const started = yield* adapter
          .startSession({
            threadId: asThreadId("mcp-overflow"),
            runtimeMode: "approval-required",
            providerOptions: { mcpServers },
          })
          .pipe(Effect.result);
        assert.equal(started._tag, "Failure");
        assert.equal(validationManager.startSessionImpl.mock.calls.length, 0);
        const reloaded = yield* adapter.reloadMcpConfig!({
          threadId: asThreadId("mcp-overflow"),
          mcpServers,
        }).pipe(Effect.result);
        assert.equal(reloaded._tag, "Failure");
        assert.equal(reload.mock.calls.length, 0);
      } finally {
        reload.mockRestore();
      }
    }),
  );

  it.effect("requires a restart before sending a reload RPC when launch MCP config differs", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("mcp-launch-key");
      yield* adapter.startSession({
        threadId,
        runtimeMode: "approval-required",
        providerOptions: { mcpServers: { docs: { type: "stdio", command: "old-command" } } },
      });
      const reload = vi.spyOn(validationManager, "reloadMcpConfig");
      try {
        const result = yield* adapter.reloadMcpConfig!({
          threadId,
          mcpServers: { docs: { type: "stdio", command: "new-command" } },
        });
        assert.equal(result.restartRequired, true);
        assert.equal(reload.mock.calls.length, 0);
      } finally {
        reload.mockRestore();
      }
    }),
  );

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

  it.effect("takes the thread-start fast mode from a bound selection", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      for (const fastMode of [true, false]) {
        validationManager.startSessionImpl.mockClear();
        yield* adapter.startSession({
          provider: "codex",
          threadId: asThreadId(`thread-fast-${fastMode}`),
          modelOptions: { codex: { fastMode: !fastMode } },
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.3-codex",
            options: [{ id: "fastMode", value: fastMode }],
          },
          runtimeMode: "full-access",
        });
        const request = validationManager.startSessionImpl.mock.calls[0]?.[0];
        assert.equal(request?.serviceTier, fastMode ? "fast" : undefined);
      }
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

  it.effect("forwards the revert boundary and labels errors with the method that failed", () =>
    Effect.gen(function* () {
      validationManager.rollbackThreadImpl.mockClear();
      const adapter = yield* CodexAdapter;

      yield* adapter.rollbackThread(asThreadId("thread-1"), 2, { beforeTurnId: "turn-2" });
      assert.deepStrictEqual(validationManager.rollbackThreadImpl.mock.calls[0], [
        asThreadId("thread-1"),
        2,
        "turn-2",
      ]);

      validationManager.rollbackThreadImpl.mockRejectedValueOnce(
        new CodexJsonRpcError("thread/rollback", -32600, "Invalid request: unknown variant"),
      );
      const failure = yield* Effect.flip(adapter.rollbackThread(asThreadId("thread-1"), 1));
      assert.equal(failure._tag, "ProviderAdapterRequestError");
      assert.equal(
        failure._tag === "ProviderAdapterRequestError" ? failure.method : "",
        "thread/rollback",
      );
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
  for (const fastMode of [undefined, false, true]) {
    it.effect(`preserves Codex tier presence for summary fastMode=${fastMode}`, () =>
      Effect.gen(function* () {
        configuredManager.runOneOffPromptImpl.mockClear();
        const adapter = yield* CodexAdapter;
        yield* adapter.runOneOffPrompt!({
          threadId: asThreadId("summary-tier"),
          provider: "codex",
          prompt: "Summarize",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex-work"),
            model: "gpt-5.6-luna",
            ...(fastMode !== undefined ? { options: [{ id: "fastMode", value: fastMode }] } : {}),
          },
        });
        const request = configuredManager.runOneOffPromptImpl.mock.calls[0]?.[0];
        assert.equal(request?.serviceTier, fastMode ? "fast" : undefined);
        assert.equal(Object.hasOwn(request!, "serviceTier"), fastMode === true);
      }),
    );
  }

  it.effect("uses the selected summary model, effort, and instance defaults", () =>
    Effect.gen(function* () {
      configuredManager.runOneOffPromptImpl.mockClear();
      const adapter = yield* CodexAdapter;
      yield* adapter.runOneOffPrompt!({
        threadId: asThreadId("summary"),
        provider: "codex",
        prompt: "Summarize",
        model: "gpt-6-astra",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex-work"),
          model: "gpt-5.6-luna",
          options: [{ id: "reasoningEffort", value: "low" }],
        },
      });
      assert.deepStrictEqual(configuredManager.runOneOffPromptImpl.mock.calls[0]?.[0], {
        prompt: "Summarize",
        model: "gpt-5.6-luna",
        effort: "low",
        providerOptions: {
          codex: {
            binaryPath: "/configured/codex",
            homePath: "/configured/home",
            launchArgs: ["--enable=configured"],
          },
        },
      });
    }),
  );
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

  const sendSelectionTurn = (
    input: Partial<Parameters<CodexAdapterShape["sendTurn"]>[0]>,
  ): Effect.Effect<CodexAppServerSendTurnInput | undefined, never, CodexAdapter> =>
    Effect.gen(function* () {
      sessionErrorManager.sendTurnImpl.mockClear();
      const adapter = yield* CodexAdapter;
      yield* Effect.ignore(
        adapter.sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "hello",
          model: "gpt-5.3-codex",
          attachments: [],
          ...input,
        }),
      );
      return sessionErrorManager.sendTurnImpl.mock.calls[0]?.[0];
    });

  it.effect("adds app context to native turn input without changing the user's input", () =>
    Effect.gen(function* () {
      const context = '\n<untrusted_mcp_app_state>{"city":"Berlin"}</untrusted_mcp_app_state>';
      const request = yield* sendSelectionTurn({ mcpAppContext: context });
      assert.equal(request?.input, `hello${context}`);
      assert.equal(request?.threadId, asThreadId("sess-missing"));
    }),
  );

  it.effect("reads effort and fast mode from a selection bound to this instance", () =>
    Effect.gen(function* () {
      const request = yield* sendSelectionTurn({
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.3-codex",
          options: [
            { id: "reasoningEffort", value: "xhigh" },
            { id: "fastMode", value: true },
          ],
        },
      });
      assert.equal(request?.effort, "xhigh");
      assert.equal(request?.serviceTier, "fast");
    }),
  );

  it.effect("prefers a bound selection over conflicting modelOptions", () =>
    Effect.gen(function* () {
      const request = yield* sendSelectionTurn({
        modelOptions: { codex: { reasoningEffort: "low", fastMode: true } },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.3-codex",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });
      assert.equal(request?.effort, "high");
      assert.equal(request?.serviceTier, null);
    }),
  );

  it.effect("falls back to modelOptions for a selection from another instance", () =>
    Effect.gen(function* () {
      const request = yield* sendSelectionTurn({
        modelOptions: { codex: { reasoningEffort: "low", fastMode: true } },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex-work"),
          model: "gpt-5.3-codex",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });
      assert.equal(request?.effort, "low");
      assert.equal(request?.serviceTier, "fast");
    }),
  );

  it.effect("turns fast mode off when a later composer turn omits it", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex");
      const fast = yield* sendSelectionTurn({
        modelSelection: {
          instanceId,
          model: "gpt-5.3-codex",
          options: [{ id: "fastMode", value: true }],
        },
      });
      assert.equal(fast?.serviceTier, "fast");
      // The composer strips `fastMode: false` before sending.
      const off = yield* sendSelectionTurn({
        modelSelection: { instanceId, model: "gpt-5.3-codex" },
      });
      assert.equal(off?.serviceTier, null);
      assert.equal(Object.hasOwn(off!, "effort"), false);
    }),
  );

  it.effect("keeps the thread tier for a turn that states no Codex options", () =>
    Effect.gen(function* () {
      const request = yield* sendSelectionTurn({});
      assert.equal(Object.hasOwn(request!, "serviceTier"), false);
      const otherInstance = yield* sendSelectionTurn({
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex-work"),
          model: "gpt-5.3-codex",
        },
      });
      assert.equal(Object.hasOwn(otherInstance!, "serviceTier"), false);
    }),
  );

  it.effect("resolves the composer's stripped default effort to the same default", () =>
    Effect.gen(function* () {
      const model = "gpt-5.3-codex";
      const normalized = normalizeCodexModelOptions(model, {
        reasoningEffort: getDefaultReasoningEffort("codex", model),
      });
      assert.equal(normalized?.reasoningEffort, undefined);
      const request = yield* sendSelectionTurn(
        normalized ? { modelOptions: { codex: normalized } } : {},
      );
      const params = buildCodexTurnStartParams(request!, {
        providerThreadId: "thread",
        account: { type: "unknown", planType: null, sparkEnabled: false },
      });
      assert.equal(params.effort, getDefaultReasoningEffort("codex", model));
      assert.equal(
        params.collaborationMode?.settings.reasoning_effort,
        getDefaultReasoningEffort("codex", model),
      );
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
  it.effect(
    "delivers questions and terminal before Stop or session close with an unfinished image",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        const questionSeen = yield* Deferred.make<void>();
        const terminalSeen = yield* Deferred.make<void>();
        const events: ProviderRuntimeEvent[] = [];
        const collected = yield* adapter.streamEvents.pipe(
          Stream.take(5),
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              events.push(event);
              if (event.type === "user-input.requested")
                yield* Deferred.succeed(questionSeen, undefined);
              if (event.type === "turn.completed") yield* Deferred.succeed(terminalSeen, undefined);
            }),
          ),
          Effect.forkChild,
        );
        const emit = (method: string, item?: Record<string, unknown>) =>
          lifecycleManager.emit("event", {
            id: asEventId("image-lifecycle:" + method + ":" + String(item?.id)),
            kind: "notification",
            provider: "codex",
            threadId: asThreadId("image-lifecycle"),
            turnId: asTurnId("image-lifecycle-turn"),
            ...(item ? { itemId: asItemId(String(item.id)) } : {}),
            createdAt: new Date().toISOString(),
            method,
            payload: item ? { item } : { turn: { status: "completed" } },
          } satisfies ProviderEvent);
        emit("item/started", { type: "imageGeneration", id: "pending-image" });
        emit("item/completed", {
          type: "agentMessage",
          id: "question",
          delivery: "async",
          questions: [{ title: "Choose?" }],
        });
        yield* Deferred.await(questionSeen);
        emit("item/completed", { type: "agentMessage", id: "answer", text: "Done." });
        emit("turn/completed");
        yield* Deferred.await(terminalSeen);
        yield* adapter.interruptTurn(
          asThreadId("image-lifecycle"),
          asTurnId("image-lifecycle-turn"),
        );
        emit("session/closed");
        yield* Fiber.join(collected);
        assert.deepEqual(
          events.map((event) => event.type),
          [
            "item.started",
            "user-input.requested",
            "item.completed",
            "turn.completed",
            "session.exited",
          ],
        );
      }),
  );
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
        id: asEventId("evt-thread-reverted"),
        method: "thread/reverted",
        payload: { threadId: "thread-1" },
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
        id: asEventId("evt-function-call-output"),
        method: "item/completed",
        itemId: asItemId("function-output-1"),
        payload: {
          item: { type: "functionCallOutput", id: "function-output-1", name: "shell", output: "" },
        },
      } satisfies ProviderEvent);
      lifecycleManager.emit("event", {
        ...base,
        id: asEventId("evt-raw-response-usage"),
        method: "rawResponse/completed",
        payload: { threadId: "thread-1", turnId: "turn-1", responseId: "resp-1", usage: null },
      } satisfies ProviderEvent);
      lifecycleManager.emit("event", {
        ...base,
        id: asEventId("evt-queue-changed"),
        method: "thread/queue/changed",
        payload: { threadId: "thread-1" },
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

  it.effect("rejects multiple text-derived plan blocks while preserving task completion", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.started"),
        Stream.runCollect,
        Effect.forkChild,
      );
      lifecycleManager.emit("event", {
        id: asEventId("bad-text-plan"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "codex/event/task_complete",
        payload: {
          id: "turn-1",
          msg: {
            last_agent_message:
              "<proposed_plan>\nFirst\n</proposed_plan>\nMore text\n<proposed_plan>\nSecond\n</proposed_plan>",
          },
        },
      } satisfies ProviderEvent);
      lifecycleManager.emit("event", {
        id: asEventId("after-bad-plan"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        turnId: asTurnId("turn-2"),
        method: "turn/started",
        payload: { turn: { id: "turn-2" } },
      } satisfies ProviderEvent);
      const events = yield* Fiber.join(eventsFiber);
      assert.equal(
        events.some((event) => event.type === "turn.proposed.completed"),
        false,
      );
      assert.equal(
        events.some((event) => event.type === "task.completed"),
        true,
      );
    }),
  );

  it.effect("ignores a turn start without an id before accepting an owned turn", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.started"),
        Stream.runCollect,
        Effect.forkChild,
      );
      lifecycleManager.emit("event", {
        id: asEventId("untargeted-start"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "turn/started",
        payload: { turn: {} },
      } satisfies ProviderEvent);
      lifecycleManager.emit("event", {
        id: asEventId("owned-start"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        turnId: asTurnId("owned-turn"),
        method: "turn/started",
        payload: { turn: { id: "owned-turn" } },
      } satisfies ProviderEvent);
      const events = yield* Fiber.join(eventsFiber);
      assert.deepEqual(
        events.filter((event) => event.type === "turn.started").map((event) => event.turnId),
        ["owned-turn"],
      );
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
            fileId: "image-result",
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
          item: { type: "sleep", id: "sleep-1", startedAtMs: 100, completedAtMs: 1600 },
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
            model: "openai.gpt-6-sol",
            reasoningEffort: "high",
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
        events[0]?.type === "item.completed" ? events[0].payload.detail : undefined,
        "/tmp/generated.png",
      );
      assert.equal(
        events[1]?.type === "item.completed" ? events[1].payload.detail : undefined,
        "1.5s",
      );
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
          model: "openai.gpt-6-sol",
          reasoningEffort: "high",
        });
      }
    }),
  );

  it.effect("maps all subagent kinds through both lifecycle notifications", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const cases = ["started", "interacted", "interrupted", "completed"].flatMap((kind) =>
        ["item/started", "item/completed"].flatMap((method) =>
          [false, true].map((snakeCase) => ({ kind, method, snakeCase })),
        ),
      );
      const eventsFiber = yield* Stream.runCollect(
        Stream.take(adapter.streamEvents, cases.length),
      ).pipe(Effect.forkChild);
      const createdAt = "2026-09-23T18:21:12.496Z";

      cases.forEach(({ kind, method, snakeCase }, index) => {
        // Completion items use the same identity for their started/completed pair.
        const itemId = `subagent-${kind}-agent-1`;
        lifecycleManager.emit("event", {
          id: asEventId(`evt-subagent-kind-${index}`),
          kind: "notification",
          provider: "codex",
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-1"),
          itemId: asItemId(itemId),
          createdAt,
          method,
          payload: {
            item: {
              type: "subAgentActivity",
              id: itemId,
              kind,
              ...(snakeCase
                ? { agent_thread_id: " agent-1 ", agent_path: " /root/reviewer " }
                : { agentThreadId: "agent-1", agentPath: "/root/reviewer" }),
            },
            threadId: "provider-thread-1",
            turnId: "turn-1",
          },
        } satisfies ProviderEvent);
      });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      events.forEach((event, index) => {
        const kind = cases[index]!.kind;
        assert.equal(event.type, "subagent.activity");
        assert.deepEqual(event.payload, {
          kind,
          agentThreadId: "agent-1",
          agentPath: "/root/reviewer",
        });
        assert.equal(event.itemId, `subagent-${kind}-agent-1`);
        assert.equal(event.providerRefs?.providerItemId, event.itemId);
        assert.equal(event.turnId, "turn-1");
      });
    }),
  );

  it.effect("distinguishes unsupported subagent kinds from malformed kinds and identities", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const cases = [
        { kind: "futureKind", agentThreadId: "agent-1", agentPath: "/root/reviewer" },
        { agentThreadId: "agent-1", agentPath: "/root/reviewer" },
        { kind: null, agentThreadId: "agent-1", agentPath: "/root/reviewer" },
        { kind: 42, agentThreadId: "agent-1", agentPath: "/root/reviewer" },
        { kind: "completed", agentPath: "/root/reviewer" },
        { kind: "completed", agentThreadId: "agent-1" },
        { kind: "completed", agentThreadId: "  ", agentPath: "/root/reviewer" },
        { kind: "completed", agentThreadId: "agent-1", agentPath: "  " },
      ];
      const eventsFiber = yield* Stream.runCollect(
        Stream.take(adapter.streamEvents, cases.length),
      ).pipe(Effect.forkChild);
      cases.forEach((fields, index) => {
        lifecycleManager.emit("event", {
          id: asEventId(`evt-invalid-subagent-${index}`),
          kind: "notification",
          provider: "codex",
          threadId: asThreadId("thread-1"),
          createdAt: "2026-09-23T18:21:12.496Z",
          method: "item/completed",
          payload: { item: { type: "subAgentActivity", id: `invalid-${index}`, ...fields } },
        } satisfies ProviderEvent);
      });
      const events = Array.from(yield* Fiber.join(eventsFiber));
      events.forEach((event, index) => {
        assert.equal(event.type, "runtime.warning");
        if (event.type !== "runtime.warning") return;
        assert.equal(
          event.payload.message,
          index === 0
            ? 'Unsupported Codex subagent activity kind "futureKind".'
            : index < 4
              ? "Malformed Codex subagent activity: expected a string kind."
              : "Malformed Codex subagent activity: expected nonempty agentThreadId and agentPath.",
        );
        assert.equal(event.payload.protocolValue, "subAgentActivity");
        assert.deepEqual(event.payload.detail, {
          item: { type: "subAgentActivity", id: `invalid-${index}`, ...cases[index] },
        });
      });
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
              "Malformed Codex subagent activity: expected nonempty agentThreadId and agentPath.",
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
        turnId: asTurnId("retired-turn"),
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
      assert.equal(firstEvent.value.turnId, "retired-turn");
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

  it.effect("preserves typed rate-limit retry warnings without suggesting the turn stopped", () =>
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
            message: "Rate limit reached, retrying in 1s",
            codexErrorInfo: "usageLimitReached",
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
      assert.equal(firstEvent.value.payload.message, "Rate limit reached, retrying in 1s");
    }),
  );

  it.effect("attaches subscription evidence only to terminal Codex failures", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      for (const method of ["error", "turn/completed"] as const) {
        const first = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
        lifecycleManager.emit("event", {
          id: asEventId(`usage-${method}`),
          kind: "notification",
          provider: "codex",
          threadId: asThreadId("thread-1"),
          createdAt: "2026-10-01T00:00:00Z",
          method,
          turnId: asTurnId("usage-turn"),
          payload:
            method === "error"
              ? {
                  error: {
                    message: "Usage limit reached",
                    codexErrorInfo: { usageLimitExceeded: {} },
                  },
                  willRetry: false,
                }
              : {
                  turn: {
                    id: "usage-turn",
                    status: "failed",
                    error: { message: "Usage limit reached", codexErrorInfo: "usageLimitReached" },
                  },
                },
        } satisfies ProviderEvent);
        const event = yield* Fiber.join(first);
        assert.equal(event._tag, "Some");
        if (
          event._tag === "Some" &&
          (event.value.type === "runtime.error" || event.value.type === "turn.completed")
        ) {
          assert.equal(event.value.payload.usageLimit?.evidence, "typed");
          assert.equal(event.value.payload.usageLimit?.resetsAt, null);
        } else assert.fail("Expected terminal usage failure");
      }
    }),
  );

  it.effect("classifies Codex retry exhaustion on HTTP 429 as a usage limit", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      for (const httpStatusCode of [429, 503]) {
        const first = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
        lifecycleManager.emit("event", {
          id: asEventId(`retry-exhaustion-${httpStatusCode}`),
          kind: "notification",
          provider: "codex",
          threadId: asThreadId("thread-1"),
          createdAt: "2026-10-01T00:00:00Z",
          method: "turn/completed",
          turnId: asTurnId(`retry-exhaustion-${httpStatusCode}`),
          payload: {
            turn: {
              id: `retry-exhaustion-${httpStatusCode}`,
              status: "failed",
              error: {
                message: `exceeded retry limit, last status: ${httpStatusCode}`,
                codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode } },
              },
            },
          },
        } satisfies ProviderEvent);
        const event = yield* Fiber.join(first);
        if (event._tag !== "Some" || event.value.type !== "turn.completed") {
          assert.fail("Expected a failed turn completion");
        }
        assert.equal(
          event.value.payload.usageLimit?.evidence,
          httpStatusCode === 429 ? "typed" : undefined,
        );
      }
    }),
  );

  it.effect("keeps a terminal 429 notification's usage limit when the completion omits it", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const exhaustion = (httpStatusCode: number | null) => ({
        responseTooManyFailedAttempts: { httpStatusCode },
      });
      const cases = [
        { name: "null-status", willRetry: false, completion: exhaustion(null), limited: true },
        { name: "no-info", willRetry: false, completion: undefined, limited: true },
        { name: "explicit-503", willRetry: false, completion: exhaustion(503), limited: false },
        { name: "retrying", willRetry: true, completion: exhaustion(null), limited: false },
      ] as const;
      for (const testCase of cases) {
        const turnId = `cached-429-${testCase.name}`;
        const message = "exceeded retry limit, last status: 429 Too Many Requests";
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        const base = {
          kind: "notification",
          provider: "codex",
          threadId: asThreadId("thread-1"),
          createdAt: "2026-10-01T00:00:00Z",
          turnId: asTurnId(turnId),
        } as const;
        lifecycleManager.emit("event", {
          ...base,
          id: asEventId(`${turnId}-error`),
          method: "error",
          payload: {
            error: { message, codexErrorInfo: exhaustion(429) },
            willRetry: testCase.willRetry,
          },
        } satisfies ProviderEvent);
        lifecycleManager.emit("event", {
          ...base,
          id: asEventId(`${turnId}-completed`),
          method: "turn/completed",
          payload: {
            turn: {
              id: turnId,
              status: "failed",
              error: {
                message,
                ...(testCase.completion ? { codexErrorInfo: testCase.completion } : {}),
              },
            },
          },
        } satisfies ProviderEvent);
        const events = Array.from(yield* Fiber.join(eventsFiber));
        const completed = events.at(-1);
        if (completed?.type !== "turn.completed") assert.fail("Expected a turn completion");
        assert.equal(
          completed.payload.usageLimit?.evidence,
          testCase.limited ? "typed" : undefined,
          testCase.name,
        );
      }
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
          providerInstanceId: "codex-review",
          sessionGeneration: 7,
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
        providerInstanceId: "codex-review",
        sessionGeneration: 7,
        error: "connection refused",
      });
    }),
  );

  it.effect("maps Codex login-required startup failures to needs-auth", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      const error =
        "MCP server `Glean` requires OAuth reauthentication. Run `codex mcp login Glean`.";

      lifecycleManager.emit("event", {
        id: asEventId("evt-mcp-startup-status-login"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "mcpServer/startupStatus/updated",
        payload: { name: "Glean", status: "failed", error },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "mcp.status.updated") {
        return;
      }
      assert.deepEqual(firstEvent.value.payload.status, {
        name: "Glean",
        status: "needs-auth",
        error,
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

  it.effect(
    "attaches whole-turn usage before completion persistence without changing context",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        for (const status of ["completed", "failed", "interrupted", "native"] as const) {
          const threadId = asThreadId("cache-usage-" + status);
          const turnId = asTurnId("cache-turn-" + status);
          const eventsFiber = yield* adapter.streamEvents.pipe(
            Stream.filter((event) => event.threadId === threadId),
            Stream.takeUntil((event) => event.type === "turn.completed"),
            Stream.runCollect,
            Effect.forkChild,
          );
          const emit = (method: string, payload: object) =>
            lifecycleManager.emit("event", {
              id: asEventId(status + method + JSON.stringify(payload)),
              kind: "notification",
              provider: "codex",
              threadId,
              turnId,
              createdAt: new Date().toISOString(),
              method,
              payload: { threadId: "native-" + status, ...payload },
            } satisfies ProviderEvent);
          emit("turn/started", { turn: { id: turnId, status: "inProgress" } });
          emit("thread/tokenUsage/updated", {
            tokenUsage: {
              total: { inputTokens: 10_000, cachedInputTokens: 8_000, outputTokens: 500 },
              last: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 10, totalTokens: 110 },
            },
          });
          emit("thread/tokenUsage/updated", {
            tokenUsage: {
              total: { inputTokens: 10_200, cachedInputTokens: 8_100, outputTokens: 520 },
              last: {
                inputTokens: 200,
                cachedInputTokens: 100,
                outputTokens: 20,
                totalTokens: 220,
              },
            },
          });
          const nativeUsage = {
            inputTokens: 10,
            cachedInputTokens: 8,
            outputTokens: 2,
            totalTokens: 12,
          };
          emit("turn/completed", {
            turn: {
              id: turnId,
              status: status === "native" ? "completed" : status,
              ...(status === "native" ? { usage: nativeUsage } : {}),
            },
          });
          const events = Array.from(yield* Fiber.join(eventsFiber));
          const completed = events.find((event) => event.type === "turn.completed");
          assert.ok(completed?.type === "turn.completed");
          assert.deepEqual(
            completed.payload.usage,
            status === "native"
              ? nativeUsage
              : {
                  inputTokens: 300,
                  cachedInputTokens: 180,
                  outputTokens: 30,
                },
          );
          assert.equal(
            normalizeTurnUsage(completed).tokenProvenance,
            status === "native" ? "provider-reported" : "derived-from-provider-fields",
          );
          assert.deepEqual(
            events
              .filter((event) => event.type === "thread.token-usage.updated")
              .map((event) => event.payload.contextTokens),
            [110, 220],
          );
        }
      }),
  );

  it.effect("reports reasoning tokens once per increase in Codex usage totals", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      // Its own thread keeps the per-session baseline and stream isolated from other tests.
      const threadId = asThreadId("thread-reasoning-tokens");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild,
      );
      const usage = (id: string, total: number, last: number): ProviderEvent => ({
        id: asEventId(id),
        kind: "notification",
        provider: "codex",
        threadId,
        createdAt: new Date().toISOString(),
        method: "thread/tokenUsage/updated",
        turnId: asTurnId("turn-reasoning-1"),
        payload: {
          threadId: "codex-thread-1",
          turnId: "turn-reasoning-1",
          tokenUsage: {
            total: { totalTokens: 10_000, reasoningOutputTokens: total },
            last: { totalTokens: 1_000, reasoningOutputTokens: last },
            modelContextWindow: 258_400,
          },
        },
      });

      // A resumed thread's history (64_521) is not attributed; only `last` counts.
      lifecycleManager.emit("event", usage("evt-usage-1", 64_521, 516));
      // A repeated frame adds nothing.
      lifecycleManager.emit("event", usage("evt-usage-2", 64_521, 516));
      lifecycleManager.emit("event", usage("evt-usage-3", 64_921, 400));

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.deepEqual(
        events.map((event) => event.type),
        [
          "thread.token-usage.updated",
          "turn.reasoning-tokens.reported",
          "thread.token-usage.updated",
          "thread.token-usage.updated",
          "turn.reasoning-tokens.reported",
        ],
      );
      const reports = events.filter((event) => event.type === "turn.reasoning-tokens.reported");
      assert.deepEqual(
        reports.map((event) => [String(event.turnId), event.payload]),
        [
          ["turn-reasoning-1", { tokens: 516, estimated: false }],
          ["turn-reasoning-1", { tokens: 400, estimated: false }],
        ],
      );
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

  it.effect("lists at most twenty patch approval paths with an overflow count", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const next = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      lifecycleManager.emit("event", {
        id: asEventId("patch-paths"),
        kind: "request",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "applyPatchApproval",
        requestId: ApprovalRequestId.makeUnsafe("patch-paths"),
        payload: {
          reason: " ",
          fileChanges: Object.fromEntries(
            Array.from({ length: 22 }, (_, i) => [
              `file-${String(i).padStart(2, "0")}.ts`,
              { type: "update", ...(i === 0 ? { move_path: "renamed.ts" } : {}) },
            ]),
          ),
        },
      });
      const event = yield* Fiber.join(next);
      assert.equal(event._tag, "Some");
      if (event._tag !== "Some" || event.value.type !== "request.opened") return;
      const lines = event.value.payload.detail?.split("\n");
      assert.equal(lines?.length, 21);
      assert.equal(lines?.[0], "update file-00.ts -> renamed.ts");
      assert.equal(lines?.[20], "+2 more");
      assert.ok(!event.value.payload.detail?.includes("file-20.ts"));
    }),
  );

  it.effect.each([
    {
      fileSystem: {
        entries: [
          { access: "read", path: { type: "path", path: "/w/src" } },
          { access: "write", path: { type: "glob_pattern", pattern: "/w/out/**" } },
        ],
      },
      expected: "file_change_approval",
    },
    {
      fileSystem: {
        entries: [{ access: "read", path: { type: "glob_pattern", pattern: "/w/docs/**" } }],
      },
      expected: "file_read_approval",
    },
    {
      fileSystem: {
        entries: [{ access: "read", path: { type: "special", value: "workspace_roots" } }],
      },
      expected: "file_read_approval",
    },
    { fileSystem: { read: ["/w/src"], write: ["/w/out"] }, expected: "file_change_approval" },
    { fileSystem: { read: ["/w/src"] }, expected: "file_read_approval" },
    { fileSystem: { entries: [] }, expected: "permissions_approval" },
  ])("classifies filesystem permission approvals: %j", ({ fileSystem, expected }) =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const next = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      const permissions = { fileSystem };
      lifecycleManager.emit("event", {
        id: asEventId("permission-entries"),
        kind: "request",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "item/permissions/requestApproval",
        requestId: ApprovalRequestId.makeUnsafe("permission-entries"),
        payload: { permissions },
      });
      const result = yield* Fiber.join(next);
      assert.equal(result._tag, "Some");
      if (result._tag !== "Some" || result.value.type !== "request.opened") return;
      assert.equal(result.value.payload.requestType, expected);
      assert.deepEqual(result.value.payload.requestedPermissions, permissions);
      assert.equal(result.value.payload.approvalOptions, undefined);

      const resolved = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      lifecycleManager.emit("event", {
        id: asEventId("permission-entries-resolved"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "item/requestApproval/decision",
        requestId: ApprovalRequestId.makeUnsafe("permission-entries"),
        requestKind: "permission",
        payload: {
          requestMethod: "item/permissions/requestApproval",
          requestedPermissions: permissions,
          decision: "accept",
        },
      });
      const resolution = yield* Fiber.join(resolved);
      assert.equal(resolution._tag, "Some");
      if (resolution._tag !== "Some" || resolution.value.type !== "request.resolved") return;
      assert.equal(resolution.value.payload.requestType, expected);

      const external = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      lifecycleManager.emit("event", {
        id: asEventId("permission-entries-external"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        createdAt: new Date().toISOString(),
        method: "serverRequest/resolved",
        requestId: ApprovalRequestId.makeUnsafe("permission-entries"),
        requestKind: "permission",
        payload: {
          request: { method: "item/permissions/requestApproval", kind: "permission" },
          requestedPermissions: permissions,
          resolutionSource: "server",
        },
      });
      const externalResolution = yield* Fiber.join(external);
      assert.equal(externalResolution._tag, "Some");
      if (
        externalResolution._tag !== "Some" ||
        externalResolution.value.type !== "request.resolved"
      )
        return;
      assert.equal(externalResolution.value.payload.requestType, expected);
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

  it.effect("maps an async agent message to a question with a stable identity", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const fiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      lifecycleManager.emit("event", {
        id: asEventId("async-event"),
        kind: "notification",
        provider: "codex",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: new Date().toISOString(),
        method: "item/completed",
        payload: {
          item: {
            type: "agentMessage",
            id: "async-question",
            delivery: "async",
            questions: [{ title: "Choose", options: ["A", "B"] }, { title: "Type an answer" }],
          },
        },
      } satisfies ProviderEvent);
      const result = yield* Fiber.join(fiber);
      assert.equal(result._tag, "Some");
      if (result._tag !== "Some" || result.value.type !== "user-input.requested")
        throw new Error("Expected a question");
      assert.equal(result.value.eventId, "codex-async:thread-1:async-question");
      assert.equal(result.value.payload.responseMode, "message");
      assert.equal(result.value.payload.blocking, undefined);
      // Message questions free the composer but still hold restart/usage-limit resume.
      assert.equal(isBlockingUserInput(result.value.payload), false);
      assert.equal(holdsAutomaticResume(result.value.payload), true);
      assert.equal(result.value.payload.questions.length, 2);
      assert.equal(result.value.payload.questions[0]?.options[0]?.label, "A");
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
            isBlocking: false,
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
          assert.equal(events[0].payload.blocking, false);
          assert.equal(events[0].payload.responseMode, undefined);
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

it("feeds Codex's node_repl startup and turn ends to the Chrome session", () => {
  const session = { startupStatus: vi.fn(), turnEnded: vi.fn() };
  const observe = (method: string, payload: unknown, turnId?: string) =>
    observeCodexChrome(session, {
      method,
      payload,
      ...(turnId ? { turnId: TurnId.makeUnsafe(turnId) } : {}),
    });
  observe("mcpServer/startupStatus/updated", { name: "node_repl", status: "ready" });
  observe("mcpServer/startupStatus/updated", { name: "other", status: "failed" });
  observe("mcpServer/startupStatus/updated", {
    name: "node_repl",
    status: "failed",
    error: "boom",
  });
  observe("turn/completed", {}, "turn-1");
  observe("turn/completed", {});
  assert.deepEqual(session.startupStatus.mock.calls, [
    ["ready", undefined],
    ["failed", "boom"],
  ]);
  assert.deepEqual(session.turnEnded.mock.calls, [["turn-1"]]);
});

it("tracks only node_repl calls that have an id", () => {
  const session = { toolCall: vi.fn() };
  const track = (method: string, item: unknown) =>
    trackCodexChromeCall(session, { method, payload: { item } });
  track("item/started", { type: "mcpToolCall", server: "node_repl", id: "call-1" });
  track("item/completed", { type: "mcpToolCall", server: "node_repl", id: "call-1" });
  track("item/started", { type: "mcpToolCall", server: "node_repl" });
  track("item/completed", { type: "mcpToolCall", server: "other", id: "call-2" });
  track("item/completed", { type: "commandExecution", id: "call-3" });
  track("turn/completed", { type: "mcpToolCall", server: "node_repl", id: "call-4" });
  assert.deepEqual(session.toolCall.mock.calls, [
    ["call-1", true],
    ["call-1", false],
  ]);
});

it("reports computer fallback and unavailability without installing both tool catalogs", () => {
  const event: ProviderRuntimeEvent = {
    type: "session.configured",
    eventId: EventId.makeUnsafe("computer-config"),
    provider: "codex",
    threadId: ThreadId.makeUnsafe("computer"),
    createdAt: "2026-10-09T00:00:00.000Z",
    payload: { config: {} },
  };
  const connected = withAgentBrowserPreview([event], undefined, "__f5_computer", {
    fingerprint: "native",
    status: { available: true },
    selection: { kind: "native", fallbackFrom: { kind: "codex-builtin", reason: "not certified" } },
  })[0];
  assert.equal(connected?.type, "session.configured");
  if (connected?.type === "session.configured")
    assert.deepEqual(readRuntimeConfiguredPayload(connected.payload)?.agentBrowser?.computerUse, {
      state: "connected",
      backend: "native",
      detail: "not certified",
    });
  const unavailable = withAgentBrowserPreview([event], undefined, undefined, {
    fingerprint: "unavailable",
    status: { available: false, reason: "helper-missing" },
  })[0];
  assert.equal(unavailable?.type, "session.configured");
  if (unavailable?.type === "session.configured") {
    const config = readRuntimeConfiguredPayload(unavailable.payload)?.agentBrowser;
    assert.deepEqual(config?.computerUse, {
      state: "unavailable",
      backend: "native",
      detail: "helper-missing",
    });
    assert.equal(config?.computer, undefined);
  }
});

it.effect(
  "keeps completion behind admitted Codex output preparation and retains its generation",
  () => {
    const manager = new FakeCodexManager();
    return Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      const logged: string[] = [];
      const layer = makeCodexAdapterLive({
        manager,
        nativeEventLogger: {
          filePath: "test-events.ndjson",
          close: () => Effect.void,
          write: (value) =>
            Effect.gen(function* () {
              const event = value as ProviderEvent;
              logged.push(event.id);
              if (event.id === "fifo-output") {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
            }),
        },
      }).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        const result = yield* adapter.streamEvents.pipe(
          Stream.filter(
            (event) => event.type === "content.delta" || event.type === "turn.completed",
          ),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        const base = {
          provider: "codex" as const,
          providerInstanceId: ProviderInstanceId.makeUnsafe("codex-fifo"),
          sessionGeneration: 7,
          threadId: asThreadId("thread-fifo"),
          turnId: asTurnId("turn-fifo"),
          createdAt: "2026-10-19T12:00:00.000Z",
        };
        manager.emit("event", {
          ...base,
          id: asEventId("fifo-output"),
          kind: "notification",
          method: "item/agentMessage/delta",
          itemId: asItemId("message-fifo"),
          textDelta: "final output",
          payload: { delta: "final output" },
        });
        yield* Deferred.await(entered);
        manager.emit("event", {
          ...base,
          id: asEventId("fifo-completed"),
          kind: "notification",
          method: "turn/completed",
          payload: { turn: { id: "turn-fifo", status: "completed" } },
        });
        yield* Effect.yieldNow;
        assert.deepEqual(logged, ["fifo-output"]);
        yield* Deferred.succeed(release, undefined);
        const events = yield* Fiber.join(result);
        assert.deepEqual(
          events.map((event) => event.type),
          ["content.delta", "turn.completed"],
        );
        assert.ok(
          events.every(
            (event) => event.sessionGeneration === 7 && event.providerInstanceId === "codex-fifo",
          ),
        );
        assert.deepEqual(logged, ["fifo-output", "fifo-completed"]);
      }).pipe(Effect.provide(layer));
    });
  },
);

it.effect(
  "bounds admitted notification preparation, interrupts on overflow, and refuses ghost turns",
  () => {
    const manager = new FakeCodexManager();
    return Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
      const layer = makeCodexAdapterLive({
        manager,
        notificationLimits: { entries: 1, bytes: 4096, controls: 2 },
        nativeEventLogger: {
          filePath: "overflow.log",
          close: () => Effect.void,
          write: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        },
      }).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        const threadId = asThreadId("notification-overflow");
        const events = yield* adapter.streamEvents.pipe(
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );
        const base = {
          provider: "codex" as const,
          providerInstanceId: ProviderInstanceId.make("codex"),
          sessionGeneration: 1,
          threadId,
          turnId: asTurnId("overflow-turn"),
          createdAt: "2026-10-19T00:00:00.000Z",
        };
        const delta = (id: string) =>
          manager.emit("event", {
            ...base,
            id: asEventId(id),
            kind: "notification",
            method: "item/agentMessage/delta",
            itemId: asItemId("overflow-item"),
            textDelta: id,
            payload: { delta: id },
          });
        delta("kept-prefix");
        yield* Deferred.await(entered);
        for (let index = 0; index < 100; index++) delta(`unadmitted-${index}`);
        assert.equal(manager.interruptTurnImpl.mock.calls.length, 1);
        const error = yield* adapter
          .sendTurn({ threadId, input: "must not be written" })
          .pipe(Effect.flip);
        assert.equal(error._tag, "ProviderAdapterRequestError");
        if (error._tag === "ProviderAdapterRequestError") {
          assert.equal(error.deliveryCertainty, "not_sent");
          assert.equal(error.deliveryRetryable, false);
        }
        assert.equal(manager.sendTurnImpl.mock.calls.length, 0);
        manager.emit("event", {
          ...base,
          id: asEventId("overflow-terminal"),
          kind: "notification",
          method: "turn/completed",
          payload: { turn: { id: base.turnId, status: "interrupted" } },
        });
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(events);
        assert.deepEqual(
          result.map((event) => event.type),
          ["content.delta", "runtime.error", "turn.completed"],
        );
        assert.ok(
          result.some(
            (event) =>
              event.type === "runtime.error" && event.payload.historyReconciliationRequired,
          ),
        );
        assert.equal(result.filter((event) => event.type === "content.delta").length, 1);
        yield* adapter.acknowledgeHistoryReconciliation!(threadId, "unrelated-marker");
        const stillBlocked = yield* adapter
          .sendTurn({ threadId, input: "still blocked" })
          .pipe(Effect.flip);
        assert.equal(stillBlocked._tag, "ProviderAdapterRequestError");
        yield* adapter.acknowledgeHistoryReconciliation!(threadId, "incomplete:unadmitted-0");
        yield* adapter.sendTurn({ threadId, input: "recovered" });
        const resumed = yield* adapter.streamEvents.pipe(
          Stream.take(1),
          Stream.runHead,
          Effect.forkChild,
        );
        delta("after-recovery");
        assert.equal(Option.getOrThrow(yield* Fiber.join(resumed)).type, "content.delta");
        assert.equal(manager.sendTurnImpl.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped);
  },
);

/** An adapter whose native log write blocks on the gate events until released. */
const makeGatedAdapter = (
  manager: FakeCodexManager,
  gateIds: ReadonlyArray<string>,
  notificationLimits?: { entries: number; bytes: number; controls: number },
) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>(),
      release = yield* Deferred.make<void>();
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
    const logged: ProviderEvent[] = [];
    const layer = makeCodexAdapterLive({
      manager,
      ...(notificationLimits ? { notificationLimits } : {}),
      nativeEventLogger: {
        filePath: "merge.log",
        close: () => Effect.void,
        write: (value) =>
          Effect.gen(function* () {
            const event = value as ProviderEvent;
            logged.push(event);
            if (gateIds.includes(event.id)) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
          }),
      },
    }).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );
    return { layer, entered, release, logged };
  });

const mergeBase = (threadId: string, sessionGeneration = 1) => ({
  provider: "codex" as const,
  providerInstanceId: ProviderInstanceId.make("codex"),
  sessionGeneration,
  threadId: asThreadId(threadId),
  turnId: asTurnId(`${threadId}-turn`),
  createdAt: "2026-11-08T21:16:56.000Z",
});

const emitCommandDelta = (
  manager: FakeCodexManager,
  base: ReturnType<typeof mergeBase>,
  id: string,
  itemId: string,
  delta: string,
) =>
  manager.emit("event", {
    ...base,
    id: asEventId(id),
    kind: "notification",
    method: "item/commandExecution/outputDelta",
    itemId: asItemId(itemId),
    payload: { itemId, delta },
  });

const emitCommandItem = (
  manager: FakeCodexManager,
  base: ReturnType<typeof mergeBase>,
  method: "item/started" | "item/completed",
  id: string,
  itemId: string,
) =>
  manager.emit("event", {
    ...base,
    id: asEventId(id),
    kind: "notification",
    method,
    itemId: asItemId(itemId),
    payload: {
      item: {
        type: "commandExecution",
        id: itemId,
        command: "echo",
        status: method === "item/started" ? "inProgress" : "completed",
      },
    },
  });

const emitTurnCompleted = (
  manager: FakeCodexManager,
  base: ReturnType<typeof mergeBase>,
  id: string,
) =>
  manager.emit("event", {
    ...base,
    id: asEventId(id),
    kind: "notification",
    method: "turn/completed",
    payload: { turn: { id: base.turnId, status: "completed" } },
  });

const deltaText = (event: ProviderRuntimeEvent) =>
  event.type === "content.delta" ? event.payload.delta : "";

const collectUntilCompleted = (adapter: CodexAdapterShape, completions: number) => {
  let completed = 0;
  return adapter.streamEvents.pipe(
    Stream.takeUntil((event) => event.type === "turn.completed" && ++completed === completions),
    Stream.runCollect,
    Effect.map((events) => [...events]),
    Effect.forkChild,
  );
};

it.effect(
  "merges finely interleaved command output bursts per item without overflow or loss",
  () => {
    const manager = new FakeCodexManager();
    return Effect.gen(function* () {
      const gate = yield* makeGatedAdapter(manager, ["burst-started-a"]);
      yield* Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        const collected = yield* collectUntilCompleted(adapter, 1);
        const base = mergeBase("burst-thread");
        const items = ["exec-a", "exec-b", "exec-c"] as const;
        emitCommandItem(manager, base, "item/started", "burst-started-a", items[0]);
        yield* Deferred.await(gate.entered);
        emitCommandItem(manager, base, "item/started", "burst-started-b", items[1]);
        emitCommandItem(manager, base, "item/started", "burst-started-c", items[2]);
        const expected = new Map<string, string>(items.map((item) => [item, ""]));
        let cCount = 0;
        for (let index = 0; index < 1500; index++) {
          // Runs of one to three deltas alternate between items, as in the incident.
          const item =
            index % 60 === 0 && cCount < 23
              ? (cCount++, items[2])
              : Math.floor(index / (1 + (index % 3))) % 2 === 0
                ? items[0]
                : items[1];
          const text = `${item}:${index};`;
          expected.set(item, expected.get(item)! + text);
          emitCommandDelta(manager, base, `burst-delta-${index}`, item, text);
        }
        for (const item of items)
          emitCommandItem(manager, base, "item/completed", `burst-completed-${item}`, item);
        emitTurnCompleted(manager, base, "burst-turn-completed");
        assert.equal(manager.interruptTurnImpl.mock.calls.length, 0);
        yield* Deferred.succeed(gate.release, undefined);
        const events = yield* Fiber.join(collected);
        assert.equal(manager.interruptTurnImpl.mock.calls.length, 0);
        assert.equal(events.filter((event) => event.type === "runtime.error").length, 0);
        const deltas = events.filter((event) => event.type === "content.delta");
        assert.ok(deltas.length <= 6, `expected merged deltas, got ${deltas.length}`);
        for (const item of items) {
          const own = events.filter(
            (event) => event.type === "content.delta" && event.itemId === item,
          );
          assert.equal(own.map(deltaText).join(""), expected.get(item));
          const completedIndex = events.findIndex(
            (event) => event.type === "item.completed" && event.itemId === item,
          );
          assert.ok(completedIndex > events.lastIndexOf(own.at(-1)!));
        }
        assert.equal(events.at(-1)?.type, "turn.completed");
      }).pipe(Effect.provide(gate.layer));
    }).pipe(Effect.scoped);
  },
);

it.effect("still interrupts on genuine overload of distinct items", () => {
  const manager = new FakeCodexManager();
  return Effect.gen(function* () {
    const gate = yield* makeGatedAdapter(manager, ["overload-started"], {
      entries: 4,
      bytes: 1024 * 1024,
      controls: 8,
    });
    yield* Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const collected = yield* collectUntilCompleted(adapter, 1);
      const base = mergeBase("overload-thread");
      emitCommandItem(manager, base, "item/started", "overload-started", "exec-0");
      yield* Deferred.await(gate.entered);
      for (let index = 0; index < 10; index++)
        emitCommandDelta(manager, base, `overload-${index}`, `exec-${index}`, `${index}`);
      assert.equal(manager.interruptTurnImpl.mock.calls.length, 1);
      emitTurnCompleted(manager, base, "overload-turn-completed");
      yield* Deferred.succeed(gate.release, undefined);
      const events = yield* Fiber.join(collected);
      assert.equal(events.filter((event) => event.type === "content.delta").length, 4);
      const error = events.find((event) => event.type === "runtime.error");
      assert.ok(error?.type === "runtime.error" && error.payload.historyReconciliationRequired);
      assert.equal(error.eventId, "incomplete:overload-4");
      const blocked = yield* adapter
        .sendTurn({ threadId: base.threadId, input: "blocked" })
        .pipe(Effect.flip);
      assert.equal(blocked._tag, "ProviderAdapterRequestError");
    }).pipe(Effect.provide(gate.layer));
  }).pipe(Effect.scoped);
});

it.effect("rolls a merged delta over at 64 KiB and seals it at preparation start", () => {
  const manager = new FakeCodexManager();
  return Effect.gen(function* () {
    const gate = yield* makeGatedAdapter(manager, ["rollover-started"], {
      entries: 1024,
      bytes: 32 * 1024 * 1024,
      controls: 64,
    });
    yield* Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const collected = yield* collectUntilCompleted(adapter, 1);
      const base = mergeBase("rollover-thread");
      emitCommandItem(manager, base, "item/started", "rollover-started", "exec-big");
      yield* Deferred.await(gate.entered);
      let expected = "";
      for (let index = 0; index < 100; index++) {
        const text = String.fromCharCode(65 + (index % 26)).repeat(1024);
        expected += text;
        emitCommandDelta(manager, base, `rollover-${index}`, "exec-big", text);
      }
      // Any other event for the context seals the open notification.
      emitCommandDelta(manager, base, "sealed-before-usage", "exec-small", "one");
      manager.emit("event", {
        ...base,
        id: asEventId("rollover-usage"),
        kind: "notification",
        method: "thread/tokenUsage/updated",
        payload: {},
      });
      emitCommandDelta(manager, base, "sealed-after-usage", "exec-small", "two");
      emitTurnCompleted(manager, base, "rollover-turn-completed");
      yield* Deferred.succeed(gate.release, undefined);
      const events = yield* Fiber.join(collected);
      const big = events.filter(
        (event) => event.type === "content.delta" && event.itemId === "exec-big",
      );
      assert.equal(big.length, 2);
      assert.ok(big.every((event) => Buffer.byteLength(deltaText(event)) <= 64 * 1024));
      assert.equal(big.map(deltaText).join(""), expected);
      const small = events.filter(
        (event) => event.type === "content.delta" && event.itemId === "exec-small",
      );
      assert.deepEqual(small.map(deltaText), ["one", "two"]);
    }).pipe(Effect.provide(gate.layer));
  }).pipe(Effect.scoped);
});

it.effect("charges merged deltas by their text, so tiny-chunk bursts fit a small byte cap", () => {
  const manager = new FakeCodexManager();
  return Effect.gen(function* () {
    // Each native delta carries a few hundred bytes of envelope for one byte of text.
    const gate = yield* makeGatedAdapter(manager, ["tiny-started"], {
      entries: 4,
      bytes: 8 * 1024,
      controls: 8,
    });
    yield* Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const collected = yield* collectUntilCompleted(adapter, 1);
      const base = mergeBase("tiny-thread");
      emitCommandItem(manager, base, "item/started", "tiny-started", "exec-tiny");
      yield* Deferred.await(gate.entered);
      let expected = "";
      for (let index = 0; index < 4000; index++) {
        const text = String.fromCharCode(97 + (index % 26));
        expected += text;
        emitCommandDelta(manager, base, `tiny-${index}`, "exec-tiny", text);
      }
      emitTurnCompleted(manager, base, "tiny-turn-completed");
      assert.equal(manager.interruptTurnImpl.mock.calls.length, 0);
      yield* Deferred.succeed(gate.release, undefined);
      const events = yield* Fiber.join(collected);
      assert.equal(events.filter((event) => event.type === "runtime.error").length, 0);
      const deltas = events.filter((event) => event.type === "content.delta");
      assert.equal(deltas.map(deltaText).join(""), expected);
      // The native log names the merged range instead of hiding it.
      const merged = gate.logged.find((entry) => entry.id === "tiny-0") as
        | (ProviderEvent & { coalesced?: { count: number; lastEventId?: string } })
        | undefined;
      assert.deepEqual(merged?.coalesced, {
        count: 4000,
        lastEventId: "tiny-3999",
        lastCreatedAt: base.createdAt,
      });
    }).pipe(Effect.provide(gate.layer));
  }).pipe(Effect.scoped);
});

it.effect("does not merge a delta into a notification whose preparation started", () => {
  const manager = new FakeCodexManager();
  return Effect.gen(function* () {
    const gate = yield* makeGatedAdapter(manager, ["started-first"]);
    yield* Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const collected = yield* collectUntilCompleted(adapter, 1);
      const base = mergeBase("started-thread");
      emitCommandDelta(manager, base, "started-first", "exec-1", "first");
      yield* Deferred.await(gate.entered);
      emitCommandDelta(manager, base, "started-second", "exec-1", "second");
      emitCommandDelta(manager, base, "started-third", "exec-1", "third");
      emitTurnCompleted(manager, base, "started-turn-completed");
      yield* Deferred.succeed(gate.release, undefined);
      const events = yield* Fiber.join(collected);
      assert.deepEqual(events.filter((event) => event.type === "content.delta").map(deltaText), [
        "first",
        "secondthird",
      ]);
    }).pipe(Effect.provide(gate.layer));
  }).pipe(Effect.scoped);
});

it.effect("isolates admission and merging between threads and session generations", () => {
  const manager = new FakeCodexManager();
  return Effect.gen(function* () {
    const gate = yield* makeGatedAdapter(manager, ["x-started", "y-started"], {
      entries: 4,
      bytes: 1024 * 1024,
      controls: 8,
    });
    yield* Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const collected = yield* collectUntilCompleted(adapter, 2);
      const x = mergeBase("x-thread"),
        y = mergeBase("y-thread"),
        yNext = mergeBase("y-thread", 2);
      emitCommandItem(manager, x, "item/started", "x-started", "x-0");
      emitCommandItem(manager, y, "item/started", "y-started", "y-item");
      yield* Deferred.await(gate.entered);
      let expectedY = "";
      for (let index = 0; index < 20; index++) {
        emitCommandDelta(manager, x, `x-${index}`, `x-${index}`, `x${index}`);
        const text = `y${index};`;
        expectedY += text;
        emitCommandDelta(manager, y, `y-${index}`, "y-item", text);
      }
      emitCommandDelta(manager, yNext, "y-next", "y-item", "generation-2");
      assert.equal(manager.interruptTurnImpl.mock.calls.length, 1);
      assert.equal(manager.interruptTurnImpl.mock.calls[0]?.[0], x.threadId);
      emitTurnCompleted(manager, x, "x-turn-completed");
      emitTurnCompleted(manager, y, "y-turn-completed");
      yield* Deferred.succeed(gate.release, undefined);
      const events = yield* Fiber.join(collected);
      const yDeltas = events.filter(
        (event) => event.type === "content.delta" && event.threadId === y.threadId,
      );
      assert.equal(
        yDeltas
          .filter((event) => event.sessionGeneration === 1)
          .map(deltaText)
          .join(""),
        expectedY,
      );
      assert.deepEqual(yDeltas.filter((event) => event.sessionGeneration === 2).map(deltaText), [
        "generation-2",
      ]);
      assert.ok(
        events
          .filter((event) => event.type === "content.delta" && event.threadId === x.threadId)
          .every((event) => /^x\d+$/.test(deltaText(event))),
      );
      assert.equal(
        events.filter((event) => event.type === "runtime.error" && event.threadId === y.threadId)
          .length,
        0,
      );
    }).pipe(Effect.provide(gate.layer));
  }).pipe(Effect.scoped);
});

it.effect(
  "stops Codex Chrome's runtime for a call Codex reported running, ahead of queued output and whether or not the interrupt succeeds",
  () => {
    const manager = new FakeCodexManager();
    const broker = {
      host: { status: () => ({ available: false, reason: "no-host" }) },
      generation: vi.fn(() => undefined),
      bindSession: vi.fn(),
      releaseSession: vi.fn(),
      requestChromeSession: vi.fn(async () => true),
      pause: { subscribe: () => () => undefined, has: () => false },
      onChromeDisabled: () => () => undefined,
      registerChromeReleaser: () => () => undefined,
      registerCodexHandoff: () => () => undefined,
      waitForChromeRelease: async () => {},
      prepareCodexBrowser: async () => {},
      chromeRecoveryRequired: () => false,
    };
    const spies = [
      vi
        .spyOn(browserAccess, "resolveAgentBrowserPolicy")
        .mockReturnValue(Effect.succeed({ codexChrome: true } as never)),
      vi
        .spyOn(codexChromeIntegration, "inspectCodexBinary")
        .mockResolvedValue({ path: "/opt/codex", version: "0.163.0" }),
      vi.spyOn(codexChromeIntegration, "codexChromeEligibility").mockResolvedValue({
        eligible: true,
        installation: { nodeRepl: "/plugin/bin/node_repl", skillPath: "/plugin/SKILL.md" },
        codexHome: "/isolated",
      } as never),
      vi
        .spyOn(codexChromeIntegration, "codexChromeMcpServer")
        .mockReturnValue({ type: "stdio", command: "/plugin/bin/node_repl", enabledTools: ["js"] }),
    ];
    const interrupted = vi
      .spyOn(CodexChromeSession.prototype, "turnInterrupted")
      .mockImplementation(() => undefined);
    return Effect.gen(function* () {
      const entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();
      const layer = makeCodexAdapterLive({
        manager,
        computerAutomationBroker: broker as never,
        nativeEventLogger: {
          filePath: "test-events.ndjson",
          close: () => Effect.void,
          write: (value) =>
            Effect.gen(function* () {
              if ((value as ProviderEvent).id !== "hold") return;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }),
        },
      }).pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "codex-chrome-" }, { mode: "desktop" }),
        ),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        const threadId = asThreadId("chrome-interrupt");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        const base = {
          provider: "codex" as const,
          threadId,
          createdAt: "2026-11-02T12:00:00.000Z",
          kind: "notification" as const,
        };
        const call = (id: string, method: "item/started" | "item/completed") =>
          manager.emit("event", {
            ...base,
            id: asEventId(`${id}:${method}`),
            method,
            payload: { item: { type: "mcpToolCall", server: "node_repl", id } },
          });
        // Earlier output (an MCP app capture, say) holds the session's ordered preparation.
        manager.emit("event", {
          ...base,
          id: asEventId("hold"),
          method: "item/agentMessage/delta",
          itemId: asItemId("message"),
          textDelta: "x",
          payload: { delta: "x" },
        });
        yield* Deferred.await(entered);
        call("call-1", "item/started");
        // Codex reports the call completed before the interrupt resolves.
        manager.interruptTurnImpl.mockImplementationOnce(async () => {
          call("call-1", "item/completed");
        });
        yield* adapter.interruptTurn(threadId, asTurnId("turn-1"));
        assert.deepEqual(interrupted.mock.calls, [["turn-1", true]]);
        // Stopped before the interrupt was sent.
        assert.ok(
          interrupted.mock.invocationCallOrder[0]! <
            manager.interruptTurnImpl.mock.invocationCallOrder.at(-1)!,
        );

        // No call running: drained once Codex interrupted the turn, with or without its id.
        yield* adapter.interruptTurn(threadId);
        assert.deepEqual(interrupted.mock.calls.at(-1), [undefined, false]);

        // A failed interrupt still stops a running call's runtime.
        call("call-2", "item/started");
        manager.interruptTurnImpl.mockRejectedValueOnce(new Error("interrupt failed"));
        const failure = yield* adapter
          .interruptTurn(threadId, asTurnId("turn-2"))
          .pipe(Effect.flip);
        assert.equal(failure._tag, "ProviderAdapterRequestError");
        assert.deepEqual(interrupted.mock.calls.at(-1), ["turn-2", true]);
        yield* Deferred.succeed(release, undefined);
      }).pipe(Effect.provide(layer));
    }).pipe(
      Effect.scoped,
      Effect.ensuring(
        Effect.sync(() => {
          for (const spy of [...spies, interrupted]) spy.mockRestore();
        }),
      ),
    );
  },
);

it.effect(
  "returns a typed error and disposes preview state when Chrome's bundled resolver fails",
  () => {
    const manager = new FakeCodexManager();
    const dispose = vi.fn();
    const createSessionConfig = vi.fn(() => ({
      serverName: "f5_preview",
      serverDefinition: { type: "http", url: "http://127.0.0.1/mcp" },
      env: {},
      dispose,
    }));
    const policy = vi
      .spyOn(browserAccess, "resolveAgentBrowserPolicy")
      .mockReturnValue(Effect.succeed({ codexChrome: true } as never));
    const resolver = vi.spyOn(codexExecutable, "resolveCodexCommand").mockImplementation(() => {
      throw new CommandNotFoundError("codex", "Command not found: codex. Reinstall F5.");
    });
    const layer = makeCodexAdapterLive({
      manager,
      previewMcpHttpServer: { createSessionConfig } as never,
      computerAutomationBroker: {
        host: { status: () => ({ available: false, reason: "no-host" }) },
        onChromeDisabled: () => () => undefined,
        pause: { subscribe: () => () => undefined, has: () => false },
      } as never,
    }).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "codex-missing-" }, { mode: "desktop" }),
      ),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );
    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const error = yield* adapter
        .startSession({
          threadId: asThreadId("missing-codex"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterProcessError");
      assert.match(error.message, /Reinstall F5/);
      assert.equal(dispose.mock.calls.length, 1);
      assert.equal(manager.startSessionImpl.mock.calls.length, 0);
    }).pipe(
      Effect.provide(layer),
      Effect.scoped,
      Effect.ensuring(
        Effect.sync(() => {
          policy.mockRestore();
          resolver.mockRestore();
        }),
      ),
    );
  },
);

it.effect("gives a read-only Codex workflow stage a read-only thread catalog", () => {
  const manager = new FakeCodexManager();
  const createSessionConfig = vi.fn((input: { readonly threadId: string }) => ({
    serverName: "f5_thread",
    serverDefinition: { type: "http" as const, url: `http://127.0.0.1/mcp/${input.threadId}` },
    env: {},
    dispose: () => undefined,
  }));
  const previewMcpHttpServer = {
    supportsThreadCatalog: true,
    createSessionConfig,
  } as unknown as NonNullable<CodexAdapterLiveOptions["previewMcpHttpServer"]>;
  const layer = makeCodexAdapterLive({ manager, previewMcpHttpServer }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "codex-thread-catalog-" })),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const threadCatalogCall = () =>
    createSessionConfig.mock.calls
      .map(([input]) => input as { catalog?: string; threadAccess?: string })
      .findLast((input) => input.catalog === "thread");
  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    yield* adapter.startSession({
      threadId: asThreadId("workflow-stage"),
      runtimeMode: "full-access",
      workflowExecutionProfile: "unattended-readonly",
    });
    assert.equal(threadCatalogCall()?.threadAccess, "read-only");
    yield* adapter.startSession({ threadId: asThreadId("normal"), runtimeMode: "full-access" });
    assert.equal(threadCatalogCall()?.threadAccess, "full");
  }).pipe(Effect.provide(layer), Effect.scoped);
});

it.effect(
  "has Codex start node_repl only for consented, interactive desktop sessions without a node_repl of their own",
  () => {
    const manager = new FakeCodexManager();
    const broker = {
      host: { status: () => ({ available: false, reason: "no-host" }) },
      generation: vi.fn(() => undefined),
      bindSession: vi.fn(),
      releaseSession: vi.fn(),
      requestChromeSession: vi.fn(async () => true),
      pause: { subscribe: () => () => undefined, has: () => false },
      onChromeDisabled: () => () => undefined,
      registerChromeReleaser: () => () => undefined,
      registerCodexHandoff: () => () => undefined,
      waitForChromeRelease: async () => {},
      prepareCodexBrowser: async () => {},
      chromeRecoveryRequired: () => false,
    };
    const installation = {
      nodeRepl: "/plugin/bin/node_repl",
      skillPath: "/plugin/SKILL.md",
      pluginRoot: "/plugin",
      record: {},
    };
    const policy = vi
      .spyOn(browserAccess, "resolveAgentBrowserPolicy")
      .mockReturnValue(Effect.succeed({ codexChrome: true } as never));
    const inspect = vi
      .spyOn(codexChromeIntegration, "inspectCodexBinary")
      .mockResolvedValue({ path: "/opt/codex", version: "0.163.0" });
    const eligibility = vi
      .spyOn(codexChromeIntegration, "codexChromeEligibility")
      .mockResolvedValue({
        eligible: true,
        installation,
        codexHome: "/isolated",
      } as never);
    const server = vi
      .spyOn(codexChromeIntegration, "codexChromeMcpServer")
      .mockReturnValue({ type: "stdio", command: "/plugin/bin/node_repl", enabledTools: ["js"] });
    const layer = makeCodexAdapterLive({ manager, computerAutomationBroker: broker as never }).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "codex-chrome-" }, { mode: "desktop" }),
      ),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );
    const servers = () =>
      (manager.startSessionImpl.mock.calls.at(-1)?.[0] as { mcpServers?: Record<string, unknown> })
        ?.mcpServers ?? {};
    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({ threadId: asThreadId("chrome"), runtimeMode: "full-access" });
      assert.deepEqual(Object.keys(servers()), ["node_repl"]);
      assert.equal(broker.requestChromeSession.mock.calls.length, 1);
      assert.ok(
        String(manager.startSessionImpl.mock.calls.at(-1)?.[0].integrationInstructions).includes(
          "/plugin/SKILL.md",
        ),
      );

      broker.requestChromeSession.mockResolvedValueOnce(false);
      yield* adapter.startSession({ threadId: asThreadId("declined"), runtimeMode: "full-access" });
      assert.equal(servers().node_repl, undefined);

      yield* adapter.startSession({
        threadId: asThreadId("own"),
        runtimeMode: "full-access",
        providerOptions: { mcpServers: { node_repl: { type: "stdio", command: "mine" } } },
      });
      assert.deepEqual(servers().node_repl, { type: "stdio", command: "mine" });
      assert.equal(broker.requestChromeSession.mock.calls.length, 2);

      // An automation's session never waits on a consent dialog nobody can answer.
      const unattended = yield* adapter.startSession({
        threadId: asThreadId("scheduled"),
        runtimeMode: "full-access",
        unattended: true,
      });
      assert.equal(servers().node_repl, undefined);
      assert.equal(broker.requestChromeSession.mock.calls.length, 2);
      // Its fingerprint differs, so a person's next turn restarts it with Chrome.
      assert.equal(
        unattended.chromeConfigurationFingerprint,
        codexChromeIntegration.codexChromeFingerprint(false),
      );

      eligibility.mockClear();
      yield* adapter.startSession({
        threadId: asThreadId("workflow"),
        runtimeMode: "full-access",
        workflowExecutionProfile: "unattended-readonly",
      });
      yield* adapter.startSession({
        threadId: asThreadId("one-off:x"),
        runtimeMode: "full-access",
      });
      assert.equal(eligibility.mock.calls.length, 0);
      assert.equal(servers().node_repl, undefined);
    }).pipe(
      Effect.provide(layer),
      Effect.scoped,
      Effect.ensuring(
        Effect.sync(() => {
          for (const spy of [policy, inspect, eligibility, server]) spy.mockRestore();
        }),
      ),
    );
  },
);
