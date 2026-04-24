import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ProviderRuntimeEvent, ProviderSession } from "@t3tools/contracts";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_NEW_THREAD_TITLE,
  DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Metric,
  Option,
  PubSub,
  Scope,
  Stream,
  Tracer,
} from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { roughTokenEstimateFromCharacters } from "@t3tools/shared/model";

import { ServerConfig } from "../../config.ts";
import { TextGenerationError } from "../../git/Errors.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { ProjectMcpConfigService } from "../../mcp/ProjectMcpConfigService.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
  type ProviderSessionDirectoryShape,
} from "../../provider/Services/ProviderSessionDirectory.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { TextGeneration, type TextGenerationShape } from "../../git/Services/TextGeneration.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProviderCommandReactorLive } from "./ProviderCommandReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { makeLocalFileTracer } from "../../observability/LocalFileTracer.ts";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asApprovalRequestId = (value: string): ApprovalRequestId =>
  ApprovalRequestId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };

  return poll();
}

function counterValue(
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
): number {
  const snapshot = snapshots.find(
    (entry) =>
      entry.id === id &&
      entry.type === "Counter" &&
      Object.entries(attributes).every(([key, value]) => entry.attributes?.[key] === value),
  );
  return snapshot?.type === "Counter" ? Number(snapshot.state.count) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeRuntimePayload(
  existing: unknown | null | undefined,
  next: unknown | null | undefined,
): unknown | null {
  if (next === undefined) {
    return existing ?? null;
  }
  if (isRecord(existing) && isRecord(next)) {
    return { ...existing, ...next };
  }
  return next;
}

describe("ProviderCommandReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProviderCommandReactor,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const createdStateDirs = new Set<string>();

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const stateDir of createdStateDirs) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
    createdStateDirs.clear();
  });

  async function createHarness(input?: {
    readonly stateDir?: string;
    readonly threadTitle?: string;
    readonly threadModel?: string;
    readonly tracePath?: string;
  }) {
    const now = new Date().toISOString();
    const stateDir = input?.stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "t3code-reactor-"));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-project-"));
    createdStateDirs.add(stateDir);
    createdStateDirs.add(workspaceRoot);
    if (input?.tracePath) {
      fs.mkdirSync(path.dirname(input.tracePath), { recursive: true });
    }
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    let nextSessionIndex = 1;
    const runtimeSessions: Array<ProviderSession> = [];
    const persistedBindings = new Map<ThreadId, ProviderRuntimeBinding>();
    const upsertPersistedBinding = (binding: ProviderRuntimeBinding) => {
      const existing = persistedBindings.get(binding.threadId);
      let nextBinding: ProviderRuntimeBinding = {
        threadId: binding.threadId,
        projectId:
          binding.projectId !== undefined ? binding.projectId : (existing?.projectId ?? null),
        provider: binding.provider,
        mcpEffectiveConfigVersion:
          binding.mcpEffectiveConfigVersion !== undefined
            ? binding.mcpEffectiveConfigVersion
            : (existing?.mcpEffectiveConfigVersion ?? null),
        resumeCursor:
          binding.resumeCursor !== undefined
            ? binding.resumeCursor
            : (existing?.resumeCursor ?? null),
        runtimePayload: mergeRuntimePayload(existing?.runtimePayload, binding.runtimePayload),
      };
      const adapterKey = binding.adapterKey ?? existing?.adapterKey;
      if (adapterKey !== undefined) {
        nextBinding = { ...nextBinding, adapterKey };
      }
      const status = binding.status ?? existing?.status;
      if (status !== undefined) {
        nextBinding = { ...nextBinding, status };
      }
      const runtimeMode = binding.runtimeMode ?? existing?.runtimeMode;
      if (runtimeMode !== undefined) {
        nextBinding = { ...nextBinding, runtimeMode };
      }
      persistedBindings.set(binding.threadId, nextBinding);
    };
    const startSession = vi.fn((_: unknown, input: unknown) => {
      const sessionIndex = nextSessionIndex++;
      const provider =
        typeof input === "object" &&
        input !== null &&
        "provider" in input &&
        (input.provider === "codex" || input.provider === "claudeAgent")
          ? input.provider
          : "codex";
      const resumeCursor =
        typeof input === "object" && input !== null && "resumeCursor" in input
          ? input.resumeCursor
          : undefined;
      const model =
        typeof input === "object" &&
        input !== null &&
        "model" in input &&
        typeof input.model === "string"
          ? input.model
          : undefined;
      const threadId =
        typeof input === "object" &&
        input !== null &&
        "threadId" in input &&
        typeof input.threadId === "string"
          ? ThreadId.makeUnsafe(input.threadId)
          : ThreadId.makeUnsafe(`thread-${sessionIndex}`);
      const session: ProviderSession = {
        provider,
        status: "ready" as const,
        runtimeMode:
          typeof input === "object" &&
          input !== null &&
          "runtimeMode" in input &&
          (input.runtimeMode === "approval-required" || input.runtimeMode === "full-access")
            ? input.runtimeMode
            : "full-access",
        ...(model !== undefined ? { model } : {}),
        threadId,
        resumeCursor: resumeCursor ?? { opaque: `cursor-${sessionIndex}` },
        createdAt: now,
        updatedAt: now,
      };
      runtimeSessions.push(session);
      const projectId =
        typeof input === "object" &&
        input !== null &&
        "projectId" in input &&
        typeof input.projectId === "string"
          ? ProjectId.makeUnsafe(input.projectId)
          : null;
      const runtimePayload =
        typeof input === "object" && input !== null
          ? {
              ...("cwd" in input ? { cwd: input.cwd ?? null } : {}),
              ...(model !== undefined ? { model } : {}),
              ...("providerOptions" in input ? { providerOptions: input.providerOptions } : {}),
              instructionContext: {
                ...("projectTitle" in input ? { projectTitle: input.projectTitle } : {}),
                ...("threadTitle" in input ? { threadTitle: input.threadTitle } : {}),
                ...("turnCount" in input ? { turnCount: input.turnCount } : {}),
                ...("priorWorkSummary" in input
                  ? { priorWorkSummary: input.priorWorkSummary }
                  : {}),
                ...("preservedTranscriptBefore" in input
                  ? { preservedTranscriptBefore: input.preservedTranscriptBefore }
                  : {}),
                ...("preservedTranscriptAfter" in input
                  ? { preservedTranscriptAfter: input.preservedTranscriptAfter }
                  : {}),
                ...("restoredRecentFileRefs" in input
                  ? { restoredRecentFileRefs: input.restoredRecentFileRefs }
                  : {}),
                ...("restoredActivePlan" in input
                  ? { restoredActivePlan: input.restoredActivePlan }
                  : {}),
                ...("restoredTasks" in input ? { restoredTasks: input.restoredTasks } : {}),
                ...("sessionNotes" in input ? { sessionNotes: input.sessionNotes } : {}),
                ...("projectMemories" in input ? { projectMemories: input.projectMemories } : {}),
                ...("cwd" in input ? { cwd: input.cwd } : {}),
                ...("runtimeMode" in input ? { runtimeMode: input.runtimeMode } : {}),
              },
            }
          : null;
      upsertPersistedBinding({
        threadId,
        projectId,
        provider,
        runtimeMode: session.runtimeMode,
        status: "running",
        mcpEffectiveConfigVersion: projectId ? "mcp-version-test" : null,
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload,
      });
      return Effect.succeed(session);
    });
    const sendTurn = vi.fn((_: unknown) =>
      Effect.succeed({
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
      }),
    );
    const interruptTurn = vi.fn((_: unknown) => Effect.void);
    const respondToRequest = vi.fn<ProviderServiceShape["respondToRequest"]>(() => Effect.void);
    const respondToUserInput = vi.fn<ProviderServiceShape["respondToUserInput"]>(() => Effect.void);
    const stopSession = vi.fn((input: unknown) =>
      Effect.sync(() => {
        const threadId =
          typeof input === "object" && input !== null && "threadId" in input
            ? (input as { threadId?: ThreadId }).threadId
            : undefined;
        if (!threadId) {
          return;
        }
        const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
        if (index >= 0) {
          runtimeSessions.splice(index, 1);
        }
      }),
    );
    const renameBranch = vi.fn((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "newBranch" in input &&
          typeof input.newBranch === "string"
            ? input.newBranch
            : "renamed-branch",
      }),
    );
    const generateBranchName = vi.fn(() =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateBranchName",
          detail: "disabled in test harness",
        }),
      ),
    );
    const generateThreadTitle = vi.fn<TextGenerationShape["generateThreadTitle"]>(() =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "disabled in test harness",
        }),
      ),
    );

    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const service: ProviderServiceShape = {
      startSession: startSession as ProviderServiceShape["startSession"],
      sendTurn: sendTurn as ProviderServiceShape["sendTurn"],
      interruptTurn: interruptTurn as ProviderServiceShape["interruptTurn"],
      respondToRequest: respondToRequest as ProviderServiceShape["respondToRequest"],
      respondToUserInput: respondToUserInput as ProviderServiceShape["respondToUserInput"],
      stopSession: stopSession as ProviderServiceShape["stopSession"],
      listSessions: () => Effect.succeed(runtimeSessions),
      getCapabilities: (provider) =>
        Effect.succeed({
          sessionModelSwitch: provider === "codex" ? "in-session" : "in-session",
        }),
      readThread: () => unsupported(),
      rollbackConversation: () => unsupported(),
      runOneOffPrompt: () => unsupported(),
      compactConversation: () => unsupported(),
      reloadMcpConfigForProject: () => unsupported(),
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    };
    const providerSessionDirectory = {
      upsert: (binding: ProviderRuntimeBinding) =>
        Effect.sync(() => {
          upsertPersistedBinding(binding);
        }),
      getProvider: (threadId: ThreadId) =>
        Effect.sync(() => persistedBindings.get(threadId)?.provider ?? "codex"),
      getBinding: (threadId: ThreadId) =>
        Effect.sync(() =>
          persistedBindings.has(threadId)
            ? Option.some(persistedBindings.get(threadId)!)
            : Option.none<ProviderRuntimeBinding>(),
        ),
      remove: (threadId: ThreadId) =>
        Effect.sync(() => {
          persistedBindings.delete(threadId);
        }),
      listThreadIds: () => Effect.sync(() => [...persistedBindings.keys()]),
      listBindings: () => Effect.sync(() => [...persistedBindings.values()]),
      listBindingsByProject: (projectId) =>
        Effect.sync(() =>
          [...persistedBindings.values()].filter((binding) => binding.projectId === projectId),
        ),
    } satisfies ProviderSessionDirectoryShape;

    const tracerLayer = input?.tracePath
      ? Layer.effect(
          Tracer.Tracer,
          makeLocalFileTracer({
            filePath: input.tracePath,
            maxBytes: 1024 * 1024,
            maxFiles: 2,
            batchWindowMs: 1,
          }),
        )
      : Layer.empty;

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
    );
    const layer = ProviderCommandReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(
        Layer.succeed(ProjectMcpConfigService, {
          readCommonStoredConfig: () =>
            Effect.succeed({
              scope: "common" as const,
              version: "mcp-version-test",
              servers: {},
            }),
          readProjectStoredConfig: (projectId: ProjectId) =>
            Effect.succeed({
              scope: "project" as const,
              projectId,
              version: "mcp-version-test",
              servers: {},
            }),
          readEffectiveStoredConfig: (projectId: ProjectId) =>
            Effect.succeed({
              projectId,
              commonVersion: "mcp-version-test",
              projectVersion: "mcp-version-test",
              effectiveVersion: "mcp-version-test",
              servers: {},
            }),
          readCommonConfig: () =>
            Effect.succeed({
              version: "mcp-version-test",
              servers: {},
            }),
          replaceCommonConfig: (_input) =>
            Effect.succeed({
              version: "mcp-version-test",
              servers: {},
            }),
          readProjectConfig: (projectId: ProjectId) =>
            Effect.succeed({
              projectId,
              version: "mcp-version-test",
              servers: {},
            }),
          replaceProjectConfig: (input) =>
            Effect.succeed({
              projectId: input.projectId,
              version: "mcp-version-test",
              servers: {},
            }),
          readEffectiveConfig: (projectId: ProjectId) =>
            Effect.succeed({
              projectId,
              commonVersion: "mcp-version-test",
              projectVersion: "mcp-version-test",
              effectiveVersion: "mcp-version-test",
              servers: {},
            }),
          readCodexServers: (projectId: ProjectId) =>
            Effect.succeed({
              projectId,
              effectiveVersion: "mcp-version-test",
              servers: {},
            }),
        }),
      ),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provideMerge(Layer.succeed(ProviderSessionDirectory, providerSessionDirectory)),
      Layer.provideMerge(Layer.succeed(GitCore, { renameBranch } as unknown as GitCoreShape)),
      Layer.provideMerge(
        Layer.succeed(TextGeneration, {
          generateBranchName,
          generateThreadTitle,
        } as unknown as TextGenerationShape),
      ),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), stateDir)),
      Layer.provideMerge(tracerLayer),
      Layer.provideMerge(NodeServices.layer),
    );
    const runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start.pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(reactor.drain);

    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot,
        defaultModel: "gpt-5-codex",
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: input?.threadTitle ?? "Thread",
        model: input?.threadModel ?? "gpt-5-codex",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    return {
      engine,
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      renameBranch,
      generateBranchName,
      generateThreadTitle,
      stateDir,
      workspaceRoot,
      upsertBinding: (binding: ProviderRuntimeBinding) => {
        upsertPersistedBinding(binding);
      },
      drain,
    };
  }

  it("reacts to thread.turn.start by ensuring session and sending provider turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-1"),
          role: "user",
          text: "hello reactor",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[0]).toEqual(ThreadId.makeUnsafe("thread-1"));
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: harness.workspaceRoot,
      projectTitle: "Provider Project",
      threadTitle: "Thread",
      turnCount: 0,
      model: "gpt-5-codex",
      runtimeMode: "approval-required",
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("seeds thread token usage with hidden instructions and AGENTS.md context", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(harness.workspaceRoot, "AGENTS.md"), "a".repeat(4_000), "utf8");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-hidden-context"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-hidden-context"),
          role: "user",
          text: "hello reactor",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));

    expect(thread?.estimatedContextTokens).toBeGreaterThan(
      roughTokenEstimateFromCharacters("hello reactor".length + 4_000),
    );
    expect(thread?.session?.estimatedContextTokens).toBe(thread?.estimatedContextTokens);
    expect(thread?.session?.tokenUsageSource).toBe("estimated");
  });

  it("records ensure-session traces and reactor event metrics", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-reactor-observability-"));
    const tracePath = path.join(stateDir, "logs", "observability", "traces.ndjson");
    const before = await Effect.runPromise(Metric.snapshot);
    const harness = await createHarness({ stateDir, tracePath });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-observability"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-observability"),
          role: "user",
          text: "hello observability",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await Effect.runPromise(Effect.sleep("25 millis"));

    const after = await Effect.runPromise(Metric.snapshot);
    expect(
      counterValue(after, "t3_orchestration_events_processed_total", {
        eventType: "thread.turn-start-requested",
      }) -
        counterValue(before, "t3_orchestration_events_processed_total", {
          eventType: "thread.turn-start-requested",
        }),
    ).toBeGreaterThanOrEqual(1);

    const traceLines = fs
      .readFileSync(tracePath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { name: string; attributes?: Record<string, unknown> });

    expect(
      traceLines.some(
        (record) =>
          record.name === "provider.ensure-session" &&
          record.attributes?.["provider.session_decision"] === "start",
      ),
    ).toBe(true);
    expect(traceLines.some((record) => record.name === "provider.start-session")).toBe(true);
  });

  it("forwards codex model options through session start and turn send", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-fast"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-fast"),
          role: "user",
          text: "hello fast mode",
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
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      model: "gpt-5.3-codex",
      modelOptions: {
        codex: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      model: "gpt-5.3-codex",
      modelOptions: {
        codex: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
    });
  });

  it("forwards claude model options through session start and turn send", async () => {
    const harness = await createHarness({ threadModel: "claude-opus-4-6" });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-options"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-options"),
          role: "user",
          text: "hello claude options",
          attachments: [],
        },
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        modelOptions: {
          claudeAgent: {
            effort: "max",
            fastMode: true,
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      modelOptions: {
        claudeAgent: {
          effort: "max",
          fastMode: true,
        },
      },
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      model: "claude-opus-4-6",
      modelOptions: {
        claudeAgent: {
          effort: "max",
          fastMode: true,
        },
      },
    });
  });

  it("forwards plan interaction mode to the provider turn request", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.makeUnsafe("cmd-interaction-mode-set-plan"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        interactionMode: "plan",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-plan"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-plan"),
          role: "user",
          text: "plan this change",
          attachments: [],
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      interactionMode: "plan",
    });
  });

  it("reuses the same provider session when runtime mode is unchanged", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-unchanged-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-unchanged-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);
  });

  it("resumes a stopped session when persisted resume state still exists", async () => {
    const harness = await createHarness({ threadModel: "claude-sonnet-4-6" });
    const now = new Date().toISOString();

    harness.upsertBinding({
      threadId: ThreadId.makeUnsafe("thread-1"),
      provider: "claudeAgent",
      runtimeMode: "approval-required",
      resumeCursor: {
        resume: "resume-cursor-stopped",
        threadId: "thread-1",
      },
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-stopped"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "stopped",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-resume-stopped"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-resume-stopped"),
          role: "user",
          text: "continue from the saved plan",
          attachments: [],
        },
        provider: "claudeAgent",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      provider: "claudeAgent",
      resumeCursor: {
        resume: "resume-cursor-stopped",
        threadId: "thread-1",
      },
    });
  });

  it("restarts claude sessions when the selected claude model changes", async () => {
    const harness = await createHarness({ threadModel: "claude-sonnet-4-6" });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-model-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-model-1"),
          role: "user",
          text: "first claude turn",
          attachments: [],
        },
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-model-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-model-2"),
          role: "user",
          text: "second claude turn",
          attachments: [],
        },
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
    });
    expect(
      (harness.startSession.mock.calls[1]?.[1] as { resumeCursor?: unknown } | undefined)
        ?.resumeCursor,
    ).toBeUndefined();
  });

  it("restarts claude sessions when claude model options change", async () => {
    const harness = await createHarness({ threadModel: "claude-sonnet-4-6" });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-options-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-options-1"),
          role: "user",
          text: "first claude turn",
          attachments: [],
        },
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        modelOptions: {
          claudeAgent: {
            effort: "medium",
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-options-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-options-2"),
          role: "user",
          text: "second claude turn",
          attachments: [],
        },
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        modelOptions: {
          claudeAgent: {
            effort: "max",
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      modelOptions: {
        claudeAgent: {
          effort: "max",
        },
      },
    });
    expect(
      (harness.startSession.mock.calls[1]?.[1] as { resumeCursor?: unknown } | undefined)
        ?.resumeCursor,
    ).toBeUndefined();
  });

  it("does not restart claude sessions when model options are semantically unchanged", async () => {
    const harness = await createHarness({ threadModel: "claude-sonnet-4-6" });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-options-stable-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-options-stable-1"),
          role: "user",
          text: "first claude turn",
          attachments: [],
        },
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        modelOptions: {
          claudeAgent: {
            effort: "max",
            fastMode: true,
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-options-stable-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-options-stable-2"),
          role: "user",
          text: "second claude turn",
          attachments: [],
        },
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        modelOptions: {
          claudeAgent: {
            fastMode: true,
            effort: "max",
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession).toHaveBeenCalledTimes(1);
  });

  it("restarts claude sessions when claude provider options change", async () => {
    const harness = await createHarness({ threadModel: "claude-sonnet-4-6" });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-provider-options-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-provider-options-1"),
          role: "user",
          text: "first claude turn",
          attachments: [],
        },
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        providerOptions: {
          claudeAgent: {
            subagentsEnabled: true,
            subagentModel: "inherit",
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-provider-options-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-provider-options-2"),
          role: "user",
          text: "second claude turn",
          attachments: [],
        },
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        providerOptions: {
          claudeAgent: {
            subagentsEnabled: false,
            subagentModel: "claude-haiku-4-5",
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      providerOptions: {
        claudeAgent: {
          subagentsEnabled: false,
          subagentModel: "claude-haiku-4-5",
        },
      },
    });
    expect(
      (harness.startSession.mock.calls[1]?.[1] as { resumeCursor?: unknown } | undefined)
        ?.resumeCursor,
    ).toBeUndefined();
  });

  it("does not restart claude sessions when provider options are semantically unchanged", async () => {
    const harness = await createHarness({ threadModel: "claude-sonnet-4-6" });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-provider-options-stable-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-provider-options-stable-1"),
          role: "user",
          text: "first claude turn",
          attachments: [],
        },
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        providerOptions: {
          claudeAgent: {
            subagentsEnabled: true,
            subagentModel: "inherit",
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-provider-options-stable-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-provider-options-stable-2"),
          role: "user",
          text: "second claude turn",
          attachments: [],
        },
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        providerOptions: {
          claudeAgent: {
            subagentsEnabled: true,
            subagentModel: "inherit",
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession).toHaveBeenCalledTimes(1);
  });

  it("does not restart claude sessions when only unrelated provider slices change", async () => {
    const harness = await createHarness({ threadModel: "claude-sonnet-4-6" });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-provider-options-mixed-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-provider-options-mixed-1"),
          role: "user",
          text: "first claude turn",
          attachments: [],
        },
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        providerOptions: {
          codex: {
            binaryPath: "/tmp/codex-a",
          },
          claudeAgent: {
            subagentsEnabled: false,
            subagentModel: "claude-haiku-4-5",
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-claude-provider-options-mixed-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-provider-options-mixed-2"),
          role: "user",
          text: "second claude turn",
          attachments: [],
        },
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        providerOptions: {
          codex: {
            binaryPath: "/tmp/codex-b",
          },
          claudeAgent: {
            subagentsEnabled: false,
            subagentModel: "claude-haiku-4-5",
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession).toHaveBeenCalledTimes(1);
  });

  it("does not restart codex sessions when only codex environment options change", async () => {
    const harness = await createHarness({ threadModel: "gpt-5.3-codex" });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-codex-provider-options-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-codex-provider-options-1"),
          role: "user",
          text: "first codex turn",
          attachments: [],
        },
        provider: "codex",
        model: "gpt-5.3-codex",
        providerOptions: {
          codex: {
            binaryPath: "/tmp/codex-a",
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-codex-provider-options-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-codex-provider-options-2"),
          role: "user",
          text: "second codex turn",
          attachments: [],
        },
        provider: "codex",
        model: "gpt-5.3-codex",
        providerOptions: {
          codex: {
            binaryPath: "/tmp/codex-b",
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession).toHaveBeenCalledTimes(1);
  });

  it("restarts codex sessions when MCP servers change", async () => {
    const harness = await createHarness({ threadModel: "gpt-5.3-codex" });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-codex-mcp-options-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-codex-mcp-options-1"),
          role: "user",
          text: "first codex turn",
          attachments: [],
        },
        provider: "codex",
        model: "gpt-5.3-codex",
        providerOptions: {
          mcpServers: {
            filesystem: {
              type: "stdio",
              command: "npx",
              args: ["@modelcontextprotocol/server-filesystem"],
            },
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-codex-mcp-options-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-codex-mcp-options-2"),
          role: "user",
          text: "second codex turn",
          attachments: [],
        },
        provider: "codex",
        model: "gpt-5.3-codex",
        providerOptions: {
          mcpServers: {
            filesystem: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
            },
          },
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(
      (harness.startSession.mock.calls[1]?.[1] as { resumeCursor?: unknown } | undefined)
        ?.resumeCursor,
    ).toBeUndefined();
  });

  it("restarts the provider session when runtime mode is updated on the thread", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-initial-full-access"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-runtime-mode-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-runtime-mode-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
      resumeCursor: { opaque: "cursor-1" },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.makeUnsafe("thread-1"),
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("generates a first-thread title asynchronously without blocking the provider turn", async () => {
    const harness = await createHarness({ threadTitle: DEFAULT_NEW_THREAD_TITLE });
    const now = new Date().toISOString();
    const titleResult = Promise.withResolvers<{ title: string }>();
    harness.generateThreadTitle.mockImplementationOnce(() =>
      Effect.promise(() => titleResult.promise),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-title-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-1"),
          role: "user",
          text: "provider message text",
          attachments: [],
        },
        titleGenerationModel: "custom/title-model",
        titleSourceText: "Raw first prompt",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      message: "Raw first prompt",
      model: "custom/title-model",
    });

    let readModel = await Effect.runPromise(harness.engine.getReadModel());
    let thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.title).toBe(DEFAULT_NEW_THREAD_TITLE);

    titleResult.resolve({ title: "Fix sidebar layout" });

    await waitFor(async () => {
      const nextReadModel = await Effect.runPromise(harness.engine.getReadModel());
      const nextThread = nextReadModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return nextThread?.title === "Fix sidebar layout";
    });

    readModel = await Effect.runPromise(harness.engine.getReadModel());
    thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.title).toBe("Fix sidebar layout");
  });

  it("uses the default title-generation model when the turn omits one", async () => {
    const harness = await createHarness({ threadTitle: DEFAULT_NEW_THREAD_TITLE });
    const now = new Date().toISOString();
    harness.generateThreadTitle.mockImplementationOnce(() =>
      Effect.succeed({ title: "Fallback model title" }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-title-default-model"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-default-model"),
          role: "user",
          text: "provider message text",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      model: DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER.codex,
      message: "provider message text",
    });
  });

  it("retries thread title generation with the default model when spark is unsupported", async () => {
    const harness = await createHarness({ threadTitle: DEFAULT_NEW_THREAD_TITLE });
    const now = new Date().toISOString();
    harness.generateThreadTitle
      .mockImplementationOnce(() =>
        Effect.fail(
          new TextGenerationError({
            operation: "generateThreadTitle",
            detail:
              "Codex CLI command failed: The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.",
          }),
        ),
      )
      .mockImplementationOnce(() => Effect.succeed({ title: "Retry succeeded" }));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-title-spark-retry"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-spark-retry"),
          role: "user",
          text: "provider message text",
          attachments: [],
        },
        titleGenerationModel: "gpt-5.3-codex-spark",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 2);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      model: "gpt-5.3-codex-spark",
      message: "provider message text",
    });
    expect(harness.generateThreadTitle.mock.calls[1]?.[0]).toMatchObject({
      model: DEFAULT_THREAD_TITLE_MODEL_BY_PROVIDER.codex,
      message: "provider message text",
    });

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return thread?.title === "Retry succeeded";
    });
  });

  it("does not generate titles for second and later user messages", async () => {
    const harness = await createHarness({ threadTitle: DEFAULT_NEW_THREAD_TITLE });
    const now = new Date().toISOString();
    harness.generateThreadTitle.mockImplementation(() => Effect.succeed({ title: "First title" }));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-title-first"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-first"),
          role: "user",
          text: "first message",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return thread?.title === "First title";
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-title-second"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-second"),
          role: "user",
          text: "second message",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.generateThreadTitle.mock.calls.length).toBe(1);
  });

  it("does not overwrite a manual rename when the generated title arrives later", async () => {
    const harness = await createHarness({ threadTitle: DEFAULT_NEW_THREAD_TITLE });
    const now = new Date().toISOString();
    const titleResult = Promise.withResolvers<{ title: string }>();
    harness.generateThreadTitle.mockImplementationOnce(() =>
      Effect.promise(() => titleResult.promise),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-title-manual-rename"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-manual-rename"),
          role: "user",
          text: "first message",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-thread-manual-rename"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        title: "Manual rename wins",
      }),
    );

    titleResult.resolve({ title: "Generated title loses" });
    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return thread?.title === "Manual rename wins";
    });
  });

  it("applies a fallback heuristic title when generation fails", async () => {
    const harness = await createHarness({ threadTitle: DEFAULT_NEW_THREAD_TITLE });
    const now = new Date().toISOString();
    harness.generateThreadTitle.mockImplementationOnce(() =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "simulated failure",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-title-fallback"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-fallback"),
          role: "user",
          text: "provider message text",
          attachments: [],
        },
        titleSourceText: "  Fix the oversized sidebar width.  ",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return thread?.title === "Fix the oversized sidebar width";
    });
  });

  it("does not apply a generated title after a second user message arrives", async () => {
    const harness = await createHarness({ threadTitle: DEFAULT_NEW_THREAD_TITLE });
    const now = new Date().toISOString();
    const titleResult = Promise.withResolvers<{ title: string }>();
    harness.generateThreadTitle.mockImplementationOnce(() =>
      Effect.promise(() => titleResult.promise),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-title-race-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-race-1"),
          role: "user",
          text: "first message",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-title-race-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-race-2"),
          role: "user",
          text: "second message",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    titleResult.resolve({ title: "Should not apply" });
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.title).toBe(DEFAULT_NEW_THREAD_TITLE);
  });

  it("does not apply a generated title after the thread is deleted", async () => {
    const harness = await createHarness({ threadTitle: DEFAULT_NEW_THREAD_TITLE });
    const now = new Date().toISOString();
    const titleResult = Promise.withResolvers<{ title: string }>();
    harness.generateThreadTitle.mockImplementationOnce(() =>
      Effect.promise(() => titleResult.promise),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-title-delete"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-delete"),
          role: "user",
          text: "first message",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.makeUnsafe("cmd-thread-delete-before-title"),
        threadId: ThreadId.makeUnsafe("thread-1"),
      }),
    );

    titleResult.resolve({ title: "Should not apply" });
    await new Promise((resolve) => setTimeout(resolve, 25));

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.deletedAt).not.toBeNull();
    expect(thread?.title).toBe(DEFAULT_NEW_THREAD_TITLE);
  });

  it("does not stop the active session when restart fails before rebind", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-initial-full-access-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-restart-failure-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-restart-failure-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    harness.startSession.mockImplementationOnce(
      (_: unknown, __: unknown) => Effect.fail(new Error("simulated restart failure")) as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.makeUnsafe("cmd-runtime-mode-set-restart-failure"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await harness.drain();

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(1);

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("full-access");
  });

  it("reacts to thread.turn.interrupt-requested by calling provider interrupt", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("cmd-turn-interrupt"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
    });
  });

  it("reacts to thread.approval.respond by forwarding provider approval response", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-approval"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.makeUnsafe("cmd-approval-respond"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "accept",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToRequest.mock.calls.length === 1);
    expect(harness.respondToRequest.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "approval-request-1",
      decision: "accept",
    });
  });

  it("reacts to thread.user-input.respond by forwarding structured user input answers", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-user-input"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.makeUnsafe("cmd-user-input-respond"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToUserInput.mock.calls.length === 1);
    expect(harness.respondToUserInput.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "user-input-request-1",
      answers: {
        sandbox_mode: "workspace-write",
      },
    });
  });

  it("surfaces stale provider approval request failures without faking approval resolution", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    harness.respondToRequest.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "session/request_permission",
          detail: "Unknown pending permission request: approval-request-1",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-approval-error"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe("cmd-approval-requested"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        activity: {
          id: EventId.makeUnsafe("activity-approval-requested"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Command approval requested",
          payload: {
            requestId: "approval-request-1",
            requestKind: "command",
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.makeUnsafe("cmd-approval-respond-stale"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "acceptForSession",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.approval.respond.failed",
      );
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.approval.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "approval-request-1",
    });

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "approval.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "approval-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  it("reacts to thread.session.stop by stopping provider session and clearing thread session state", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-stop"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.makeUnsafe("cmd-session-stop"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session).not.toBeNull();
    expect(thread?.session?.status).toBe("stopped");
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.activeTurnId).toBeNull();
  });
});
