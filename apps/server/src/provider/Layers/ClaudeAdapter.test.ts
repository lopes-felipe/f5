import { vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  query,
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type PermissionResult,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  ProviderInstanceId,
  ProviderItemId,
  ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Random, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import { clearAnthropicModelContextWindowCatalogCacheForTest } from "../modelContextWindowMetadata.ts";
import { ClaudeAdapter } from "../Services/ClaudeAdapter.ts";
import {
  buildClaudeAssistantInstructions,
  buildInstructionProfile,
} from "../sharedAssistantContract.ts";
import {
  buildClaudeQueryEnv,
  isClaudeMissingConversationError,
  makeClaudeAdapterLive,
  probeClaudeSessionAvailability,
  resolveClaudeConfigDir,
  type ClaudeAdapterLiveOptions,
  type ClaudeSessionProbeInput,
  type ClaudeSessionStoreFs,
} from "./ClaudeAdapter.ts";
import { FakeClaudeCodeProcess, respondToInitializeRequest } from "./ClaudeSdk.testUtils.ts";

type ClaudeQueryOptionsForTest = Omit<ClaudeQueryOptions, "effort"> & {
  readonly effort?: string;
};

class FakeClaudeQuery implements AsyncIterable<SDKMessage> {
  private readonly queue: Array<SDKMessage> = [];
  private readonly waiters: Array<{
    readonly resolve: (value: IteratorResult<SDKMessage>) => void;
    readonly reject: (reason: unknown) => void;
  }> = [];
  private done = false;
  private failure: unknown | undefined;

  public readonly interruptCalls: Array<void> = [];
  public readonly setModelCalls: Array<string | undefined> = [];
  public readonly setPermissionModeCalls: Array<string> = [];
  public readonly applyFlagSettingsCalls: Array<Record<string, unknown>> = [];
  public closeCalls = 0;
  public onClose: (() => void) | undefined;
  public readonly deliveredAfterClose: SDKMessage[] = [];

  /** Simulate buffered transport frames that remain readable after close. */
  forceEmit(message: SDKMessage): void {
    this.queue.push(message);
  }
  public initializationResultValue: unknown = {
    commands: [],
    agents: [],
    output_style: "default",
    available_output_styles: ["default"],
    models: [],
    account: {},
  };
  public supportedModelsValue: ReadonlyArray<unknown> = [];
  private supportedModelsPromise: Promise<ReadonlyArray<unknown>> | undefined;
  public supportedCommands?: () => Promise<
    ReadonlyArray<{
      readonly name: string;
      readonly description: string;
      readonly argumentHint?: string;
    }>
  >;

  setSupportedCommandsResult(
    result: ReadonlyArray<{
      readonly name: string;
      readonly description: string;
      readonly argumentHint?: string;
    }>,
  ): void {
    this.supportedCommands = async () => result;
  }

  setInitializationResult(result: unknown): void {
    this.initializationResultValue = result;
  }

  setSupportedModelsResult(result: ReadonlyArray<unknown>): void {
    this.supportedModelsValue = result;
    this.supportedModelsPromise = undefined;
  }

  setSupportedModelsPromise(result: Promise<ReadonlyArray<unknown>>): void {
    this.supportedModelsPromise = result;
  }

  emit(message: SDKMessage): void {
    if (this.done) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: message });
      return;
    }
    this.queue.push(message);
  }

  fail(cause: unknown): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.failure = cause;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(cause);
    }
  }

  finish(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.failure = undefined;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  readonly interrupt = async (): Promise<void> => {
    this.interruptCalls.push(undefined);
  };

  public setModelWait: Promise<void> | undefined;
  readonly setModel = async (model?: string): Promise<void> => {
    this.setModelCalls.push(model);
    await this.setModelWait;
  };

  readonly setPermissionMode = async (mode: PermissionMode): Promise<void> => {
    this.setPermissionModeCalls.push(mode);
  };

  readonly applyFlagSettings = async (settings: Record<string, unknown>): Promise<void> => {
    this.applyFlagSettingsCalls.push(settings);
  };

  readonly initializationResult = async (): Promise<unknown> => this.initializationResultValue;

  readonly supportedModels = async (): Promise<ReadonlyArray<unknown>> =>
    this.supportedModelsPromise ?? this.supportedModelsValue;

  readonly close = (): void => {
    this.closeCalls += 1;
    this.finish();
    this.onClose?.();
  };

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          const value = this.queue.shift();
          if (value) {
            if (this.closeCalls > 0) this.deliveredAfterClose.push(value);
            return Promise.resolve({
              done: false,
              value,
            });
          }
        }
        if (this.failure !== undefined) {
          const failure = this.failure;
          this.failure = undefined;
          return Promise.reject(failure);
        }
        if (this.done) {
          return Promise.resolve({
            done: true,
            value: undefined,
          });
        }
        return new Promise((resolve, reject) => {
          this.waiters.push({
            resolve,
            reject,
          });
        });
      },
    };
  }
}

function makeHarness(config?: {
  readonly oneOffProviderOptions?: ClaudeAdapterLiveOptions["oneOffProviderOptions"];
  readonly processEnvironment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: ClaudeAdapterLiveOptions["nativeEventLogger"];
  readonly cwd?: string;
  readonly stateDir?: string;
  readonly probeResumableClaudeSession?: ClaudeAdapterLiveOptions["probeResumableClaudeSession"];
}) {
  const query = new FakeClaudeQuery();
  const queries = [query];
  const createInputs: Array<{
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptionsForTest;
  }> = [];
  let createInput:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
        readonly options: ClaudeQueryOptionsForTest;
      }
    | undefined;

  const adapterOptions: ClaudeAdapterLiveOptions = {
    ...(config?.oneOffProviderOptions
      ? { oneOffProviderOptions: config.oneOffProviderOptions }
      : {}),
    ...(config?.processEnvironment ? { processEnvironment: config.processEnvironment } : {}),
    createQuery: (input) => {
      createInput = input;
      createInputs.push(input);
      const nextQuery = queries[createInputs.length - 1] ?? new FakeClaudeQuery();
      if (!queries.includes(nextQuery)) queries.push(nextQuery);
      return nextQuery;
    },
    probeResumableClaudeSession:
      config?.probeResumableClaudeSession ?? (() => Effect.succeed("unknown" as const)),
    ...(config?.nativeEventLogger
      ? {
          nativeEventLogger: config.nativeEventLogger,
        }
      : {}),
    ...(config?.nativeEventLogPath
      ? {
          nativeEventLogPath: config.nativeEventLogPath,
        }
      : {}),
  };

  return {
    layer: makeClaudeAdapterLive(adapterOptions).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(
          config?.cwd ?? "/tmp/claude-adapter-test",
          config?.stateDir ?? "/tmp",
        ),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
    query,
    queries,
    getCreateQueryInputs: () => createInputs,
    getLastCreateQueryInput: () => createInput,
  };
}

function makeRealSdkHarness(config?: {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: ClaudeAdapterLiveOptions["nativeEventLogger"];
  readonly cwd?: string;
  readonly stateDir?: string;
}) {
  let createInput:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
        readonly options: ClaudeQueryOptionsForTest;
      }
    | undefined;
  let activeQuery: ReturnType<typeof query> | undefined;
  let firstPromptWrittenResolve: (() => void) | undefined;
  const firstPromptWritten = new Promise<void>((resolve) => {
    firstPromptWrittenResolve = resolve;
  });

  const adapterOptions: ClaudeAdapterLiveOptions = {
    createQuery: (input) => {
      createInput = input;
      activeQuery = query({
        prompt: input.prompt,
        options: {
          ...input.options,
          persistSession: false,
          spawnClaudeCodeProcess: () =>
            new FakeClaudeCodeProcess((message, process) => {
              if (respondToInitializeRequest(message, process)) {
                return;
              }

              if (message.type === "user") {
                firstPromptWrittenResolve?.();
                firstPromptWrittenResolve = undefined;
              }
            }),
        } as ClaudeQueryOptions,
      });
      return activeQuery;
    },
    probeResumableClaudeSession: () => Effect.succeed("unknown" as const),
    ...(config?.nativeEventLogger
      ? {
          nativeEventLogger: config.nativeEventLogger,
        }
      : {}),
    ...(config?.nativeEventLogPath
      ? {
          nativeEventLogPath: config.nativeEventLogPath,
        }
      : {}),
  };

  return {
    layer: makeClaudeAdapterLive(adapterOptions).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(
          config?.cwd ?? "/tmp/claude-adapter-test",
          config?.stateDir ?? "/tmp",
        ),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
    awaitFirstPromptWritten: () => firstPromptWritten,
    awaitInitialization: async () => {
      if (!activeQuery) {
        throw new Error("Claude SDK query was not created.");
      }
      await activeQuery.initializationResult();
    },
    getLastCreateQueryInput: () => createInput,
  };
}

function makeDeterministicRandomService(seed = 0x1234_5678): {
  nextIntUnsafe: () => number;
  nextDoubleUnsafe: () => number;
} {
  let state = seed >>> 0;
  const nextIntUnsafe = (): number => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state;
  };

  return {
    nextIntUnsafe,
    nextDoubleUnsafe: () => nextIntUnsafe() / 0x1_0000_0000,
  };
}

async function readFirstPromptText(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
): Promise<string | undefined> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  if (!iterator) {
    return undefined;
  }
  const next = await iterator.next();
  if (next.done) {
    return undefined;
  }
  const content = next.value.message.content[0];
  if (!content || typeof content === "string" || content.type !== "text") {
    return undefined;
  }
  return content.text;
}

async function readFirstPromptMessage(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
): Promise<SDKUserMessage | undefined> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  if (!iterator) {
    return undefined;
  }
  const next = await iterator.next();
  if (next.done) {
    return undefined;
  }
  return next.value;
}

const THREAD_ID = ThreadId.makeUnsafe("thread-claude-1");
const RESUME_THREAD_ID = ThreadId.makeUnsafe("thread-claude-resume");
const BACKGROUND_SESSION_ID = "sdk-session-background-task";

function emitBashToolStart(
  query: FakeClaudeQuery,
  input: {
    readonly toolUseId: string;
    readonly command?: string;
    readonly index?: number;
    readonly sessionId?: string;
    readonly uuid?: string;
  },
): void {
  query.emit({
    type: "stream_event",
    session_id: input.sessionId ?? BACKGROUND_SESSION_ID,
    uuid: input.uuid ?? `stream-${input.toolUseId}-start`,
    parent_tool_use_id: null,
    event: {
      type: "content_block_start",
      index: input.index ?? 0,
      content_block: {
        type: "tool_use",
        id: input.toolUseId,
        name: "Bash",
        input: {
          command: input.command ?? "sleep 10",
        },
      },
    },
  } as unknown as SDKMessage);
}

function emitClaudeTaskStarted(
  query: FakeClaudeQuery,
  input: {
    readonly taskId: string;
    readonly toolUseId: string;
    readonly description?: string;
    readonly sessionId?: string;
    readonly uuid?: string;
  },
): void {
  query.emit({
    type: "system",
    subtype: "task_started",
    task_id: input.taskId,
    tool_use_id: input.toolUseId,
    task_type: "bash",
    description: input.description ?? "Run background command",
    session_id: input.sessionId ?? BACKGROUND_SESSION_ID,
    uuid: input.uuid ?? `task-started-${input.taskId}`,
  } as unknown as SDKMessage);
}

function emitClaudeTaskUpdated(
  query: FakeClaudeQuery,
  input: {
    readonly taskId: string;
    readonly patch: Record<string, unknown>;
    readonly sessionId?: string;
    readonly uuid?: string;
  },
): void {
  query.emit({
    type: "system",
    subtype: "task_updated",
    task_id: input.taskId,
    patch: input.patch,
    session_id: input.sessionId ?? BACKGROUND_SESSION_ID,
    uuid: input.uuid ?? `task-updated-${input.taskId}`,
  } as unknown as SDKMessage);
}

function emitBackgroundToolResult(
  query: FakeClaudeQuery,
  input: {
    readonly toolUseId: string;
    readonly taskId: string;
    readonly sessionId?: string;
    readonly uuid?: string;
  },
): void {
  query.emit({
    type: "user",
    session_id: input.sessionId ?? BACKGROUND_SESSION_ID,
    uuid: input.uuid ?? `user-background-${input.taskId}`,
    parent_tool_use_id: null,
    tool_use_result: {
      backgroundTaskId: input.taskId,
    },
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: input.toolUseId,
          content: `Command is running in the background with ID: ${input.taskId}`,
        },
      ],
    },
  } as unknown as SDKMessage);
}

function emitClaudeSuccessResult(
  query: FakeClaudeQuery,
  input?: {
    readonly sessionId?: string;
    readonly uuid?: string;
  },
): void {
  query.emit({
    type: "result",
    subtype: "success",
    is_error: false,
    errors: [],
    session_id: input?.sessionId ?? BACKGROUND_SESSION_ID,
    uuid: input?.uuid ?? "result-background-task",
  } as unknown as SDKMessage);
}

describe("ClaudeAdapterLive", () => {
  for (const sessionSignals of [false, true]) {
    it.effect(
      `keeps background continuations in one turn (idle signals: ${sessionSignals})`,
      () => {
        const harness = makeHarness();
        return Effect.gen(function* () {
          const adapter = yield* ClaudeAdapter;
          const sessionId = "550e8400-e29b-41d4-a716-446655440000";
          const emit = (message: Record<string, unknown>) =>
            harness.query.emit({
              uuid: crypto.randomUUID(),
              session_id: sessionId,
              ...message,
            } as unknown as SDKMessage);
          const drain = (uuid: string) => {
            emit({ type: "system", subtype: "status", status: "requesting", uuid });
            return adapter.streamEvents.pipe(
              Stream.takeUntil(
                (event) => (event.raw?.payload as { uuid?: string } | undefined)?.uuid === uuid,
              ),
              Stream.runCollect,
            );
          };
          const parentSegment = (uuid: string, text: string, cost: number) => {
            emit({
              type: "stream_event",
              parent_tool_use_id: null,
              event: {
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
              },
            });
            emit({
              type: "stream_event",
              parent_tool_use_id: null,
              event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
            });
            emit({
              type: "stream_event",
              parent_tool_use_id: null,
              event: { type: "content_block_stop", index: 0 },
            });
            emit({
              type: "assistant",
              uuid,
              parent_tool_use_id: null,
              message: { content: [{ type: "text", text }] },
            });
            emit({
              type: "result",
              subtype: "success",
              is_error: false,
              uuid: `result-${uuid}`,
              result: text,
              total_cost_usd: cost,
              modelUsage: {},
              stop_reason: "end_turn",
            });
          };

          yield* adapter.startSession({
            threadId: THREAD_ID,
            provider: "claudeAgent",
            runtimeMode: "full-access",
          });
          const turn = yield* adapter.sendTurn({
            threadId: THREAD_ID,
            input: "Create a plan",
            attachments: [],
          });
          if (sessionSignals)
            emit({ type: "system", subtype: "session_state_changed", state: "running" });
          emit({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: ["a", "b", "c"].map((task_id) => ({ task_id, task_type: "local_agent" })),
          });
          for (const taskId of ["a", "b", "c"]) {
            emitClaudeTaskStarted(harness.query, { taskId, toolUseId: taskId, sessionId });
          }
          parentSegment("waiting", "Waiting on the explorers now.", 0.4);
          const first = yield* drain("after-wait");
          assert.equal(
            first.some((event) => event.type === "turn.completed"),
            false,
          );
          assert.equal((yield* adapter.readThread(THREAD_ID)).turns.length, 0);
          assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, turn.turnId);
          const nextSend = yield* adapter
            .sendTurn({ threadId: THREAD_ID, input: "next", attachments: [] })
            .pipe(Effect.result);
          assert.equal(nextSend._tag, "Failure");

          emit({
            type: "assistant",
            parent_tool_use_id: "a",
            uuid: "child-uuid",
            message: {
              model: "claude-sonnet-4-6",
              content: [{ type: "text", text: "Private child output" }],
            },
          });
          emit({ type: "system", subtype: "background_tasks_changed", tasks: [] });
          // Late starts cannot resurrect tasks after a replacement snapshot.
          emitClaudeTaskStarted(harness.query, { taskId: "c", toolUseId: "c", sessionId });
          for (const task_id of ["a", "b", "c"]) {
            emit({ type: "system", subtype: "task_notification", task_id, status: "completed" });
          }
          const taskEvents = yield* drain("after-tasks");
          assert.equal(
            taskEvents.some((event) => event.type === "turn.completed"),
            false,
          );
          const finalText = "<proposed_plan>\n# Complete plan\n</proposed_plan>";
          parentSegment("final-parent", finalText, 0.9);
          if (sessionSignals) {
            const beforeIdle = yield* drain("before-idle");
            assert.equal(
              beforeIdle.some((event) => event.type === "turn.completed"),
              false,
            );
            emit({ type: "system", subtype: "session_state_changed", state: "idle" });
          }
          const finalEvents = yield* drain("after-final");
          const completions = finalEvents.filter((event) => event.type === "turn.completed");
          assert.equal(completions.length, 1);
          assert.equal(completions[0]?.turnId, turn.turnId);
          assert.equal(completions[0]?.payload.totalCostUsd, 0.9);
          const cursor = completions[0]?.resumeCursor as {
            resumeSessionAt: string;
            turnBoundaries: Array<{ turnId: string }>;
          };
          assert.equal(cursor.resumeSessionAt, "final-parent");
          assert.deepEqual(
            cursor.turnBoundaries.map((entry) => entry.turnId),
            [turn.turnId],
          );
          assert.equal((yield* adapter.readThread(THREAD_ID)).turns.length, 1);
          assert.equal(
            finalEvents.some((event) => event.type === "turn.started"),
            false,
          );
          assert.equal(
            [...first, ...taskEvents, ...finalEvents].some(
              (event) =>
                event.type === "content.delta" &&
                event.payload.delta.includes("Private child output"),
            ),
            false,
          );
          // A queued follow-up becomes admissible only after the logical turn.
          yield* adapter.sendTurn({ threadId: THREAD_ID, input: "next", attachments: [] });
        }).pipe(Effect.provide(harness.layer));
      },
    );
  }

  for (const ending of ["interrupt", "rate-limit", "zeroed-error", "stream-exit"] as const) {
    it.effect(
      `retires a background-waiting process after ${ending} and suppresses trailers`,
      () => {
        const harness = makeHarness();
        return Effect.gen(function* () {
          const adapter = yield* ClaudeAdapter;
          const emit = (payload: Record<string, unknown>) =>
            harness.query.emit({
              uuid: crypto.randomUUID(),
              session_id: BACKGROUND_SESSION_ID,
              ...payload,
            } as unknown as SDKMessage);
          yield* adapter.startSession({
            threadId: THREAD_ID,
            provider: "claudeAgent",
            runtimeMode: "full-access",
          });
          const turn = yield* adapter.sendTurn({
            threadId: THREAD_ID,
            input: "explore",
            attachments: [],
          });
          emit({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [{ task_id: "explorer", task_type: "local_agent" }],
          });
          emit({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.4 });
          emit({ type: "system", subtype: "status", status: "requesting", uuid: "wait-barrier" });
          yield* adapter.streamEvents.pipe(
            Stream.takeUntil(
              (event) => (event.raw?.payload as { uuid?: string })?.uuid === "wait-barrier",
            ),
            Stream.runCollect,
          );
          if (ending === "rate-limit" || ending === "zeroed-error") {
            harness.query.onClose = () => {
              for (const message of [
                {
                  type: "assistant",
                  message: { content: [{ type: "text", text: "Late explorer" }] },
                },
                { type: "result", subtype: "success", is_error: false },
                { type: "system", subtype: "session_state_changed", state: "idle" },
              ])
                harness.query.forceEmit({
                  uuid: crypto.randomUUID(),
                  session_id: BACKGROUND_SESSION_ID,
                  ...message,
                } as unknown as SDKMessage);
            };
          }
          if (ending === "interrupt") yield* adapter.interruptTurn(THREAD_ID, turn.turnId);
          else if (ending === "rate-limit" || ending === "zeroed-error") {
            emit({
              type: "result",
              subtype: "success",
              is_error: true,
              result: "Session limit reached",
              total_cost_usd: ending === "zeroed-error" ? 0 : 0.6,
            });
          } else harness.query.fail(new Error("transport disconnected"));
          const terminal = yield* adapter.streamEvents.pipe(
            Stream.takeUntil((event) => event.type === "session.exited"),
            Stream.runCollect,
          );
          const completions = terminal.filter((event) => event.type === "turn.completed");
          assert.equal(completions.length, 1);
          assert.equal(completions[0]?.turnId, turn.turnId);
          assert.equal(
            completions[0]?.payload.state,
            ending === "interrupt" ? "interrupted" : "failed",
          );
          assert.equal(completions[0]?.payload.totalCostUsd, ending === "rate-limit" ? 0.6 : 0.4);
          assert.equal(harness.query.closeCalls, 1);
          yield* adapter.startSession({
            threadId: THREAD_ID,
            provider: "claudeAgent",
            runtimeMode: "full-access",
          });
          const next = yield* adapter.sendTurn({
            threadId: THREAD_ID,
            input: "retry",
            attachments: [],
          });
          // Buffered frames are actually read after close and rejected by the
          // stopped stream boundary before they can create a synthetic turn.
          if (ending === "rate-limit" || ending === "zeroed-error") {
            assert.ok(harness.query.deliveredAfterClose.length > 0);
          }
          emitClaudeSuccessResult(harness.queries[1]!, { uuid: "new-process-result" });
          const followup = yield* adapter.streamEvents.pipe(
            Stream.takeUntil((event) => event.type === "turn.completed"),
            Stream.runCollect,
          );
          assert.equal(followup.filter((event) => event.type === "turn.started").length, 1);
          assert.equal(
            followup.find((event) => event.type === "turn.completed")?.turnId,
            next.turnId,
          );
          assert.equal(
            followup.some((event) => event.type === "content.delta"),
            false,
          );
        }).pipe(Effect.provide(harness.layer));
      },
    );
  }

  it.effect("fails explicitly if agents drain but the runtime never confirms completion", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "explore", attachments: [] });
      const emit = (payload: Record<string, unknown>) =>
        harness.query.emit({
          uuid: crypto.randomUUID(),
          session_id: BACKGROUND_SESSION_ID,
          ...payload,
        } as unknown as SDKMessage);
      emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: "agent", task_type: "local_agent" }],
      });
      emit({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Waiting for agents",
        usage: { input_tokens: 3 },
        stop_reason: "end_turn",
      });
      emit({ type: "system", subtype: "background_tasks_changed", tasks: [] });
      emit({ type: "system", subtype: "status", status: "requesting", uuid: "drained-marker" });
      const pending = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) => (event.raw?.payload as { uuid?: string })?.uuid === "drained-marker",
        ),
        Stream.runCollect,
      );
      assert.equal(
        pending.some((event) => event.type === "turn.completed"),
        false,
      );
      const terminal = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "session.exited"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* TestClock.adjust("30 seconds");
      const events = yield* Fiber.join(terminal);
      const completed = events.find((event) => event.type === "turn.completed");
      assert.equal(completed?.payload.state, "failed");
      assert.equal(completed?.payload.stopReason, undefined);
      assert.deepEqual(completed?.payload.usage, { input_tokens: 3 });
      assert.match(completed?.payload.errorMessage ?? "", /did not confirm turn completion/);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("surfaces orphaned failures without inventing a completed turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      harness.query.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Runtime failed between prompts"],
        uuid: "orphan-error",
        session_id: BACKGROUND_SESSION_ID,
      } as unknown as SDKMessage);
      const events = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "session.exited"),
        Stream.runCollect,
      );
      assert.equal(events.filter((event) => event.type === "runtime.error").length, 1);
      assert.equal(
        events.some((event) => event.type === "turn.completed"),
        false,
      );
      assert.equal(harness.query.closeCalls, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  for (const notificationFirst of [true, false]) {
    it.effect(`closes background tools once with notification-first=${notificationFirst}`, () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });
        const turn = yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "run shell",
          attachments: [],
        });
        emitBashToolStart(harness.query, { toolUseId: "background-shell" });
        emitBackgroundToolResult(harness.query, {
          taskId: "shell-task",
          toolUseId: "background-shell",
        });
        const notification = () =>
          harness.query.emit({
            type: "system",
            subtype: "task_notification",
            task_id: "shell-task",
            status: "completed",
            uuid: "shell-done",
            session_id: BACKGROUND_SESSION_ID,
          } as unknown as SDKMessage);
        const patch = () =>
          emitClaudeTaskUpdated(harness.query, {
            taskId: "shell-task",
            patch: { status: "completed" },
          });
        if (notificationFirst) {
          notification();
          patch();
        } else {
          patch();
          notification();
        }
        harness.query.emit({
          type: "system",
          subtype: "status",
          status: "requesting",
          uuid: "tool-drained",
          session_id: BACKGROUND_SESSION_ID,
        } as unknown as SDKMessage);
        const events = yield* adapter.streamEvents.pipe(
          Stream.takeUntil(
            (event) => (event.raw?.payload as { uuid?: string })?.uuid === "tool-drained",
          ),
          Stream.runCollect,
        );
        const completed = events.filter(
          (event) => event.type === "item.completed" && event.itemId === "background-shell",
        );
        assert.equal(completed.length, 1);
        assert.equal(completed[0]?.turnId, turn.turnId);
        assert.equal(
          completed[0]?.type === "item.completed" ? completed[0].payload.status : undefined,
          "completed",
        );
      }).pipe(Effect.provide(harness.layer));
    });
  }

  it("matches missing-conversation errors only for the attempted session", () => {
    const attempted = "550e8400-e29b-41d4-a716-446655440000";
    assert.equal(
      isClaudeMissingConversationError(
        `No conversation found with session ID: ${attempted}`,
        attempted,
      ),
      true,
    );
    assert.equal(
      isClaudeMissingConversationError("claude: No such file or directory", attempted),
      false,
    );
    assert.equal(
      isClaudeMissingConversationError(
        "Session not found: 550e8400-e29b-41d4-a716-446655440001",
        attempted,
      ),
      false,
    );
  });

  it.effect("consumes Claude command lifecycle notifications silently", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const sessionId = "6e81554e-5cff-4b37-8a39-f3a9051ac234";

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const readyMessage = "command lifecycle test ready";
      const readyFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "runtime.warning" && event.payload.message === readyMessage,
      ).pipe(Stream.runDrain, Effect.forkChild);
      harness.query.emit({
        type: "system",
        subtype: "notification",
        key: "command-lifecycle-ready",
        text: readyMessage,
        priority: "high",
        session_id: sessionId,
        uuid: "command-lifecycle-ready",
      } as unknown as SDKMessage);
      yield* Fiber.join(readyFiber);

      const processedMessage = "command lifecycle messages processed";
      const runtimeEventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "runtime.warning" && event.payload.message === processedMessage,
      ).pipe(Stream.runCollect, Effect.forkChild);
      for (const [state, uuid] of [
        ["started", "command-started"],
        ["completed", "command-completed"],
      ]) {
        harness.query.emit({
          type: "command_lifecycle",
          command_uuid: "4cd8e8a3-df7a-425d-b6c9-4053abc0b8fd",
          state,
          session_id: sessionId,
          uuid,
        } as unknown as SDKMessage);
      }
      harness.query.emit({
        type: "system",
        subtype: "notification",
        key: "command-lifecycle-processed",
        text: processedMessage,
        priority: "high",
        session_id: sessionId,
        uuid: "command-lifecycle-processed",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        ["runtime.warning"],
      );
      const warning = runtimeEvents[0];
      assert.equal(warning?.type, "runtime.warning");
      if (warning?.type === "runtime.warning") {
        assert.equal(warning.payload.message, processedMessage);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("returns validation error for non-claude provider on startSession", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const result = yield* adapter
        .startSession({ threadId: THREAD_ID, provider: "codex", runtimeMode: "full-access" })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }
      assert.deepEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: "claudeAgent",
          operation: "startSession",
          issue: "Expected provider 'claudeAgent' but received 'codex'.",
        }),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses the instance environment for the primary streaming session", () => {
    const environment = {
      ...process.env,
      HOME: "/isolated-account",
      USERPROFILE: "/isolated-account",
      ANTHROPIC_API_KEY: "instance-key",
      ANTHROPIC_BASE_URL: "https://instance.example",
    };
    const harness = makeHarness({ processEnvironment: environment });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      const env = harness.getLastCreateQueryInput()?.options.env;
      assert.equal(env?.HOME, environment.HOME);
      assert.equal(env?.USERPROFILE, environment.USERPROFILE);
      assert.equal(env?.ANTHROPIC_API_KEY, environment.ANTHROPIC_API_KEY);
      assert.equal(env?.ANTHROPIC_BASE_URL, environment.ANTHROPIC_BASE_URL);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("derives bypass permission mode from full-access runtime policy", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.permissionMode, "bypassPermissions");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("auto-accepts edits while keeping shell commands gated", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "auto-accept-edits",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.permissionMode, "acceptEdits");
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) return;

      const editPermission = yield* Effect.promise(() =>
        canUseTool(
          "Edit",
          { file_path: "/tmp/example.ts", old_string: "old", new_string: "new" },
          {
            signal: new AbortController().signal,
            toolUseID: "tool-auto-edit-1",
            requestId: "request-auto-edit-1",
          },
        ),
      );
      assert.equal(editPermission?.behavior, "allow");

      const shellAbort = new AbortController();
      let shellResolved = false;
      const shellPermission = canUseTool(
        "Bash",
        { command: "pwd" },
        {
          signal: shellAbort.signal,
          toolUseID: "tool-auto-shell-1",
          requestId: "request-auto-shell-1",
        },
      ).then((result) => {
        shellResolved = true;
        return result;
      });
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
      assert.equal(shellResolved, false);
      shellAbort.abort();
      const shellResult = yield* Effect.promise(() => shellPermission);
      assert.equal(shellResult?.behavior, "deny");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps runtime policy authoritative over legacy provider permission options", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
        providerOptions: {
          claudeAgent: {
            permissionMode: "bypassPermissions",
          },
        },
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.permissionMode, "default");
      assert.equal(createInput?.options.env?.CLAUDE_CODE_ENABLE_TODO_TOOLS, "1");
      assert.equal(createInput?.options.env?.CLAUDE_CODE_ENABLE_TASKS, "0");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it("honors the operator task-tool override in every subagent environment branch", () => {
    for (const options of [undefined, { subagentModel: "inherit" }, { subagentModel: "fable-5" }]) {
      const env = buildClaudeQueryEnv(options, { CLAUDE_CODE_ENABLE_TASKS: "1" });
      assert.equal(env.CLAUDE_CODE_ENABLE_TASKS, "1");
      assert.equal(env.CLAUDE_CODE_ENABLE_TODO_TOOLS, "1");
      assert.equal(env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, "1");
    }
  });

  it.effect("removes an ambient subagent model override when inherit is configured", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const previousSubagentModel = process.env.CLAUDE_CODE_SUBAGENT_MODEL;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previousSubagentModel === undefined) {
            delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;
            return;
          }
          process.env.CLAUDE_CODE_SUBAGENT_MODEL = previousSubagentModel;
        }),
      );
      process.env.CLAUDE_CODE_SUBAGENT_MODEL = "claude-opus-4-6";

      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        providerOptions: {
          claudeAgent: {
            subagentModel: "inherit",
          },
        },
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.env?.CLAUDE_CODE_SUBAGENT_MODEL, undefined);
      assert.equal(createInput?.options.env?.CLAUDE_CODE_ENABLE_TODO_TOOLS, "1");
      assert.equal(createInput?.options.env?.CLAUDE_CODE_ENABLE_TASKS, "0");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("canonicalizes a concrete subagent model override in the Claude query env", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        providerOptions: {
          claudeAgent: {
            subagentModel: "opus-5[1m]",
          },
        },
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.env?.CLAUDE_CODE_SUBAGENT_MODEL, "claude-opus-5");
      assert.equal(createInput?.options.env?.CLAUDE_CODE_ENABLE_TODO_TOOLS, "1");
      assert.equal(createInput?.options.env?.CLAUDE_CODE_ENABLE_TASKS, "0");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("records unattended questions from the mandatory hook before native approval", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const events: ProviderRuntimeEvent[] = [];
      const listener = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        workflowExecutionProfile: "unattended-readonly",
      });
      const hook = harness.getLastCreateQueryInput()!.options.hooks!.PreToolUse!.at(-1)!.hooks[0]!;
      const response = yield* Effect.promise(() =>
        hook(
          {
            hook_event_name: "PreToolUse",
            session_id: "native",
            cwd: "/tmp",
            transcript_path: "/tmp/transcript",
            tool_name: "AskUserQuestion",
            tool_input: { questions: [{ question: "Pick?", options: [] }] },
            tool_use_id: "unattended-hook",
          },
          undefined,
          { signal: new AbortController().signal },
        ),
      );
      assert.ok("hookSpecificOutput" in response);
      assert.equal(response.hookSpecificOutput?.hookEventName, "PreToolUse");
      yield* Effect.promise(() =>
        vi.waitFor(() => assert.ok(events.some((event) => event.type === "user-input.resolved"))),
      );
      assert.ok(events.some((event) => event.type === "user-input.requested"));
      yield* Effect.promise(() =>
        hook(
          {
            hook_event_name: "PreToolUse",
            session_id: "native",
            cwd: "/tmp",
            transcript_path: "/tmp/transcript",
            tool_name: "Write",
            tool_input: { file_path: "/tmp/file", content: "blocked" },
            tool_use_id: "workflow-write-hook",
          },
          undefined,
          { signal: new AbortController().signal },
        ),
      );
      yield* Effect.promise(() =>
        vi.waitFor(() =>
          assert.ok(
            events.some(
              (event) => event.type === "request.resolved" && event.payload.decision === "decline",
            ),
          ),
        ),
      );
      assert.ok(events.some((event) => event.type === "request.opened"));
      yield* Fiber.interrupt(listener);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not inject a transcript contract into legacy sessions by default", () => {
    const harness = makeHarness({ processEnvironment: {} });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        resumeCursor: { resume: "550e8400-e29b-41d4-a716-446655440000" },
      });
      yield* adapter.sendTurn({ threadId: RESUME_THREAD_ID, input: "hello" });
      const prompt = (yield* Effect.promise(() =>
        harness.getLastCreateQueryInput()!.prompt[Symbol.asyncIterator]().next(),
      )).value!;
      assert.equal(JSON.stringify(prompt.message.content).includes("session update"), false);
      assert.ok(harness.getLastCreateQueryInput()!.options.systemPrompt);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("denies subagent tool use when project settings disable subagents", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        providerOptions: {
          claudeAgent: {
            subagentsEnabled: false,
          },
        },
      });

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      assert.deepEqual(createInput?.options.disallowedTools, ["Agent", "Task"]);
      assert.ok(createInput?.options.hooks?.PreToolUse?.length);
      const agentPermission = yield* Effect.promise(() =>
        canUseTool(
          "Agent",
          {
            prompt: "Inspect the repo and summarize the architecture.",
          },
          {
            signal: new AbortController().signal,
            toolUseID: "tool-disabled-agent-1",
            requestId: "request-disabled-agent-1",
          },
        ),
      );
      assert.equal((agentPermission as PermissionResult).behavior, "deny");
      assert.equal(
        (agentPermission as PermissionResult & { message?: string }).message?.includes(
          "Sub-agents are disabled",
        ),
        true,
      );

      const grepPermission = yield* Effect.promise(() =>
        canUseTool(
          "Grep",
          {
            pattern: "subagent",
            path: "src",
          },
          {
            signal: new AbortController().signal,
            toolUseID: "tool-disabled-agent-grep-1",
            requestId: "request-disabled-agent-grep-1",
          },
        ),
      );
      assert.equal((grepPermission as PermissionResult).behavior, "allow");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  for (const fastMode of [undefined, false, true]) {
    it.effect(`applies summary Ultrathink and inherits unset Claude fastMode=${fastMode}`, () => {
      const harness = makeHarness({ oneOffProviderOptions: { binaryPath: process.execPath } });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const fiber = yield* adapter.runOneOffPrompt!({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          prompt: "Summarize",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("claude-work"),
            "claude-opus-5",
            [
              { id: "effort", value: "ultrathink" },
              ...(fastMode !== undefined ? [{ id: "fastMode", value: fastMode }] : []),
            ],
          ),
        }).pipe(Effect.forkChild);
        yield* Effect.promise(() => vi.waitFor(() => assert.ok(harness.getLastCreateQueryInput())));
        const request = harness.getLastCreateQueryInput();
        assert.ok(request);
        const messages = yield* Effect.promise(async () => {
          const result: SDKUserMessage[] = [];
          for await (const message of request.prompt) result.push(message);
          return result;
        });
        assert.deepEqual(messages[0]?.message.content, [
          { type: "text", text: "Ultrathink:\nSummarize" },
        ]);
        assert.equal(request.options.effort, undefined);
        assert.deepEqual(request.options.settings, {
          cleanupPeriodDays: 3650,
          ...(fastMode ? { fastMode: true } : {}),
        });
        assert.equal(Object.hasOwn(request.options, "settings"), true);
        harness.query.emit({
          type: "assistant",
          message: { content: [{ type: "text", text: "notes" }] },
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "result",
          subtype: "success",
          result: "notes",
        } as unknown as SDKMessage);
        yield* Fiber.join(fiber);
      }).pipe(Effect.provide(harness.layer));
    });
  }
  it.effect("uses independent summary selection and instance configuration", () => {
    const harness = makeHarness({
      oneOffProviderOptions: {
        binaryPath: process.execPath,
        launchArgs: {
          verbose: null,
          model: "claude-opus-4-6",
          effort: "high",
          "fallback-model": "claude-opus-4-6",
          "--model": "claude-opus-4-6",
          "--effort": "max",
          "--fallback-model": "claude-opus-4-6",
        },
      },
      processEnvironment: {
        ...process.env,
        HOME: "/summary-account",
        SUMMARY_ACCOUNT_TEST: "selected",
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const fiber = yield* adapter.runOneOffPrompt!({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        prompt: "Summarize",
        model: "claude-opus-4-6",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claude-work"),
          "claude-sonnet-4-6",
          [
            { id: "effort", value: "low" },
            { id: "thinking", value: false },
          ],
        ),
      }).pipe(Effect.forkChild);
      yield* Effect.promise(() => vi.waitFor(() => assert.ok(harness.getLastCreateQueryInput())));
      const queryOptions = harness.getLastCreateQueryInput()?.options;
      assert.equal(queryOptions?.model, "claude-sonnet-4-6");
      assert.equal(queryOptions?.effort, "low");
      assert.deepEqual(queryOptions?.settings, { cleanupPeriodDays: 3650 });
      assert.equal(queryOptions?.pathToClaudeCodeExecutable, process.execPath);
      assert.equal(queryOptions?.env?.HOME, "/summary-account");
      assert.equal(queryOptions?.env?.SUMMARY_ACCOUNT_TEST, "selected");
      assert.deepEqual(queryOptions?.extraArgs, { verbose: null });
      harness.query.emit({
        type: "assistant",
        message: { content: [{ type: "text", text: "notes" }] },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        result: "notes",
      } as unknown as SDKMessage);
      assert.deepEqual(yield* Fiber.join(fiber), { text: "notes" });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("uses the configured Claude binary for one-off compaction queries", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const compactFiber = yield* adapter
        .compactConversation({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          prompt: "Summarize this thread",
          providerOptions: {
            claudeAgent: {
              binaryPath: process.execPath,
            },
          },
        })
        .pipe(Effect.forkChild);

      yield* Effect.promise(() => vi.waitFor(() => assert.ok(harness.getLastCreateQueryInput())));
      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.pathToClaudeCodeExecutable, process.execPath);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-1",
        uuid: "assistant-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-1",
          content: [{ type: "text", text: "<summary>Compacted summary</summary>" }],
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-1",
        total_cost_usd: 0,
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
          server_tool_use: {
            web_search_requests: 0,
          },
          service_tier: "standard",
        },
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: "done",
      } as unknown as SDKMessage);

      const result = yield* Fiber.join(compactFiber);
      assert.equal(result.summary, "<summary>Compacted summary</summary>");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "forwards launchArgs, permissionMode, and legacy maxThinkingTokens as typed thinking for one-off prompt queries",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const promptFiber = yield* adapter.runOneOffPrompt!({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          prompt: "Reply with OK",
          providerOptions: {
            claudeAgent: {
              binaryPath: process.execPath,
              permissionMode: "bypassPermissions",
              maxThinkingTokens: 321,
              launchArgs: {
                "--verbose": null,
                resume: "skip-me",
              },
            },
          },
        }).pipe(Effect.forkChild);

        yield* Effect.promise(() => vi.waitFor(() => assert.ok(harness.getLastCreateQueryInput())));
        const createInput = harness.getLastCreateQueryInput();
        const queryOptions = createInput?.options as
          | (ClaudeQueryOptionsForTest & {
              readonly allowDangerouslySkipPermissions?: boolean;
              readonly extraArgs?: Record<string, string | null>;
            })
          | undefined;

        assert.equal(queryOptions?.pathToClaudeCodeExecutable, process.execPath);
        assert.equal(queryOptions?.permissionMode, "bypassPermissions");
        assert.equal(queryOptions?.allowDangerouslySkipPermissions, undefined);
        // Unknown model: the deprecated input maps to a fixed budget, never sent as-is.
        assert.equal(queryOptions?.maxThinkingTokens, undefined);
        assert.deepEqual(queryOptions?.thinking, { type: "enabled", budgetTokens: 321 });
        assert.deepEqual(queryOptions?.extraArgs, {
          "--verbose": null,
        });

        harness.query.emit({
          type: "assistant",
          session_id: "sdk-session-1",
          uuid: "assistant-1",
          parent_tool_use_id: null,
          message: {
            id: "assistant-message-1",
            content: [{ type: "text", text: "OK" }],
          },
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-1",
          total_cost_usd: 0,
          usage: {
            input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 0,
            server_tool_use: {
              web_search_requests: 0,
            },
            service_tier: "standard",
          },
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          result: "done",
        } as unknown as SDKMessage);

        const result = yield* Fiber.join(promptFiber);
        assert.equal(result.text, "OK");
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("forwards claude effort levels into query options", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        runtimeMode: "full-access",
        modelOptions: {
          claudeAgent: {
            effort: "max",
          },
        },
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "max");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards Claude Fable 5 default high effort into query options", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-fable-5",
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "high");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("starts canonical Opus 5 sessions with high effort, Fast Mode, and a bare id", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "opus-5[1m]",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-5[1m]",
          [
            { id: "contextWindow", value: "1m" },
            { id: "fastMode", value: true },
          ],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(session.model, "claude-opus-5");
      assert.equal(createInput?.options.model, "claude-opus-5");
      assert.equal(createInput?.options.effort, "high");
      assert.deepEqual(createInput?.options.settings, { cleanupPeriodDays: 3650, fastMode: true });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps legacy maxThinkingTokens to adaptive thinking on adaptive models", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const configuredFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "session.configured",
      ).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-opus-5",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-5",
        ),
        providerOptions: { claudeAgent: { maxThinkingTokens: 2048 } },
        runtimeMode: "full-access",
      });
      const options = harness.getLastCreateQueryInput()?.options;
      assert.deepEqual(options?.thinking, { type: "adaptive" });
      assert.equal(options?.maxThinkingTokens, undefined);
      const [configured] = Array.from(yield* Fiber.join(configuredFiber));
      const config =
        configured?.type === "session.configured" ? configured.payload.config : undefined;
      assert.deepEqual(config?.thinking, { type: "adaptive" });
      assert.equal(config?.thinkingSource, "legacy");
      assert.match(String(config?.thinkingFallback), /ignore fixed budgets/);
      assert.equal(config?.maxThinkingTokens, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("prefers typed thinking over legacy maxThinkingTokens", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-opus-5",
        providerOptions: {
          claudeAgent: { maxThinkingTokens: 0, thinking: { type: "adaptive", display: "omitted" } },
        },
        runtimeMode: "full-access",
      });
      assert.deepEqual(harness.getLastCreateQueryInput()?.options.thinking, {
        type: "adaptive",
        display: "omitted",
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps the per-turn toggle and launch thinking consistent", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-haiku-4-5",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-haiku-4-5",
          [{ id: "thinking", value: false }],
        ),
        providerOptions: { claudeAgent: { maxThinkingTokens: 4096 } },
        runtimeMode: "full-access",
      });
      const options = harness.getLastCreateQueryInput()?.options;
      assert.deepEqual(options?.thinking, { type: "disabled" });
      assert.equal(
        (options?.settings as { alwaysThinkingEnabled?: boolean } | undefined)
          ?.alwaysThinkingEnabled,
        false,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("rejects explicit adaptive thinking on a model without adaptive support", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const error = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          model: "claude-haiku-4-5",
          providerOptions: { claudeAgent: { thinking: { type: "adaptive" } } },
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip);
      assert.match(
        String((error as { issue?: string }).issue),
        /Adaptive thinking is not supported/,
      );
      assert.equal(harness.getLastCreateQueryInput(), undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses Claude Code 1M model suffix on session start", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 3).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-fable-5",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-fable-5",
          [{ id: "contextWindow", value: "1m" }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.model, "claude-fable-5[1m]");

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const configured = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "session.configured" }> =>
          event.type === "session.configured",
      );
      assert.equal(configured?.payload.config.model, "claude-fable-5");
      assert.equal(configured?.payload.config.context_window, "1m");
      assert.equal(configured?.payload.config.modelContextWindowTokens, 1_000_000);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses the plain Claude model id for explicit 200k context window", () => {
    const harness = makeHarness();
    harness.query.setSupportedModelsResult([
      {
        value: "claude-fable-5",
        capabilities: {
          max_input_tokens: 1_000_000,
        },
      },
    ]);

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 3).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-fable-5",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-fable-5",
          [{ id: "contextWindow", value: "200k" }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.model, "claude-fable-5");

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const configured = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "session.configured" }> =>
          event.type === "session.configured",
      );
      assert.equal(configured?.payload.config.context_window, "200k");
      assert.equal(configured?.payload.config.modelContextWindowTokens, 200_000);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("defaults context-window capable Claude sessions to 200k", () => {
    const harness = makeHarness();
    harness.query.setSupportedModelsResult([
      {
        value: "claude-fable-5",
        capabilities: {
          max_input_tokens: 1_000_000,
        },
      },
    ]);

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 3).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-fable-5",
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.model, "claude-fable-5");

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const configured = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "session.configured" }> =>
          event.type === "session.configured",
      );
      assert.equal(configured?.payload.config.context_window, "200k");
      assert.equal(configured?.payload.config.modelContextWindowTokens, 200_000);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards xhigh effort for Claude Opus 4.7", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-opus-4-7",
        runtimeMode: "full-access",
        modelOptions: {
          claudeAgent: {
            effort: "xhigh",
          },
        },
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "xhigh");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  for (const submissionSource of ["human", "automation", undefined] as const) {
    it.effect(`stamps server-controlled provenance: ${submissionSource}`, () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "hello",
          ...(submissionSource ? { submissionSource } : {}),
        });
        const prompt = yield* Effect.promise(() =>
          harness.getLastCreateQueryInput()!.prompt[Symbol.asyncIterator]().next(),
        );
        assert.deepEqual(
          prompt.value?.origin,
          submissionSource === "human" ? { kind: "human" } : undefined,
        );
        assert.equal(typeof prompt.value?.uuid, "string");
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });
  }
  it.effect(
    "migrates an opted-in legacy resumed host contract once, acknowledging its native UUID",
    () => {
      const harness = makeHarness({
        processEnvironment: { ...process.env, F5_CLAUDE_LEGACY_HOST_CONTRACT_UPDATE: "1" },
      });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const resume = "550e8400-e29b-41d4-a716-446655440000";
        yield* adapter.startSession({
          threadId: RESUME_THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
          resumeCursor: { resume },
          priorWorkSummary: "Retained fact: sentinel-321",
        });
        const turn = yield* adapter.sendTurn({
          threadId: RESUME_THREAD_ID,
          input: "continue",
          submissionSource: "human",
        });
        const iterator = harness.getLastCreateQueryInput()!.prompt[Symbol.asyncIterator]();
        const prompt = (yield* Effect.promise(() => iterator.next())).value!;
        assert.deepEqual(prompt.origin, { kind: "human" });
        const text = JSON.stringify(prompt.message.content);
        assert.ok(text.includes("# F5 host contract (session update)"));
        assert.ok(text.includes("sentinel-321"));
        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: resume,
          user_message_uuid: prompt.uuid,
          total_cost_usd: 0,
          usage: {},
          result: "done",
        } as unknown as SDKMessage);
        yield* Effect.promise(() =>
          vi.waitFor(async () => {
            const sessions = await Effect.runPromise(adapter.listSessions());
            assert.equal(sessions[0]?.activeTurnId, undefined);
            assert.equal(
              (sessions[0]?.resumeCursor as { hostContractVersion?: string }).hostContractVersion,
              "r0-legacy-update-1",
            );
          }),
        );
        assert.ok(turn.turnId);
        yield* adapter.sendTurn({
          threadId: RESUME_THREAD_ID,
          input: "again",
          submissionSource: "human",
        });
        const next = (yield* Effect.promise(() => iterator.next())).value!;
        assert.equal(JSON.stringify(next.message.content).includes("session update"), false);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("warns only for actionable SDK notices and clears persisted reset boundaries", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const events: ProviderRuntimeEvent[] = [];
      const listener = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ).pipe(Effect.forkChild);
      const resume = "550e8400-e29b-41d4-a716-446655440000";
      yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        resumeCursor: {
          resume,
          resumeSessionAt: "old-assistant",
          turnBoundaries: [{ turnId: "old", assistantUuid: "old-assistant" }],
          approximateConversationChars: 900,
          compactionRecommendationEmitted: true,
        },
      });
      for (const notice of [
        {
          type: "system",
          subtype: "permission_denied",
          tool_name: "Write",
          message: "Policy restriction",
          decision_reason_type: "hook",
          tool_use_id: "denied-1",
          agent_id: "agent-1",
        },
        { type: "system", subtype: "informational", level: "notice", content: "Notice" },
        { type: "system", subtype: "model_refusal_no_fallback", content: "Refused" },
        { type: "system", subtype: "informational", level: "info", content: "Quiet" },
        { type: "system", subtype: "future_notice" },
        { type: "system", subtype: "worker_shutting_down" },
        { type: "conversation_reset", new_conversation_id: "view-id" },
      ])
        harness.query.emit({
          ...notice,
          session_id: resume,
          uuid: "notice-id",
        } as unknown as SDKMessage);
      yield* Effect.promise(() =>
        vi.waitFor(() => assert.ok(events.some((event) => event.type === "thread.state.changed"))),
      );
      assert.deepEqual(
        events
          .filter((event) => event.type === "runtime.warning")
          .map((event) => event.payload.message),
        ["Write was denied: Policy restriction", "Notice", "Refused"],
      );
      const cursor = (yield* adapter.listSessions())[0]!.resumeCursor as {
        resume: string;
        resumeSessionAt?: string;
        turnBoundaries: unknown[];
        approximateConversationChars: number;
        compactionRecommendationEmitted: boolean;
      };
      assert.equal(cursor.resume, resume);
      assert.equal(cursor.resumeSessionAt, undefined);
      assert.deepEqual(cursor.turnBoundaries, []);
      assert.equal(cursor.approximateConversationChars, 0);
      assert.equal(cursor.compactionRecommendationEmitted, false);
      yield* Fiber.interrupt(listener);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  for (const attribution of ["uuid", "origin", "resume"] as const) {
    it.effect(`fences unrelated native output and costs (${attribution})`, () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const events: ProviderRuntimeEvent[] = [];
        const listener = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ).pipe(Effect.forkChild);
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });
        const turn = yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "human",
          submissionSource: "human",
        });
        const prompt = (yield* Effect.promise(() =>
          harness.getLastCreateQueryInput()!.prompt[Symbol.asyncIterator]().next(),
        )).value!;
        if (attribution !== "origin") {
          harness.query.emit({
            type: "stream_event",
            session_id: "native-session",
            uuid: "foreign-stream",
            parent_tool_use_id: null,
            ...(attribution === "uuid"
              ? { user_message_uuid: "unrelated-user" }
              : { resume_reason: "interrupted_turn" }),
            event: {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "FOREIGN_OUTPUT_STREAM" },
            },
          } as unknown as SDKMessage);
          harness.query.emit({
            type: "assistant",
            session_id: "native-session",
            uuid: "unrelated-assistant",
            parent_tool_use_id: null,
            ...(attribution === "uuid"
              ? { user_message_uuid: "unrelated-user" }
              : { resume_reason: "interrupted_turn" }),
            message: { content: [{ type: "text", text: "FOREIGN_OUTPUT" }] },
          } as unknown as SDKMessage);
          harness.query.emit({
            type: "assistant",
            session_id: "native-session",
            uuid: "unstamped-foreign",
            parent_tool_use_id: null,
            message: { content: [{ type: "text", text: "FOREIGN_OUTPUT_2" }] },
          } as unknown as SDKMessage);
        }
        harness.query.emit({
          type: "result",
          subtype: "success",
          uuid: "unrelated-result",
          session_id: "native-session",
          ...(attribution === "uuid"
            ? { user_message_uuid: "unrelated-user" }
            : attribution === "origin"
              ? { origin: { kind: "task-notification" } }
              : { resume_reason: "interrupted_turn" }),
          is_error: false,
          total_cost_usd: 8,
          usage: {},
        } as unknown as SDKMessage);
        // Ordered barrier after the unrelated frame ensures its handler ran.
        harness.query.emit({
          type: "system",
          subtype: "informational",
          level: "notice",
          content: "barrier",
          uuid: "barrier",
          session_id: "native-session",
        } as unknown as SDKMessage);
        yield* Effect.promise(() =>
          vi.waitFor(() =>
            assert.ok(
              events.some(
                (event) => event.type === "runtime.warning" && event.payload.message === "barrier",
              ),
            ),
          ),
        );
        assert.equal((yield* adapter.listSessions())[0]!.activeTurnId, turn.turnId);
        assert.equal(
          events.some((event) => event.type === "turn.completed"),
          false,
        );
        assert.equal(JSON.stringify(events).includes("FOREIGN_OUTPUT"), false);
        assert.notEqual(
          ((yield* adapter.listSessions())[0]!.resumeCursor as { resumeSessionAt?: string })
            .resumeSessionAt,
          "unrelated-assistant",
        );
        harness.query.emit({
          type: "assistant",
          session_id: "native-session",
          uuid: "owned-assistant",
          parent_tool_use_id: null,
          user_message_uuid: prompt.uuid,
          message: { content: [{ type: "text", text: "OWNED_OUTPUT" }] },
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "result",
          subtype: "success",
          uuid: "owned-result",
          session_id: "native-session",
          user_message_uuid: prompt.uuid,
          is_error: false,
          total_cost_usd: 9,
          usage: {},
          result: "done",
        } as unknown as SDKMessage);
        yield* Effect.promise(() =>
          vi.waitFor(() => assert.ok(events.some((event) => event.type === "turn.completed"))),
        );
        const completed = events.find((event) => event.type === "turn.completed");
        assert.equal(completed?.payload.totalCostUsd, 1);
        yield* Fiber.interrupt(listener);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });
  }

  it.effect(
    "applies transcript retention at natural start without restarting on an env change",
    () => {
      const environment = { ...process.env, F5_CLAUDE_CLEANUP_PERIOD_DAYS: "4200" };
      const harness = makeHarness({ processEnvironment: environment });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });
        assert.equal(
          (harness.getLastCreateQueryInput()!.options.settings as { cleanupPeriodDays: number })
            .cleanupPeriodDays,
          4200,
        );
        environment.F5_CLAUDE_CLEANUP_PERIOD_DAYS = "7300";
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "continue" });
        assert.equal(harness.getCreateQueryInputs().length, 1);
        assert.equal(
          (harness.getLastCreateQueryInput()!.options.settings as { cleanupPeriodDays: number })
            .cleanupPeriodDays,
          4200,
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );
  it.effect("appends the shared assistant contract to the Claude Code preset prompt", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const currentDate = new Date().toISOString().slice(0, 10);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        cwd: "/tmp/claude-project",
        projectTitle: "Claude Project",
        threadTitle: "Phase 1 port",
        turnCount: 2,
        model: "claude-opus-4-6",
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      const systemPrompt = (
        createInput?.options as ClaudeQueryOptions & {
          readonly systemPrompt?: unknown;
        }
      )?.systemPrompt;
      assert.deepEqual(systemPrompt, {
        type: "preset",
        preset: "claude_code",
        snapshot: false,
        append: buildClaudeAssistantInstructions({
          cwd: "/tmp/claude-project",
          projectTitle: "Claude Project",
          threadTitle: "Phase 1 port",
          model: "claude-opus-4-6",
          effort: "high",
          runtimeMode: "full-access",
          currentDate,
        }),
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("passes plan interaction mode into the appended assistant contract", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        interactionMode: "plan",
        runtimeMode: "full-access",
      });

      const createQueryInput = harness.getLastCreateQueryInput();
      assert.ok(createQueryInput);
      const append = (
        createQueryInput.options as ClaudeQueryOptions & {
          readonly systemPrompt?: { readonly append?: string };
        }
      ).systemPrompt?.append;
      assert.equal(append?.includes("# Plan Mode (Conversational)"), true);
      assert.equal(append?.includes("# Collaboration Mode: Default"), false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("enforces unattended workflow tools synchronously without approval waits", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        interactionMode: "plan",
        workflowExecutionProfile: "unattended-readonly",
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.permissionMode, "plan");
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) return;
      const options = {
        signal: new AbortController().signal,
        toolUseID: "workflow-tool",
        requestId: "workflow-request",
      };
      const read = yield* Effect.promise(() =>
        canUseTool("Read", { file_path: "src/a.ts" }, options),
      );
      const shellProbes = yield* Effect.all(
        [
          "rg -n workflow src",
          "cat README.md & touch pwned",
          "git status & rm -rf ./src",
          "cat `touch pwned`",
        ].map((command) => Effect.promise(() => canUseTool("Bash", { command }, options))),
      );
      const misleadingMcp = yield* Effect.promise(() =>
        canUseTool("mcp__example__search_and_delete", { path: "src" }, options),
      );
      const webSearch = yield* Effect.promise(() =>
        canUseTool("WebSearch", { query: "secret" }, options),
      );
      const question = yield* Effect.promise(() =>
        canUseTool("AskUserQuestion", { questions: [] }, options),
      );
      assert.equal(read?.behavior, "allow");
      assert.equal(
        shellProbes.every((result) => result?.behavior === "deny"),
        true,
      );
      assert.equal(misleadingMcp?.behavior, "deny");
      assert.equal(webSearch?.behavior, "deny");
      assert.equal(question?.behavior, "deny");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("emits instruction profile metadata on the adapter session.configured event", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 3).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const configured = runtimeEvents.find((event) => event.type === "session.configured");
      assert.equal(configured?.type, "session.configured");
      if (configured?.type !== "session.configured") {
        return;
      }

      assert.deepEqual(
        (configured.payload.config as Record<string, unknown>).instructionProfile,
        buildInstructionProfile({
          provider: "claudeAgent",
        }),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("refreshes context window metadata from Claude supported-model results", () => {
    const harness = makeHarness();
    harness.query.setSupportedModelsResult([
      {
        value: "claude-opus-4-5",
        capabilities: {
          max_input_tokens: 1_234_567,
        },
      },
    ]);

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 4).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        model: "claude-opus-4-5",
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const configuredEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "session.configured" }> =>
          event.type === "session.configured",
      );

      assert.equal(configuredEvents.length, 2);
      assert.equal(
        (configuredEvents[0]!.payload.config as Record<string, unknown>).modelContextWindowTokens,
        1_000_000,
      );
      assert.equal(
        (configuredEvents[1]!.payload.config as Record<string, unknown>).modelContextWindowTokens,
        1_234_567,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "refreshes context window metadata from the Anthropic models API when credentials are available",
    () => {
      const harness = makeHarness({
        processEnvironment: {
          ...process.env,
          ANTHROPIC_API_KEY: "instance-api-key",
          ANTHROPIC_AUTH_TOKEN: "",
          ANTHROPIC_BASE_URL: "https://instance.example",
        },
      });
      const originalApiKey = process.env.ANTHROPIC_API_KEY;
      const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
      const originalFetch = globalThis.fetch;
      clearAnthropicModelContextWindowCatalogCacheForTest();
      process.env.ANTHROPIC_API_KEY = "test-api-key";
      process.env.ANTHROPIC_BASE_URL = "https://anthropic.example";
      globalThis.fetch = (async (url, init) => {
        assert.equal(String(url).startsWith("https://instance.example/"), true);
        assert.equal(new Headers(init?.headers).get("x-api-key"), "instance-api-key");
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "claude-opus-4-5",
                max_input_tokens: 1_111_000,
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      }) as typeof fetch;

      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 4).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        try {
          yield* adapter.startSession({
            threadId: THREAD_ID,
            provider: "claudeAgent",
            runtimeMode: "full-access",
            model: "claude-opus-4-5",
          });

          const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
          const configuredEvents = runtimeEvents.filter(
            (event): event is Extract<ProviderRuntimeEvent, { type: "session.configured" }> =>
              event.type === "session.configured",
          );

          assert.equal(configuredEvents.length, 2);
          assert.equal(
            (configuredEvents[0]!.payload.config as Record<string, unknown>)
              .modelContextWindowTokens,
            1_000_000,
          );
          assert.equal(
            (configuredEvents[1]!.payload.config as Record<string, unknown>)
              .modelContextWindowTokens,
            1_111_000,
          );
        } finally {
          runtimeEventsFiber.interruptUnsafe();
          clearAnthropicModelContextWindowCatalogCacheForTest();
          globalThis.fetch = originalFetch;
          if (originalApiKey === undefined) {
            delete process.env.ANTHROPIC_API_KEY;
          } else {
            process.env.ANTHROPIC_API_KEY = originalApiKey;
          }
          if (originalBaseUrl === undefined) {
            delete process.env.ANTHROPIC_BASE_URL;
          } else {
            process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
          }
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("omits slashCommands until supportedCommands has been loaded", () => {
    const harness = makeHarness();
    harness.query.setSupportedCommandsResult([
      {
        name: "review",
        description: "Review the current diff",
        argumentHint: "<target>",
      },
    ]);
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 4).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const configuredEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "session.configured" }> =>
          event.type === "session.configured",
      );

      assert.equal(configuredEvents.length, 2);
      assert.deepEqual(
        (configuredEvents[0]!.payload.config as Record<string, unknown>).slashCommands,
        undefined,
      );
      assert.deepEqual(
        (configuredEvents[1]!.payload.config as Record<string, unknown>).slashCommands,
        [
          {
            name: "review",
            description: "Review the current diff",
            argumentHint: "<target>",
          },
        ],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores unsupported max effort for Sonnet 4.6", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        runtimeMode: "full-access",
        modelOptions: {
          claudeAgent: {
            effort: "max",
          },
        },
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores unsupported xhigh effort for Claude Opus 4.6", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        runtimeMode: "full-access",
        modelOptions: {
          claudeAgent: {
            effort: "xhigh",
          },
        },
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores adaptive effort for Haiku 4.5", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-haiku-4-5",
        runtimeMode: "full-access",
        modelOptions: {
          claudeAgent: {
            effort: "high",
          },
        },
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards Claude thinking toggle into SDK settings for Haiku 4.5", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-haiku-4-5",
        runtimeMode: "full-access",
        modelOptions: {
          claudeAgent: {
            thinking: false,
          },
        },
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, {
        cleanupPeriodDays: 3650,
        alwaysThinkingEnabled: false,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores Claude thinking toggle for non-Haiku models", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        runtimeMode: "full-access",
        modelOptions: {
          claudeAgent: {
            thinking: false,
          },
        },
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, { cleanupPeriodDays: 3650 });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards Claude Opus 4.8 Fast Mode into SDK settings", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-opus-4-8",
        runtimeMode: "full-access",
        modelOptions: {
          claudeAgent: {
            fastMode: true,
          },
        },
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, {
        cleanupPeriodDays: 3650,
        fastMode: true,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores claude fast mode for Claude Opus 4.7", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-opus-4-7",
        runtimeMode: "full-access",
        modelOptions: {
          claudeAgent: {
            fastMode: true,
          },
        },
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, { cleanupPeriodDays: 3650 });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores claude fast mode for Claude Opus 4.6", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        runtimeMode: "full-access",
        modelOptions: {
          claudeAgent: {
            fastMode: true,
          },
        },
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, { cleanupPeriodDays: 3650 });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores claude fast mode for non-opus models", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        runtimeMode: "full-access",
        modelOptions: {
          claudeAgent: {
            fastMode: true,
          },
        },
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, { cleanupPeriodDays: 3650 });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("treats ultrathink as a prompt keyword instead of a session effort", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        runtimeMode: "full-access",
        modelOptions: {
          claudeAgent: {
            effort: "ultrathink",
          },
        },
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Investigate the edge cases",
        attachments: [],
        model: "claude-sonnet-4-6",
        modelOptions: {
          claudeAgent: {
            effort: "ultrathink",
          },
        },
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, undefined);
      const promptText = yield* Effect.promise(() => readFirstPromptText(createInput));
      assert.equal(
        promptText,
        [
          "<f5-runtime-context>",
          'Active model: "claude-sonnet-4-6"',
          "This host-reported value is authoritative for model identity.",
          "File edits: when you change workspace files, use Edit or Write rather than shell writes (sed -i, heredocs, inline scripts) so F5 can show reviewable diffs. Exceptions: codemods across many files, generated output, formatters or code generators, and /tmp scratch files.",
          "</f5-runtime-context>",
          "",
          "Ultrathink:",
          "Investigate the edge cases",
        ].join("\n"),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("omits the file-editing reminder while plan mode is active", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-opus-5",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan the rename",
        interactionMode: "plan",
        attachments: [],
        model: "claude-opus-5",
      });

      const turnCompletedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-plan-reminder",
        uuid: "result-plan-reminder",
      } as unknown as SDKMessage);
      yield* Fiber.join(turnCompletedFiber);

      // No interactionMode: the SDK stays in plan mode from the previous turn.
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "refine the plan",
        attachments: [],
        model: "claude-opus-5",
      });

      const iterator = harness.getLastCreateQueryInput()?.prompt[Symbol.asyncIterator]();
      assert.ok(iterator);
      const promptTexts: Array<string | undefined> = [];
      for (let index = 0; index < 2; index += 1) {
        const next = yield* Effect.promise(() => iterator.next());
        const content = next.done ? undefined : next.value.message.content[0];
        promptTexts.push(
          content && typeof content !== "string" && content.type === "text"
            ? content.text
            : undefined,
        );
      }

      assert.equal(promptTexts.length, 2);
      for (const promptText of promptTexts) {
        assert.ok(promptText?.includes("<f5-runtime-context>"));
        assert.equal(promptText?.includes("File edits:"), false);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("omits the file-editing reminder for read-only workflow stages", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-opus-5",
        interactionMode: "plan",
        workflowExecutionProfile: "unattended-readonly",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "review the plan",
        attachments: [],
        model: "claude-opus-5",
        workflowExecutionProfile: "unattended-readonly",
      });

      const promptText = yield* Effect.promise(() =>
        readFirstPromptText(harness.getLastCreateQueryInput()),
      );
      assert.ok(promptText?.includes("<f5-runtime-context>"));
      assert.equal(promptText?.includes("File edits:"), false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps Claude slash commands at the start of the prompt", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-opus-5",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "/compact",
        attachments: [],
        model: "claude-opus-5",
      });

      const promptText = yield* Effect.promise(() =>
        readFirstPromptText(harness.getLastCreateQueryInput()),
      );
      assert.equal(promptText, "/compact");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  for (const prompt of ["What's in this image?", "/review Describe this image"]) {
    it.effect(`places images before the final text block: ${prompt}`, () => {
      const stateDir = mkdtempSync(path.join(os.tmpdir(), "claude-attachments-"));
      const harness = makeHarness({
        cwd: "/tmp/project-claude-attachments",
        stateDir,
      });
      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() =>
            rmSync(stateDir, {
              recursive: true,
              force: true,
            }),
          ),
        );

        const adapter = yield* ClaudeAdapter;

        const attachment = {
          type: "image" as const,
          id: "thread-claude-attachment-12345678-1234-1234-1234-123456789abc",
          name: "diagram.png",
          mimeType: "image/png",
          sizeBytes: 4,
        };
        const attachmentPath = path.join(
          stateDir,
          "attachments",
          attachmentRelativePath(attachment),
        );
        mkdirSync(path.dirname(attachmentPath), { recursive: true });
        writeFileSync(attachmentPath, Uint8Array.from([1, 2, 3, 4]));

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: prompt,
          attachments: [attachment],
        });

        const createInput = harness.getLastCreateQueryInput();
        const promptMessage = yield* Effect.promise(() => readFirstPromptMessage(createInput));
        assert.isDefined(promptMessage);
        assert.deepEqual(promptMessage?.message.content, [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "AQIDBA==",
            },
          },
          {
            type: "text",
            text: prompt,
          },
        ]);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });
  }

  it.effect("maps Claude stream/runtime messages to canonical provider runtime events", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-sonnet-4-5",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-0",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Hi",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-3",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: {
              command: "ls",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-4",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-1",
        uuid: "assistant-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-1",
          content: [{ type: "text", text: "Hi" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-1",
        uuid: "result-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "item.started",
          "item.completed",
          "turn.completed",
        ],
      );

      const turnStarted = runtimeEvents[3];
      assert.equal(turnStarted?.type, "turn.started");
      if (turnStarted?.type === "turn.started") {
        assert.equal(String(turnStarted.turnId), String(turn.turnId));
      }

      const deltaEvent = runtimeEvents.find((event) => event.type === "content.delta");
      assert.equal(deltaEvent?.type, "content.delta");
      if (deltaEvent?.type === "content.delta") {
        assert.equal(deltaEvent.payload.delta, "Hi");
        assert.equal(String(deltaEvent.turnId), String(turn.turnId));
      }

      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "command_execution");
      }

      const assistantCompletedIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      const toolStartedIndex = runtimeEvents.findIndex((event) => event.type === "item.started");
      assert.equal(
        assistantCompletedIndex >= 0 &&
          toolStartedIndex >= 0 &&
          assistantCompletedIndex < toolStartedIndex,
        true,
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "completed");
        const resumeCursor = turnCompleted.resumeCursor as {
          threadId?: string;
          resume?: string;
          resumeSessionAt?: string;
          turnCount?: number;
          approximateConversationChars?: number;
          compactionRecommendationEmitted?: boolean;
        };
        assert.equal(resumeCursor.threadId, session.threadId);
        assert.equal(resumeCursor.resume, "sdk-session-1");
        assert.equal(resumeCursor.resumeSessionAt, "assistant-1");
        assert.equal(resumeCursor.turnCount, 1);
        assert.equal((resumeCursor.approximateConversationChars ?? 0) > 0, true);
        assert.equal(resumeCursor.compactionRecommendationEmitted, false);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps Claude reasoning deltas, streamed tool inputs, and tool results", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 11).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-thinking",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "thinking_delta",
            thinking: "Let",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-grep-1",
            name: "Grep",
            input: {},
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-input-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: '{"pattern":"foo","path":"src"}',
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-tool-streams",
        uuid: "user-tool-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-grep-1",
              content: "src/example.ts:1:foo",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-tool-streams",
        uuid: "result-tool-streams",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.started",
          "item.updated",
          "item.updated",
          "item.completed",
          "turn.completed",
        ],
      );

      const reasoningDelta = runtimeEvents.find(
        (event) => event.type === "content.delta" && event.payload.streamKind === "reasoning_text",
      );
      assert.equal(reasoningDelta?.type, "content.delta");
      if (reasoningDelta?.type === "content.delta") {
        assert.equal(reasoningDelta.payload.delta, "Let");
        assert.equal(String(reasoningDelta.turnId), String(turn.turnId));
      }

      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "dynamic_tool_call");
      }

      const toolInputUpdated = runtimeEvents.find(
        (event) =>
          event.type === "item.updated" &&
          (event.payload.data as { input?: { pattern?: string; path?: string } } | undefined)?.input
            ?.pattern === "foo",
      );
      assert.equal(toolInputUpdated?.type, "item.updated");
      if (toolInputUpdated?.type === "item.updated") {
        assert.deepEqual(toolInputUpdated.payload.data, {
          toolName: "Grep",
          input: {
            pattern: "foo",
            path: "src",
          },
        });
      }

      const toolResultUpdated = runtimeEvents.find(
        (event) =>
          event.type === "item.updated" &&
          (event.payload.data as { result?: { tool_use_id?: string } } | undefined)?.result
            ?.tool_use_id === "tool-grep-1",
      );
      assert.equal(toolResultUpdated?.type, "item.updated");
      if (toolResultUpdated?.type === "item.updated") {
        assert.equal(
          (
            toolResultUpdated.payload.data as {
              result?: { content?: string };
            }
          ).result?.content,
          "src/example.ts:1:foo",
        );
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("classifies Claude Task tool invocations as collaboration agent work", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "delegate this",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-task",
        uuid: "stream-task-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-task-1",
            name: "Task",
            input: {
              description: "Review the database layer",
              prompt: "Audit the SQL changes",
              subagent_type: "code-reviewer",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-task",
        uuid: "assistant-task-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-task-1",
          content: [{ type: "text", text: "Delegated" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-task",
        uuid: "result-task-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "collab_agent_tool_call");
        assert.equal(toolStarted.payload.title, "Code Reviewer agent");
        assert.deepEqual(toolStarted.payload.data, {
          toolName: "Task",
          input: {
            description: "Review the database layer",
            prompt: "Audit the SQL changes",
            subagent_type: "code-reviewer",
          },
          subagentType: "code-reviewer",
          subagentDescription: "Review the database layer",
          subagentPrompt: "Audit the SQL changes",
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("includes subagent results in completed lifecycle payloads", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = Effect.runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "delegate this",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-task-result",
        uuid: "stream-task-result-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-task-result-1",
            name: "Task",
            input: {
              description: "Review the migration",
              prompt: "Check locking risks and report back.",
              subagent_type: "code-reviewer",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-task-result",
        uuid: "user-task-result-1",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-task-result-1",
              content: "Found one lock-escalation risk in the backfill.",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-task-result",
        uuid: "result-task-result-1",
      } as unknown as SDKMessage);

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.sync(() => {
        runtimeEventsFiber.interruptUnsafe();
      });
      const completed = runtimeEvents.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "collab_agent_tool_call",
      );

      assert.equal(completed?.type, "item.completed");
      if (completed?.type === "item.completed") {
        assert.deepEqual(completed.payload.data, {
          toolName: "Task",
          input: {
            description: "Review the migration",
            prompt: "Check locking risks and report back.",
            subagent_type: "code-reviewer",
          },
          result: {
            type: "tool_result",
            tool_use_id: "tool-task-result-1",
            content: "Found one lock-escalation risk in the backfill.",
          },
          subagentType: "code-reviewer",
          subagentDescription: "Review the migration",
          subagentPrompt: "Check locking risks and report back.",
          subagentResult: "Found one lock-escalation risk in the backfill.",
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("classifies TodoWrite as a dynamic tool call instead of a file change", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "track progress",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-todowrite",
        uuid: "stream-todowrite-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-todo-1",
            name: "TodoWrite",
            input: {
              todos: [
                {
                  content: "Run tests",
                  activeForm: "Running tests",
                  status: "in_progress",
                },
              ],
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-todowrite",
        uuid: "result-todowrite",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "dynamic_tool_call");
        assert.equal(toolStarted.payload.detail, "TodoWrite: 1 task");
        assert.equal(
          (toolStarted.payload.data as { toolName?: string } | undefined)?.toolName,
          "TodoWrite",
        );
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("emits TodoWrite task input updates while Claude streams tool JSON", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "track progress",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-todowrite-stream",
        uuid: "stream-todowrite-json-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-todo-stream-1",
            name: "TodoWrite",
            input: {},
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-todowrite-stream",
        uuid: "stream-todowrite-json-delta",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json:
              '{"todos":[{"content":"Run tests","activeForm":"Running tests","status":"in_progress"}]}',
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-todowrite-stream",
        uuid: "result-todowrite-stream",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const todoUpdated = runtimeEvents.find(
        (event) =>
          event.type === "item.updated" &&
          (event.payload.data as { toolName?: string } | undefined)?.toolName === "TodoWrite",
      );
      assert.equal(todoUpdated?.type, "item.updated");
      if (todoUpdated?.type === "item.updated") {
        assert.deepEqual(todoUpdated.payload.data, {
          toolName: "TodoWrite",
          input: {
            todos: [
              {
                content: "Run tests",
                activeForm: "Running tests",
                status: "in_progress",
              },
            ],
          },
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("emits file-read requestKind and bare file path detail for Claude Read", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "read the file",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-read",
        uuid: "stream-read-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-read-1",
            name: "Read",
            input: {
              file_path: "apps/server/package.json",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-read",
        uuid: "result-read",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "dynamic_tool_call");
        assert.equal(toolStarted.payload.requestKind, "file-read");
        assert.equal(toolStarted.payload.detail, "apps/server/package.json");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("classifies Claude Read of an image as image_view, including streamed input", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.takeUntil(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runCollect, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "look at the screenshots",
        attachments: [],
      });

      const emitStream = (uuid: string, event: Record<string, unknown>) =>
        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-image-read",
          uuid,
          parent_tool_use_id: null,
          event,
        } as unknown as SDKMessage);

      emitStream("image-read-start", {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "tool-image-read-1",
          name: "Read",
          input: { file_path: "/repo/docs/Screenshot.PNG" },
        },
      });
      emitStream("image-read-streamed-start", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tool-image-read-2", name: "Read", input: {} },
      });
      emitStream("image-read-streamed-delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"file_path":"/repo/out/chart.webp"}' },
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-image-read",
        uuid: "result-image-read",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const started = runtimeEvents.find(
        (event) => event.type === "item.started" && event.itemId === "tool-image-read-1",
      );
      assert.equal(started?.type === "item.started" && started.payload.itemType, "image_view");
      assert.equal(
        started?.type === "item.started" && started.payload.detail,
        "/repo/docs/Screenshot.PNG",
      );

      const streamedStart = runtimeEvents.find(
        (event) => event.type === "item.started" && event.itemId === "tool-image-read-2",
      );
      assert.equal(
        streamedStart?.type === "item.started" && streamedStart.payload.itemType,
        "dynamic_tool_call",
      );
      const streamedUpdate = runtimeEvents.find(
        (event) => event.type === "item.updated" && event.itemId === "tool-image-read-2",
      );
      assert.equal(
        streamedUpdate?.type === "item.updated" && streamedUpdate.payload.itemType,
        "image_view",
      );
      assert.deepEqual(streamedUpdate?.type === "item.updated" && streamedUpdate.payload.data, {
        toolName: "Read",
        input: { file_path: "/repo/out/chart.webp" },
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "emits file-change requestKind and bare file path detail for Claude Edit/Write/MultiEdit/NotebookEdit",
    () => {
      const cases: ReadonlyArray<{
        readonly name: string;
        readonly input: Record<string, unknown>;
        readonly expectedDetail: string;
      }> = [
        {
          name: "Edit",
          input: {
            file_path: "apps/server/README.md",
            replace_all: false,
          },
          expectedDetail: "apps/server/README.md",
        },
        {
          name: "Write",
          input: {
            file_path: "apps/server/notes.txt",
            content: "hi",
          },
          expectedDetail: "apps/server/notes.txt",
        },
        {
          name: "MultiEdit",
          input: {
            file_path: "apps/server/a.ts",
            edits: [],
          },
          expectedDetail: "apps/server/a.ts",
        },
        {
          name: "NotebookEdit",
          input: {
            notebook_path: "/tmp/notebook.ipynb",
            new_source: "print('hi')",
          },
          expectedDetail: "/tmp/notebook.ipynb",
        },
      ];

      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 5 + cases.length).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "edit the files",
          attachments: [],
        });

        for (let i = 0; i < cases.length; i++) {
          const c = cases[i]!;
          harness.query.emit({
            type: "stream_event",
            session_id: "sdk-session-filechange",
            uuid: `stream-${c.name}-start`,
            parent_tool_use_id: null,
            event: {
              type: "content_block_start",
              index: i,
              content_block: {
                type: "tool_use",
                id: `tool-${c.name}-1`,
                name: c.name,
                input: c.input,
              },
            },
          } as unknown as SDKMessage);
        }

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-filechange",
          uuid: "result-filechange",
        } as unknown as SDKMessage);

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        const started = runtimeEvents.filter((event) => event.type === "item.started");
        assert.equal(started.length, cases.length);
        for (let i = 0; i < cases.length; i++) {
          const c = cases[i]!;
          const ev = started[i]!;
          if (ev.type === "item.started") {
            assert.equal(ev.payload.itemType, "file_change");
            assert.equal(ev.payload.requestKind, "file-change");
            assert.equal(ev.payload.detail, c.expectedDetail);
          }
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("emits turn.diff.updated after a Claude file-change completes", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "write the file",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-filechange-diff",
        uuid: "stream-write-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-write-1",
            name: "Write",
            input: {
              file_path: "apps/server/notes.txt",
              content: "hello\n",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-filechange-diff",
        uuid: "user-write-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-write-1",
              content: "Wrote apps/server/notes.txt",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-filechange-diff",
        uuid: "result-filechange-diff",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "item.started",
          "item.updated",
          "content.delta",
          "item.completed",
          "turn.diff.updated",
        ],
      );

      const turnStarted = runtimeEvents.find((event) => event.type === "turn.started");
      const diffUpdated = runtimeEvents.find((event) => event.type === "turn.diff.updated");
      assert.equal(turnStarted?.type, "turn.started");
      assert.equal(diffUpdated?.type, "turn.diff.updated");
      if (turnStarted?.type === "turn.started" && diffUpdated?.type === "turn.diff.updated") {
        assert.equal(diffUpdated.turnId, turnStarted.turnId);
        assert.equal(diffUpdated.payload.unifiedDiff, "");
      }

      // The tool result's item.updated and item.completed are emitted back to
      // back; under the frozen test clock they must still get strictly
      // increasing timestamps so their activities never tie on createdAt.
      const toolResultEvents = [
        ...runtimeEvents.filter(
          (event) =>
            (event.type === "item.updated" || event.type === "item.completed") &&
            event.itemId === "tool-write-1",
        ),
        ...runtimeEvents.filter((event) => event.type === "turn.diff.updated"),
      ];
      assert.deepEqual(
        toolResultEvents.map((event) => event.type),
        ["item.updated", "item.completed", "turn.diff.updated"],
      );
      const toolResultTimestamps = toolResultEvents.map((event) => event.createdAt);
      assert.deepEqual(
        [...toolResultTimestamps].toSorted(),
        toolResultTimestamps,
        "tool-result events must be stamped in emission order",
      );
      assert.equal(new Set(toolResultTimestamps).size, toolResultTimestamps.length);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("emits command requestKind and preserves Bash detail shape", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "run ls",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-bash",
        uuid: "stream-bash-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-bash-1",
            name: "Bash",
            input: {
              command: "ls",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-bash",
        uuid: "result-bash",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "command_execution");
        assert.equal(toolStarted.payload.requestKind, "command");
        assert.equal(toolStarted.payload.detail, "Bash: ls");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not emit requestKind for Grep/Glob/WebSearch/TodoWrite/MCP tool calls", () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly blockType?: "tool_use" | "mcp_tool_use" | "server_tool_use";
      readonly input: Record<string, unknown>;
      readonly expectedDetailContains: string;
    }> = [
      {
        name: "Grep",
        input: { pattern: "foo", path: "src" },
        expectedDetailContains: "Grep",
      },
      {
        name: "Glob",
        input: { pattern: "**/*.ts" },
        expectedDetailContains: "Glob",
      },
      {
        name: "WebSearch",
        blockType: "server_tool_use",
        input: { query: "hello world" },
        expectedDetailContains: "WebSearch",
      },
      {
        name: "TodoWrite",
        input: {
          todos: [{ content: "x", activeForm: "Xing", status: "pending" }],
        },
        expectedDetailContains: "TodoWrite",
      },
      {
        name: "mcp__filesystem__read_text_file",
        blockType: "mcp_tool_use",
        input: { path: "/repo/README.md" },
        expectedDetailContains: "mcp__filesystem__read_text_file",
      },
    ];

    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 5 + cases.length).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "run things",
        attachments: [],
      });

      for (let i = 0; i < cases.length; i++) {
        const c = cases[i]!;
        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-nokind",
          uuid: `stream-${c.name}-start`,
          parent_tool_use_id: null,
          event: {
            type: "content_block_start",
            index: i,
            content_block: {
              type: c.blockType ?? "tool_use",
              id: `tool-${c.name}-1`,
              name: c.name,
              input: c.input,
            },
          },
        } as unknown as SDKMessage);
      }

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-nokind",
        uuid: "result-nokind",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const started = runtimeEvents.filter((event) => event.type === "item.started");
      assert.equal(started.length, cases.length);
      for (let i = 0; i < cases.length; i++) {
        const c = cases[i]!;
        const ev = started[i]!;
        if (ev.type === "item.started") {
          assert.equal(ev.payload.requestKind, undefined);
          assert.equal(
            typeof ev.payload.detail === "string" &&
              ev.payload.detail.includes(c.expectedDetailContains),
            true,
          );
        }
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("preserves filesystem MCP calls as MCP tool calls", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "list available MCP servers",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-mcp-filesystem",
        uuid: "stream-mcp-filesystem-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "mcp_tool_use",
            id: "tool-mcp-filesystem-1",
            name: "mcp__filesystem__list_allowed_directories",
            input: {},
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-mcp-filesystem",
        uuid: "result-mcp-filesystem",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "mcp_tool_call");
        assert.equal(toolStarted.payload.title, "MCP tool call");
        assert.equal(toolStarted.payload.detail, "mcp__filesystem__list_allowed_directories: {}");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("treats user-aborted Claude results as interrupted without a runtime error", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: false,
        errors: ["Error: Request was aborted."],
        stop_reason: "tool_use",
        session_id: "sdk-session-abort",
        uuid: "result-abort",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "turn.completed",
        ],
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, "Error: Request was aborted.");
        assert.equal(turnCompleted.payload.stopReason, "tool_use");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  for (const scenario of [
    "blocked",
    "recovered",
    "login",
    "interrupted",
    "unrelated",
    "multiple",
    "unknown",
    "overage",
  ] as const) {
    it.effect(`reports Claude ${scenario} evidence at turn completion`, () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });
        if (scenario === "login") {
          harness.query.emit({
            type: "rate_limit_event",
            rate_limit_info: {
              status: "rejected",
              rateLimitType: "five_hour",
              resetsAt: 1790607600,
            },
            uuid: "auth-limit",
            session_id: "limits-session",
          } as unknown as SDKMessage);
          harness.query.emit({
            type: "assistant",
            error: "authentication_failed",
            uuid: "login-error",
            session_id: "limits-session",
            parent_tool_use_id: null,
            message: { id: "login-error", role: "assistant", content: [], usage: {} },
          } as unknown as SDKMessage);
        } else {
          harness.query.emit({
            type: "rate_limit_event",
            rate_limit_info: {
              status: "rejected",
              rateLimitType: scenario === "overage" ? "overage" : "five_hour",
              resetsAt: 1790607600,
            },
            uuid: "limit",
            session_id: "limits-session",
          } as unknown as SDKMessage);
          if (scenario === "multiple" || scenario === "unknown")
            harness.query.emit({
              type: "rate_limit_event",
              rate_limit_info: {
                status: "rejected",
                rateLimitType: "seven_day",
                ...(scenario === "multiple" ? { resetsAt: 1790694000 } : {}),
              },
              uuid: "weekly-limit",
              session_id: "limits-session",
            } as unknown as SDKMessage);
          if (scenario === "recovered")
            harness.query.emit({
              type: "rate_limit_event",
              rate_limit_info: { status: "allowed", rateLimitType: "five_hour" },
              uuid: "recovered",
              session_id: "limits-session",
            } as unknown as SDKMessage);
        }
        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: scenario !== "recovered",
          result: "",
          session_id: "limits-session",
          uuid: "limit-result",
          ...(scenario === "interrupted" || scenario === "unrelated"
            ? {
                subtype: "error_during_execution",
                errors: [scenario === "interrupted" ? "interrupted by user" : "disk is full"],
              }
            : {}),
          usage: {},
          modelUsage: {},
        } as unknown as SDKMessage);
        const completed = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.completed"),
          Stream.runHead,
        );
        assert.equal(completed._tag, "Some");
        if (completed._tag === "Some") {
          assert.equal(
            completed.value.payload.state,
            scenario === "recovered"
              ? "completed"
              : scenario === "interrupted"
                ? "interrupted"
                : "failed",
          );
          if (scenario === "unrelated")
            assert.equal(completed.value.payload.errorMessage, "disk is full");
          if (scenario === "login")
            assert.match(completed.value.payload.errorMessage ?? "", /\/login/);
          if (scenario === "blocked") {
            assert.match(completed.value.payload.errorMessage ?? "", /5-hour.*Resets at/);
            assert.equal(completed.value.payload.usageLimit?.evidence, "typed");
            assert.equal(completed.value.payload.usageLimit?.windows[0]?.id, "five_hour");
            assert.equal(
              completed.value.payload.usageLimit?.resetsAt,
              new Date(1790607600 * 1000).toISOString(),
            );
          } else if (scenario === "multiple" || scenario === "unknown") {
            assert.equal(completed.value.payload.usageLimit?.windows.length, 2);
            assert.equal(
              completed.value.payload.usageLimit?.resetsAt,
              scenario === "multiple" ? new Date(1790694000 * 1000).toISOString() : null,
            );
          } else assert.equal(completed.value.payload.usageLimit, undefined);
          if (scenario === "recovered")
            assert.equal(completed.value.payload.errorMessage, undefined);
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });
  }

  for (const originalError of [undefined, "usage limit reached"] as const) {
    it.effect(
      `requires positive usage evidence outside a turn (${originalError ?? "no error text"})`,
      () => {
        const harness = makeHarness();
        return Effect.gen(function* () {
          const adapter = yield* ClaudeAdapter;
          yield* adapter.startSession({
            threadId: THREAD_ID,
            provider: "claudeAgent",
            runtimeMode: "full-access",
          });
          harness.query.emit({
            type: "rate_limit_event",
            rate_limit_info: {
              status: "rejected",
              rateLimitType: "five_hour",
              resetsAt: 1790607600,
            },
            uuid: "outside-limit",
            session_id: "limits-session",
          } as unknown as SDKMessage);
          harness.query.emit({
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            errors: originalError ? [originalError] : [],
            session_id: "limits-session",
            uuid: "outside-failure",
            usage: {},
            modelUsage: {},
          } as unknown as SDKMessage);
          const event = yield* adapter.streamEvents.pipe(
            Stream.filter((event) => event.type === "runtime.error"),
            Stream.runHead,
          );
          assert.equal(event._tag, "Some");
          if (event._tag === "Some") {
            assert.equal(
              event.value.payload.usageLimit?.evidence,
              originalError ? "typed" : undefined,
            );
          }
        }).pipe(
          Effect.provideService(Random.Random, makeDeterministicRandomService()),
          Effect.provide(harness.layer),
        );
      },
    );
  }

  it.effect("surfaces in-band Fable alias rejection and completes a supported-model retry", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "fable",
        runtimeMode: "full-access",
        providerOptions: { claudeAgent: { subagentModel: "inherit" } },
      });
      assert.equal(harness.getLastCreateQueryInput()?.options.model, "claude-fable-5-1");
      assert.equal(
        harness.getLastCreateQueryInput()?.options.env?.CLAUDE_CODE_SUBAGENT_MODEL,
        undefined,
      );
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] });
      harness.query.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Model claude-fable-5-1 is not supported by this executable"],
        session_id: "sdk-fable-rejected",
        uuid: "fable-rejection",
      } as unknown as SDKMessage);
      const failureEvents = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "session.exited"),
        Stream.runCollect,
      );
      const completed = failureEvents.find((event) => event.type === "turn.completed");
      assert.equal(completed?.payload.state, "failed");
      assert.match(completed?.payload.errorMessage ?? "", /claude-fable-5-1/);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        model: "fable-5",
      });
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        model: "fable-5",
        input: "retry with supported model",
        attachments: [],
      });
      assert.equal(harness.query.closeCalls, 1);
      assert.equal(harness.getLastCreateQueryInput()?.options.model, "claude-fable-5");
      harness.queries[1]!.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Retry succeeded",
        session_id: "sdk-fable-rejected",
        uuid: "retry-success",
        usage: {},
        modelUsage: {},
      } as unknown as SDKMessage);
      const retry = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead);
      assert.equal(retry._tag, "Some");
      if (retry._tag === "Some") {
        assert.equal(retry.value.payload.state, "completed");
        assert.equal(retry.value.payload.errorMessage, undefined);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("treats aborted_tools results as interrupted and hides ede_diagnostic errors", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["[ede_diagnostic] result_type=user stop_reason=tool_use"],
        stop_reason: "tool_use",
        terminal_reason: "aborted_tools",
        session_id: "sdk-session-abort-tools",
        uuid: "result-abort-tools",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.equal(
        runtimeEvents.some((event) => event.type === "runtime.error"),
        false,
      );
      const completed = runtimeEvents.at(-1);
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(String(completed.turnId), String(turn.turnId));
        assert.equal(completed.payload.state, "interrupted");
        assert.equal(completed.payload.errorMessage, undefined);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "consumes informational notices and represents API retries without warning spam",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        for (const subtype of [
          "background_tasks_changed",
          "vcs_state_changed",
          "code_change_published",
          "commands_changed",
          "model_refusal_fallback",
          "local_command_output",
          "plugin_install",
          "memory_recall",
          "elicitation_complete",
        ]) {
          harness.query.emit({
            type: "system",
            subtype,
            content: "Claude switched to a fallback model",
            session_id: "sdk-session-notices",
            uuid: `notice-${subtype}`,
          } as unknown as SDKMessage);
        }
        harness.query.emit({
          type: "prompt_suggestion",
          suggestion: "Try this next",
          session_id: "sdk-session-notices",
          uuid: "notice-prompt-suggestion",
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "system",
          subtype: "api_retry",
          attempt: 2,
          max_retries: 5,
          session_id: "sdk-session-notices",
          uuid: "notice-api-retry",
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "system",
          subtype: "future_notice",
          session_id: "sdk-session-notices",
          uuid: "notice-future",
        } as unknown as SDKMessage);

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        assert.equal(runtimeEvents.length, 7);
        const retryState = runtimeEvents.find(
          (event) =>
            event.type === "session.state.changed" && event.payload.reason === "api_retry:2/5",
        );
        assert.equal(retryState?.type, "session.state.changed");
        const warnings = runtimeEvents.filter((event) => event.type === "runtime.warning");
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0]?.payload.message, "Claude switched to a fallback model");
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("closes the session when the Claude stream aborts after a turn starts", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];

      const runtimeEventsFiber = Effect.runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.fail(new Error("All fibers interrupted without error"));

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      runtimeEventsFiber.interruptUnsafe();
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "turn.completed",
          "session.exited",
        ],
      );

      const turnCompleted = runtimeEvents[4];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, "Claude runtime interrupted.");
      }

      const sessionExited = runtimeEvents[5];
      assert.equal(sessionExited?.type, "session.exited");

      assert.equal(yield* adapter.hasSession(THREAD_ID), false);
      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.length, 0);
      assert.equal(harness.query.closeCalls, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("handles Claude stream exits that happen before observer registration", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];

      const runtimeEventsFiber = Effect.runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      harness.query.finish();

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      runtimeEventsFiber.interruptUnsafe();

      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        ["session.started", "session.configured", "session.state.changed", "session.exited"],
      );
      assert.equal(runtimeEvents.filter((event) => event.type === "session.exited").length, 1);
      assert.equal(yield* adapter.hasSession(THREAD_ID), false);
      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.length, 0);
      assert.equal(harness.query.closeCalls, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores late Claude stream exits after stopSession", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];

      const runtimeEventsFiber = Effect.runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      (harness.query as { close: () => void }).close = () => {
        harness.query.closeCalls += 1;
      };

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      yield* adapter.stopSession(THREAD_ID);
      harness.query.fail(new Error("late stream failure after stop"));

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      runtimeEventsFiber.interruptUnsafe();

      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "turn.completed",
          "session.exited",
        ],
      );
      assert.equal(runtimeEvents.filter((event) => event.type === "turn.completed").length, 1);
      assert.equal(runtimeEvents.filter((event) => event.type === "session.exited").length, 1);
      assert.equal(
        runtimeEvents.some((event) => event.type === "runtime.error"),
        false,
      );

      const turnCompleted = runtimeEvents.find((event) => event.type === "turn.completed");
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, "Session stopped.");
      }

      assert.equal(yield* adapter.hasSession(THREAD_ID), false);
      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.length, 0);
      assert.equal(harness.query.closeCalls, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "stops a real SDK-backed Claude session without unhandled rejections while prompt input is idle",
    () => {
      const harness = makeRealSdkHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const unhandledRejections: unknown[] = [];
        const onUnhandledRejection = (reason: unknown) => {
          unhandledRejections.push(reason);
        };

        process.on("unhandledRejection", onUnhandledRejection);

        const runtimeEventsFiber = Effect.runFork(
          Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => {
              runtimeEvents.push(event);
            }),
          ),
        );

        try {
          yield* adapter.startSession({
            threadId: THREAD_ID,
            provider: "claudeAgent",
            runtimeMode: "full-access",
          });
          yield* Effect.promise(() => harness.awaitInitialization());

          const turn = yield* adapter.sendTurn({
            threadId: THREAD_ID,
            input: "hello",
            attachments: [],
          });

          yield* Effect.promise(() => harness.awaitFirstPromptWritten());
          yield* adapter.stopSession(THREAD_ID);
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));

          assert.equal(unhandledRejections.length, 0);
          const runtimeEventTypes = runtimeEvents.map((event) => event.type);
          assert.equal(runtimeEventTypes[0], "session.started");
          assert.equal(runtimeEventTypes[1], "session.configured");
          assert.equal(runtimeEventTypes[2], "session.state.changed");
          assert.equal(runtimeEventTypes.at(-2), "turn.completed");
          assert.equal(runtimeEventTypes.at(-1), "session.exited");
          assert.ok(
            runtimeEventTypes.every(
              (type, index) =>
                index <= 2 ||
                type !== "session.configured" ||
                runtimeEventTypes[index - 1] === "session.state.changed",
            ),
          );

          const turnCompleted = runtimeEvents.findLast((event) => event.type === "turn.completed");
          assert.equal(turnCompleted?.type, "turn.completed");
          if (turnCompleted?.type === "turn.completed") {
            assert.equal(String(turnCompleted.turnId), String(turn.turnId));
            assert.equal(turnCompleted.payload.state, "interrupted");
            assert.equal(turnCompleted.payload.errorMessage, "Session stopped.");
          }

          const sessionExited = runtimeEvents.findLast((event) => event.type === "session.exited");
          assert.equal(sessionExited?.type, "session.exited");

          assert.equal(yield* adapter.hasSession(THREAD_ID), false);
          const sessions = yield* adapter.listSessions();
          assert.equal(sessions.length, 0);
        } finally {
          process.off("unhandledRejection", onUnhandledRejection);
          runtimeEventsFiber.interruptUnsafe();
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "keeps an early subagent snapshot model without leaking child text into the parent",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const progress = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "task.progress"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
          model: "claude-opus-5-5",
        });
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "review", attachments: [] });
        harness.query.emit({
          type: "assistant",
          parent_tool_use_id: "agent-tool",
          message: {
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "private child response" }],
          },
          uuid: "child-snapshot",
          session_id: BACKGROUND_SESSION_ID,
        } as unknown as SDKMessage);
        emitClaudeTaskStarted(harness.query, {
          taskId: "agent-task",
          toolUseId: "agent-tool",
          description: "Review",
        });
        harness.query.emit({
          type: "system",
          subtype: "task_progress",
          task_id: "agent-task",
          description: "Review",
          session_id: BACKGROUND_SESSION_ID,
          uuid: "agent-progress",
        } as unknown as SDKMessage);
        const collected = Array.from(yield* Fiber.join(progress));
        const events = collected.filter((event) => event.type === "task.progress");
        assert.equal(events[0]?.type, "task.progress");
        if (events[0]?.type === "task.progress")
          assert.equal(events[0].payload.model, "claude-sonnet-4-6");
        const started = collected.find((event) => event.type === "task.started");
        if (started?.type === "task.started")
          assert.equal(started.payload.model, "claude-sonnet-4-6");
        else assert.fail("Missing task start");
        assert.ok(
          !collected.some(
            (event) =>
              event.type === "content.delta" &&
              event.payload.delta.includes("private child response"),
          ),
        );
        yield* adapter.stopSession(THREAD_ID);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("forwards Claude task progress summaries for subagent updates", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-subagent-1",
        description: "Running background teammate",
        summary: "Code reviewer checked the migration edge cases.",
        usage: {
          total_tokens: 123,
          tool_uses: 4,
          duration_ms: 987,
        },
        session_id: "sdk-session-task-summary",
        uuid: "task-progress-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const progressEvent = runtimeEvents.find((event) => event.type === "task.progress");
      assert.equal(progressEvent?.type, "task.progress");
      if (progressEvent?.type === "task.progress") {
        assert.equal(progressEvent.payload.description, "Running background teammate");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps Claude task_updated background patches to in-progress tool rows", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "run a background command",
        attachments: [],
      });

      emitBashToolStart(harness.query, {
        toolUseId: "tool-bg-running",
      });
      emitClaudeTaskStarted(harness.query, {
        taskId: "task-bg-running",
        toolUseId: "tool-bg-running",
      });
      emitClaudeTaskUpdated(harness.query, {
        taskId: "task-bg-running",
        patch: {
          is_backgrounded: true,
        },
      });
      emitBackgroundToolResult(harness.query, {
        taskId: "task-bg-running",
        toolUseId: "tool-bg-running",
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.equal(
        runtimeEvents.some((event) => event.type === "runtime.warning"),
        false,
      );

      const backgroundUpdates = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "item.updated" }> =>
          event.type === "item.updated" &&
          String(event.itemId) === "tool-bg-running" &&
          event.payload.title === "Command run — running",
      );
      assert.equal(backgroundUpdates.length, 2);
      for (const event of backgroundUpdates) {
        assert.equal(event.payload.status, "inProgress");
      }

      const latestUpdate = backgroundUpdates.at(-1);
      assert.equal(latestUpdate?.type, "item.updated");
      if (latestUpdate?.type === "item.updated") {
        const data = latestUpdate.payload.data as { result?: Record<string, unknown> } | undefined;
        assert.equal(data?.result?.backgroundTaskId, "task-bg-running");
        assert.equal(data?.result?.backgroundStatus, "running");
      }

      assert.equal(
        runtimeEvents.some(
          (event) => event.type === "item.completed" && String(event.itemId) === "tool-bg-running",
        ),
        false,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("preserves the subagent descriptor in background work-log titles", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => runtimeEvents.push(event)),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "delegate an exploration",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: BACKGROUND_SESSION_ID,
        uuid: "stream-tool-bg-agent-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-bg-agent",
            name: "Task",
            input: {
              description: "Explore the provider runtime",
              prompt: "Inspect the adapter",
              subagent_type: "explore",
            },
          },
        },
      } as unknown as SDKMessage);
      emitClaudeTaskStarted(harness.query, {
        taskId: "task-bg-agent",
        toolUseId: "tool-bg-agent",
      });
      emitClaudeTaskUpdated(harness.query, {
        taskId: "task-bg-agent",
        patch: { is_backgrounded: true },
      });
      emitBackgroundToolResult(harness.query, {
        taskId: "task-bg-agent",
        toolUseId: "tool-bg-agent",
      });

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      const updates = runtimeEvents.filter(
        (event) => event.type === "item.updated" && String(event.itemId) === "tool-bg-agent",
      );
      assert.equal(updates.length, 2);
      assert.equal(
        updates.every(
          (event) =>
            event.type === "item.updated" && event.payload.title === "Explore agent — running",
        ),
        true,
      );
      runtimeEventsFiber.interruptUnsafe();
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("completes background tools from terminal Claude task_updated patches", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 11).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "run a background command",
        attachments: [],
      });

      emitBashToolStart(harness.query, {
        toolUseId: "tool-bg-complete",
      });
      emitClaudeTaskStarted(harness.query, {
        taskId: "task-bg-complete",
        toolUseId: "tool-bg-complete",
      });
      emitBackgroundToolResult(harness.query, {
        taskId: "task-bg-complete",
        toolUseId: "tool-bg-complete",
      });
      emitClaudeSuccessResult(harness.query);
      emitClaudeTaskUpdated(harness.query, {
        taskId: "task-bg-complete",
        patch: {
          status: "completed",
          end_time: 1_785_000_000,
        },
      });
      emitClaudeSuccessResult(harness.query, { uuid: "result-after-background-complete" });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.equal(
        runtimeEvents.some((event) => event.type === "runtime.warning"),
        false,
      );

      const completions = runtimeEvents.filter(
        (event) => event.type === "item.completed" && String(event.itemId) === "tool-bg-complete",
      );
      assert.equal(completions.length, 1);

      const completion = completions[0];
      assert.equal(completion?.type, "item.completed");
      if (completion?.type === "item.completed") {
        assert.equal(String(completion.turnId), String(turn.turnId));
        assert.equal(completion.payload.status, "completed");
        assert.equal(completion.payload.title, "Command run — completed");
        const data = completion.payload.data as { result?: Record<string, unknown> } | undefined;
        assert.equal(data?.result?.backgroundTaskId, "task-bg-complete");
        assert.equal(data?.result?.backgroundStatus, "completed");
        assert.equal(data?.result?.backgroundEndedAt, "2026-07-25T17:20:00.000Z");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "fails background tools from terminal Claude task_updated patches before the turn ends",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        const turn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "run a background command",
          attachments: [],
        });

        emitBashToolStart(harness.query, {
          toolUseId: "tool-bg-failed",
        });
        emitBackgroundToolResult(harness.query, {
          taskId: "task-bg-failed",
          toolUseId: "tool-bg-failed",
        });
        emitClaudeSuccessResult(harness.query);
        emitClaudeTaskUpdated(harness.query, {
          taskId: "task-bg-failed",
          patch: {
            status: "failed",
          },
        });
        emitClaudeSuccessResult(harness.query, { uuid: "result-after-background-failed" });

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        assert.equal(
          runtimeEvents.some((event) => event.type === "runtime.warning"),
          false,
        );

        const completion = runtimeEvents.find(
          (event) => event.type === "item.completed" && String(event.itemId) === "tool-bg-failed",
        );
        assert.equal(completion?.type, "item.completed");
        if (completion?.type === "item.completed") {
          assert.equal(String(completion.turnId), String(turn.turnId));
          assert.equal(completion.payload.status, "failed");
          assert.equal(completion.payload.title, "Command run — failed");
          const data = completion.payload.data as { result?: Record<string, unknown> } | undefined;
          assert.equal(data?.result?.backgroundTaskId, "task-bg-failed");
          assert.equal(data?.result?.backgroundStatus, "failed");
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("maps unassociated terminal Claude task_updated patches to task completion", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      emitClaudeTaskUpdated(harness.query, {
        taskId: "task-unassociated",
        patch: {
          status: "completed",
        },
        sessionId: "sdk-session-unassociated-task",
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.equal(
        runtimeEvents.some((event) => event.type === "runtime.warning"),
        false,
      );

      const completion = runtimeEvents.find((event) => event.type === "task.completed");
      assert.equal(completion?.type, "task.completed");
      if (completion?.type === "task.completed") {
        assert.equal(String(completion.payload.taskId), "task-unassociated");
        assert.equal(completion.payload.status, "completed");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "emits completion only after turn result when assistant frames arrive before deltas",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        const turn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        harness.query.emit({
          type: "assistant",
          session_id: "sdk-session-early-assistant",
          uuid: "assistant-early",
          parent_tool_use_id: null,
          message: {
            id: "assistant-message-early",
            content: [
              { type: "tool_use", id: "tool-early", name: "Read", input: { path: "a.ts" } },
            ],
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-early-assistant",
          uuid: "stream-early",
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "text_delta",
              text: "Late text",
            },
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-early-assistant",
          uuid: "result-early",
        } as unknown as SDKMessage);

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        assert.deepEqual(
          runtimeEvents.map((event) => event.type),
          [
            "session.started",
            "session.configured",
            "session.state.changed",
            "turn.started",
            "thread.started",
            "content.delta",
            "item.completed",
            "turn.completed",
          ],
        );

        const deltaIndex = runtimeEvents.findIndex((event) => event.type === "content.delta");
        const completedIndex = runtimeEvents.findIndex((event) => event.type === "item.completed");
        assert.equal(deltaIndex >= 0 && completedIndex >= 0 && deltaIndex < completedIndex, true);

        const deltaEvent = runtimeEvents[deltaIndex];
        assert.equal(deltaEvent?.type, "content.delta");
        if (deltaEvent?.type === "content.delta") {
          assert.equal(deltaEvent.payload.delta, "Late text");
          assert.equal(String(deltaEvent.turnId), String(turn.turnId));
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("creates a fresh assistant message when Claude reuses a text block index", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-start-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-delta-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "First",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-stop-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-start-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-delta-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Second",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-stop-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-reused-text-index",
        uuid: "result-reused-text-index",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "content.delta",
          "item.completed",
        ],
      );

      const assistantDeltas = runtimeEvents.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      assert.equal(assistantDeltas.length, 2);
      if (assistantDeltas.length !== 2) {
        return;
      }
      const [firstAssistantDelta, secondAssistantDelta] = assistantDeltas;
      assert.equal(firstAssistantDelta?.type, "content.delta");
      assert.equal(secondAssistantDelta?.type, "content.delta");
      if (
        firstAssistantDelta?.type !== "content.delta" ||
        secondAssistantDelta?.type !== "content.delta"
      ) {
        return;
      }
      assert.equal(firstAssistantDelta.payload.delta, "First");
      assert.equal(secondAssistantDelta.payload.delta, "Second");
      assert.notEqual(firstAssistantDelta.itemId, secondAssistantDelta.itemId);

      const assistantCompletions = runtimeEvents.filter(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      assert.equal(assistantCompletions.length, 2);
      assert.equal(String(assistantCompletions[0]?.itemId), String(firstAssistantDelta.itemId));
      assert.equal(String(assistantCompletions[1]?.itemId), String(secondAssistantDelta.itemId));
      assert.notEqual(
        String(assistantCompletions[0]?.itemId),
        String(assistantCompletions[1]?.itemId),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("falls back to assistant payload text when stream deltas are absent", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-fallback-text",
        uuid: "assistant-fallback",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-fallback",
          content: [{ type: "text", text: "Fallback hello" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-fallback-text",
        uuid: "result-fallback",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "turn.completed",
        ],
      );

      const deltaEvent = runtimeEvents.find((event) => event.type === "content.delta");
      assert.equal(deltaEvent?.type, "content.delta");
      if (deltaEvent?.type === "content.delta") {
        assert.equal(deltaEvent.payload.delta, "Fallback hello");
        assert.equal(String(deltaEvent.turnId), String(turn.turnId));
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("segments Claude assistant text blocks around tool calls", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 13).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-delta",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "First message.",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-tool-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-interleaved-1",
            name: "Grep",
            input: {
              pattern: "assistant",
              path: "src",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-tool-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-interleaved",
        uuid: "user-tool-result-interleaved",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-interleaved-1",
              content: "src/example.ts:1:assistant",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 2,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-delta",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 2,
          delta: {
            type: "text_delta",
            text: "Second message.",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 2,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-interleaved",
        uuid: "result-interleaved",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "item.started",
          "item.updated",
          "item.completed",
          "content.delta",
          "item.completed",
          "turn.completed",
        ],
      );

      const assistantTextDeltas = runtimeEvents.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      assert.equal(assistantTextDeltas.length, 2);
      if (assistantTextDeltas.length !== 2) {
        return;
      }
      const [firstAssistantDelta, secondAssistantDelta] = assistantTextDeltas;
      if (!firstAssistantDelta || !secondAssistantDelta) {
        return;
      }
      assert.notEqual(String(firstAssistantDelta.itemId), String(secondAssistantDelta.itemId));

      const firstAssistantCompletedIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "item.completed" &&
          event.payload.itemType === "assistant_message" &&
          String(event.itemId) === String(firstAssistantDelta.itemId),
      );
      const toolStartedIndex = runtimeEvents.findIndex((event) => event.type === "item.started");
      const secondAssistantDeltaIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "content.delta" &&
          event.payload.streamKind === "assistant_text" &&
          String(event.itemId) === String(secondAssistantDelta.itemId),
      );

      assert.equal(
        firstAssistantCompletedIndex >= 0 &&
          toolStartedIndex >= 0 &&
          secondAssistantDeltaIndex >= 0 &&
          firstAssistantCompletedIndex < toolStartedIndex &&
          toolStartedIndex < secondAssistantDeltaIndex,
        true,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not fabricate provider thread ids before first SDK session_id", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      assert.equal(session.threadId, THREAD_ID);

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      assert.equal(turn.threadId, THREAD_ID);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-thread-real",
        uuid: "stream-thread-real",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-thread-real",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-thread-real",
        uuid: "result-thread-real",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
        ],
      );

      const sessionStarted = runtimeEvents[0];
      assert.equal(sessionStarted?.type, "session.started");
      if (sessionStarted?.type === "session.started") {
        assert.equal(sessionStarted.threadId, THREAD_ID);
      }

      const threadStarted = runtimeEvents[4];
      assert.equal(threadStarted?.type, "thread.started");
      if (threadStarted?.type === "thread.started") {
        assert.equal(threadStarted.threadId, THREAD_ID);
        assert.deepEqual(threadStarted.payload, {
          providerThreadId: "sdk-thread-real",
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("emits thread token usage snapshots from Claude message usage events", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      assert.equal(session.threadId, THREAD_ID);

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      assert.equal(turn.threadId, THREAD_ID);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-thread-token-usage",
        uuid: "stream-thread-token-usage",
        parent_tool_use_id: null,
        event: {
          type: "message_delta",
          delta: {
            stop_reason: "end_turn",
            stop_sequence: null,
          },
          usage: {
            input_tokens: 500,
            cache_creation_input_tokens: 30,
            cache_read_input_tokens: 20,
            output_tokens: 40,
          },
        },
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "thread.token-usage.updated",
        ],
      );

      const tokenUsageUpdated = runtimeEvents[5];
      assert.equal(tokenUsageUpdated?.type, "thread.token-usage.updated");
      if (tokenUsageUpdated?.type === "thread.token-usage.updated") {
        assert.equal(String(tokenUsageUpdated.turnId), String(turn.turnId));
        assert.deepEqual(tokenUsageUpdated.payload, {
          usage: {
            input_tokens: 500,
            cache_creation_input_tokens: 30,
            cache_read_input_tokens: 20,
            output_tokens: 40,
          },
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("emits a thinking-tokens update for Claude thinking_tokens system messages", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      assert.equal(session.threadId, THREAD_ID);

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      assert.equal(turn.threadId, THREAD_ID);

      harness.query.emit({
        type: "system",
        subtype: "thinking_tokens",
        estimated_tokens: 1_280,
        estimated_tokens_delta: 64,
        uuid: "thinking-tokens-1",
        session_id: "sdk-thinking-tokens",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "thread.thinking-tokens.updated",
        ],
      );

      // Regression: the new subtype must not fall through to the default branch
      // and emit a runtime warning.
      assert.equal(
        runtimeEvents.some((event) => event.type === "runtime.warning"),
        false,
      );

      const thinkingTokensUpdated = runtimeEvents[5];
      assert.equal(thinkingTokensUpdated?.type, "thread.thinking-tokens.updated");
      if (thinkingTokensUpdated?.type === "thread.thinking-tokens.updated") {
        assert.equal(String(thinkingTokensUpdated.turnId), String(turn.turnId));
        assert.deepEqual(thinkingTokensUpdated.payload, {
          estimatedTokens: 1_280,
          estimatedTokensDelta: 64,
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("includes refreshed Claude context-window metadata on token usage snapshots", () => {
    const harness = makeHarness();
    harness.query.setSupportedModelsResult([
      {
        value: "claude-opus-4-5",
        capabilities: {
          max_input_tokens: 1_234_567,
        },
      },
    ]);

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        model: "claude-opus-4-5",
      });
      yield* Stream.take(adapter.streamEvents, 4).pipe(Stream.runDrain);

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-thread-token-usage-refreshed",
        uuid: "stream-thread-token-usage-refreshed",
        parent_tool_use_id: null,
        event: {
          type: "message_delta",
          delta: {
            stop_reason: "end_turn",
            stop_sequence: null,
          },
          usage: {
            input_tokens: 500,
            output_tokens: 40,
          },
        },
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(
        yield* Stream.take(adapter.streamEvents, 2).pipe(Stream.runCollect),
      );
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        ["thread.started", "thread.token-usage.updated"],
      );

      const tokenUsageUpdated = runtimeEvents[1];
      assert.equal(tokenUsageUpdated?.type, "thread.token-usage.updated");
      if (tokenUsageUpdated?.type === "thread.token-usage.updated") {
        assert.equal(String(tokenUsageUpdated.turnId), String(turn.turnId));
        assert.equal(tokenUsageUpdated.payload.modelContextWindowTokens, 1_234_567);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses Claude init model metadata when no model was requested explicitly", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      harness.query.emit({
        type: "system",
        subtype: "init",
        session_id: "sdk-thread-init-model",
        uuid: "system-init-model",
        model: "claude-opus-4-7",
      } as unknown as SDKMessage);

      const configured = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(configured._tag, "Some");
      if (configured._tag !== "Some" || configured.value.type !== "session.configured") {
        return;
      }
      assert.equal(
        (configured.value.payload.config as Record<string, unknown>).modelContextWindowTokens,
        1_000_000,
      );

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-thread-init-model",
        uuid: "stream-thread-init-model-usage",
        parent_tool_use_id: null,
        event: {
          type: "message_delta",
          delta: {
            stop_reason: "end_turn",
            stop_sequence: null,
          },
          usage: {
            input_tokens: 500,
            output_tokens: 40,
          },
        },
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(
        yield* Stream.take(adapter.streamEvents, 2).pipe(Stream.runCollect),
      );
      const tokenUsageUpdated = runtimeEvents[1];
      assert.equal(tokenUsageUpdated?.type, "thread.token-usage.updated");
      if (tokenUsageUpdated?.type === "thread.token-usage.updated") {
        assert.equal(tokenUsageUpdated.payload.modelContextWindowTokens, 1_000_000);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  for (const approvalCase of [
    "accept",
    "session-suggestions",
    "session-empty",
    "session-absent",
  ] as const) {
    it.effect(`bridges approval lifecycle: ${approvalCase}`, () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "approval-required",
        });

        yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "approve this",
          attachments: [],
        });
        yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-approval-1",
          uuid: "stream-approval-thread",
          parent_tool_use_id: null,
          event: {
            type: "message_start",
            message: {
              id: "msg-approval-thread",
            },
          },
        } as unknown as SDKMessage);

        const threadStarted = yield* Stream.runHead(adapter.streamEvents);
        assert.equal(threadStarted._tag, "Some");
        if (threadStarted._tag !== "Some" || threadStarted.value.type !== "thread.started") {
          return;
        }

        const createInput = harness.getLastCreateQueryInput();
        const canUseTool = createInput?.options.canUseTool;
        assert.equal(typeof canUseTool, "function");
        if (!canUseTool) {
          return;
        }

        const permissionPromise = canUseTool(
          "Bash",
          { command: "pwd" },
          {
            signal: new AbortController().signal,
            ...(approvalCase === "session-absent"
              ? {}
              : {
                  suggestions:
                    approvalCase === "session-empty"
                      ? []
                      : [
                          {
                            type: "setMode" as const,
                            mode: "default" as const,
                            destination: "localSettings" as const,
                          },
                        ],
                }),
            toolUseID: "tool-use-1",
            requestId: "request-tool-use-1",
          },
        );

        const requested = yield* Stream.runHead(adapter.streamEvents);
        assert.equal(requested._tag, "Some");
        if (requested._tag !== "Some") {
          return;
        }
        assert.equal(requested.value.type, "request.opened");
        if (requested.value.type !== "request.opened") {
          return;
        }
        assert.deepEqual(requested.value.providerRefs, {
          providerItemId: ProviderItemId.makeUnsafe("tool-use-1"),
        });
        const runtimeRequestId = requested.value.requestId;
        assert.equal(typeof runtimeRequestId, "string");
        if (runtimeRequestId === undefined) {
          return;
        }

        yield* adapter.respondToRequest(
          session.threadId,
          ApprovalRequestId.makeUnsafe(runtimeRequestId),
          approvalCase === "accept" ? "accept" : "acceptForSession",
        );

        const resolved = yield* Stream.runHead(adapter.streamEvents);
        assert.equal(resolved._tag, "Some");
        if (resolved._tag !== "Some") {
          return;
        }
        assert.equal(resolved.value.type, "request.resolved");
        if (resolved.value.type !== "request.resolved") {
          return;
        }
        assert.equal(resolved.value.requestId, requested.value.requestId);
        assert.equal(
          resolved.value.payload.decision,
          approvalCase === "accept" ? "accept" : "acceptForSession",
        );
        assert.deepEqual(resolved.value.providerRefs, {
          providerItemId: ProviderItemId.makeUnsafe("tool-use-1"),
        });

        const permissionResult = yield* Effect.promise(() => permissionPromise);
        assert.deepEqual(permissionResult, {
          behavior: "allow",
          updatedInput: { command: "pwd" },
          ...(approvalCase === "session-suggestions"
            ? { updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }] }
            : {}),
        });
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });
  }

  it.effect("classifies Agent tools and read-only Claude tools correctly for approvals", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const agentPermissionPromise = canUseTool(
        "Agent",
        {},
        {
          signal: new AbortController().signal,
          toolUseID: "tool-agent-1",
          requestId: "request-tool-agent-1",
        },
      );

      const agentRequested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(agentRequested._tag, "Some");
      if (agentRequested._tag !== "Some" || agentRequested.value.type !== "request.opened") {
        return;
      }
      assert.equal(agentRequested.value.payload.requestType, "dynamic_tool_call");

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.makeUnsafe(String(agentRequested.value.requestId)),
        "accept",
      );
      yield* Stream.runHead(adapter.streamEvents);
      yield* Effect.promise(() => agentPermissionPromise);

      const grepPermissionPromise = canUseTool(
        "Grep",
        { pattern: "foo", path: "src" },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-grep-approval-1",
          requestId: "request-tool-grep-approval-1",
        },
      );

      const grepRequested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(grepRequested._tag, "Some");
      if (grepRequested._tag !== "Some" || grepRequested.value.type !== "request.opened") {
        return;
      }
      assert.equal(grepRequested.value.payload.requestType, "file_read_approval");

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.makeUnsafe(String(grepRequested.value.requestId)),
        "accept",
      );
      yield* Stream.runHead(adapter.streamEvents);
      yield* Effect.promise(() => grepPermissionPromise);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("passes Claude resume ids without pinning a stale assistant checkpoint", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: "claudeAgent",
        resumeCursor: {
          threadId: "resume-thread-1",
          resume: "550e8400-e29b-41d4-a716-446655440000",
          resumeSessionAt: "assistant-99",
          turnCount: 3,
        },
        runtimeMode: "full-access",
      });

      assert.equal(session.threadId, RESUME_THREAD_ID);
      assert.deepEqual(session.resumeCursor, {
        threadId: RESUME_THREAD_ID,
        resume: "550e8400-e29b-41d4-a716-446655440000",
        resumeSessionAt: "assistant-99",
        turnCount: 3,
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.resume, "550e8400-e29b-41d4-a716-446655440000");
      assert.equal(createInput?.options.sessionId, undefined);
      assert.equal(createInput?.options.resumeSessionAt, undefined);
      const resumeAppendSystemPrompt = createInput
        ? (
            createInput.options as ClaudeQueryOptions & {
              readonly systemPrompt?: unknown;
            }
          ).systemPrompt
        : undefined;
      assert.ok(resumeAppendSystemPrompt);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("updates the workflow profile while resuming the same Claude conversation", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const resume = "550e8400-e29b-41d4-a716-446655440000";

      yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: "claudeAgent",
        resumeCursor: {
          threadId: RESUME_THREAD_ID,
          resume,
          turnCount: 3,
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.resume, resume);
      const append = (
        createInput?.options as ClaudeQueryOptionsForTest & {
          readonly systemPrompt?: { readonly append?: string };
        }
      )?.systemPrompt?.append;
      assert.equal(append?.includes("# Collaboration Mode: Default"), true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("starts fresh with instructions when the resume preflight reports absence", () => {
    const harness = makeHarness({
      probeResumableClaudeSession: () => Effect.succeed("absent"),
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const attempted = "550e8400-e29b-41d4-a716-446655440000";
      const session = yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: "claudeAgent",
        resumeCursor: {
          threadId: RESUME_THREAD_ID,
          resume: attempted,
          turnCount: 4,
          baseContextChars: 1_000,
          approximateConversationChars: 2_000,
          compactionRecommendationEmitted: true,
        },
        threadTitle: "Resume recovery",
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.resume, undefined);
      assert.notEqual(createInput?.options.sessionId, attempted);
      assert.equal(
        typeof (
          createInput?.options as
            | (ClaudeQueryOptionsForTest & {
                systemPrompt?: { append: string };
              })
            | undefined
        )?.systemPrompt?.append,
        "string",
      );
      const cursor = session.resumeCursor as Record<string, unknown>;
      assert.notEqual(cursor.resume, attempted);
      assert.equal(cursor.turnCount, 0);
      assert.equal("sessionId" in cursor, false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  describe("resume preflight transcript probe", () => {
    const probeSessionId = "550e8400-e29b-41d4-a716-446655440000";

    const withClaudeConfigDir = <A, E, R>(
      use: (configDir: string) => Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.suspend(() => {
        const configDir = mkdtempSync(path.join(os.tmpdir(), "f5-claude-config-"));
        return use(configDir).pipe(
          Effect.ensuring(Effect.sync(() => rmSync(configDir, { recursive: true, force: true }))),
        );
      });

    const writeTranscript = (
      configDir: string,
      projectDir: string,
      sessionId: string,
      contents = '{"type":"system"}\n',
    ) => {
      const dir = path.join(configDir, "projects", projectDir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${sessionId}.jsonl`), contents);
    };

    const probeInput = (claudeConfigDir: string): ClaudeSessionProbeInput => ({
      sessionId: probeSessionId,
      claudeConfigDir,
    });

    const noLines = (): AsyncIterable<string> => (async function* () {})();

    it.effect("reports present when any project dir holds the transcript", () =>
      withClaudeConfigDir((configDir) =>
        Effect.gen(function* () {
          writeTranscript(configDir, "-unrelated-project", "some-other-session");
          writeTranscript(configDir, "-a-different-cwd", probeSessionId);

          assert.equal(yield* probeClaudeSessionAvailability(probeInput(configDir)), "present");
        }),
      ),
    );

    it.effect("reports absent only when the readable store lacks the transcript", () =>
      withClaudeConfigDir((configDir) =>
        Effect.gen(function* () {
          writeTranscript(configDir, "-Users-me-project", "some-other-session");

          assert.equal(yield* probeClaudeSessionAvailability(probeInput(configDir)), "absent");
        }),
      ),
    );

    it.effect("does not treat an empty transcript as resumable", () =>
      withClaudeConfigDir((configDir) =>
        Effect.gen(function* () {
          writeTranscript(configDir, "-Users-me-project", probeSessionId, "");

          assert.equal(yield* probeClaudeSessionAvailability(probeInput(configDir)), "absent");
        }),
      ),
    );

    it.effect("does not treat a metadata-only transcript as resumable", () =>
      withClaudeConfigDir((configDir) =>
        Effect.gen(function* () {
          writeTranscript(
            configDir,
            "-Users-me-project",
            probeSessionId,
            [
              '{"type":"queue-operation","operation":"enqueue"}',
              '{"type":"summary","summary":"x"}',
              '{"type":"file-history-snapshot","snapshot":{}}',
              "",
            ].join("\n"),
          );

          assert.equal(yield* probeClaudeSessionAvailability(probeInput(configDir)), "absent");
        }),
      ),
    );

    it.effect("finds a conversation entry after leading metadata lines", () =>
      withClaudeConfigDir((configDir) =>
        Effect.gen(function* () {
          writeTranscript(
            configDir,
            "-Users-me-project",
            probeSessionId,
            '{"type":"summary","summary":"x"}\r\n{"type":"user","message":{}}\r\n{"type":"assis',
          );

          assert.equal(yield* probeClaudeSessionAvailability(probeInput(configDir)), "present");
        }),
      ),
    );

    it.effect("reports unknown when only an unparseable line could hold the conversation", () =>
      withClaudeConfigDir((configDir) =>
        Effect.gen(function* () {
          writeTranscript(
            configDir,
            "-Users-me-project",
            probeSessionId,
            '{"type":"summary","summary":"x"}\n{"type":"user","mess',
          );

          assert.equal(yield* probeClaudeSessionAvailability(probeInput(configDir)), "unknown");
        }),
      ),
    );

    it.effect("ignores stray regular files in the projects store", () =>
      withClaudeConfigDir((configDir) =>
        Effect.gen(function* () {
          writeTranscript(configDir, "-Users-me-project", "some-other-session");
          writeFileSync(path.join(configDir, "projects", ".DS_Store"), "junk");

          assert.equal(yield* probeClaudeSessionAvailability(probeInput(configDir)), "absent");

          writeTranscript(configDir, "-a-different-cwd", probeSessionId);

          assert.equal(yield* probeClaudeSessionAvailability(probeInput(configDir)), "present");
        }),
      ),
    );

    it.effect("reports unknown when the config dir has no projects store", () =>
      withClaudeConfigDir((configDir) =>
        Effect.gen(function* () {
          // Regression guard: probing the wrong config dir used to report
          // "absent" and silently discard the conversation.
          assert.equal(yield* probeClaudeSessionAvailability(probeInput(configDir)), "unknown");
        }),
      ),
    );

    it.effect("treats unreadable stores, stat failures, and timeouts as unknown", () =>
      Effect.gen(function* () {
        const accessDenied = Object.assign(new Error("permission denied"), { code: "EACCES" });
        const unreadableStore: ClaudeSessionStoreFs = {
          readdir: () => Promise.reject(accessDenied),
          stat: () => Promise.reject(new Error("unreachable")),
          readLines: noLines,
        };
        const unreadableProject: ClaudeSessionStoreFs = {
          readdir: () => Promise.resolve(["-a", "-b"]),
          stat: (target) =>
            target.includes(`${path.sep}-a${path.sep}`)
              ? Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" }))
              : Promise.reject(accessDenied),
          readLines: noLines,
        };
        const hangingStore: ClaudeSessionStoreFs = {
          readdir: () => new Promise<never>(() => {}),
          stat: () => new Promise<never>(() => {}),
          readLines: noLines,
        };

        const unreadable = yield* probeClaudeSessionAvailability(
          probeInput("/claude"),
          unreadableStore,
        );
        const statFailed = yield* probeClaudeSessionAvailability(
          probeInput("/claude"),
          unreadableProject,
        );
        const timeoutFiber = yield* probeClaudeSessionAvailability(
          probeInput("/claude"),
          hangingStore,
          5,
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust("5 millis");
        const timedOut = yield* Fiber.join(timeoutFiber);

        assert.equal(unreadable, "unknown");
        assert.equal(statFailed, "unknown");
        assert.equal(timedOut, "unknown");
      }),
    );

    it("resolves the config dir with the CLI's precedence", () => {
      assert.equal(
        resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: "/isolated/.claude", HOME: "/home/me" }),
        path.resolve("/isolated/.claude"),
      );
      assert.equal(
        resolveClaudeConfigDir({ HOME: "/home/me" }, undefined, "linux"),
        path.resolve("/home/me", ".claude"),
      );
      assert.equal(
        resolveClaudeConfigDir({ HOME: "" }, undefined, "linux"),
        path.join(os.homedir(), ".claude"),
      );
      assert.equal(resolveClaudeConfigDir({}), path.join(os.homedir(), ".claude"));
    });

    it("reads USERPROFILE instead of HOME for the default dir on Windows", () => {
      // Git Bash and MSYS set HOME, but the CLI's os.homedir() reads USERPROFILE.
      assert.equal(
        resolveClaudeConfigDir(
          { HOME: "/msys/home/me", USERPROFILE: "/users/me" },
          undefined,
          "win32",
        ),
        path.resolve("/users/me", ".claude"),
      );
      assert.equal(
        resolveClaudeConfigDir(
          { CLAUDE_CONFIG_DIR: "/isolated/.claude", USERPROFILE: "/users/me" },
          undefined,
          "win32",
        ),
        path.resolve("/isolated/.claude"),
      );
    });

    it("keeps CLAUDE_CONFIG_DIR as the CLI does, NFC-normalized and untrimmed", () => {
      const childCwd = path.resolve("/work/project");
      const decomposed = "/profiles/café/.claude";
      assert.equal(
        resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: decomposed }, childCwd),
        path.resolve(decomposed.normalize("NFC")),
      );
      assert.equal(
        resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: " spaced " }, childCwd),
        path.join(childCwd, " spaced "),
      );
    });

    it("resolves a relative config dir against the CLI child's cwd", () => {
      const childCwd = path.resolve("/work/project");
      assert.equal(
        resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: ".claude-profile" }, childCwd),
        path.join(childCwd, ".claude-profile"),
      );
      assert.equal(
        resolveClaudeConfigDir({ HOME: "relative-home" }, childCwd),
        path.join(childCwd, "relative-home", ".claude"),
      );
      assert.equal(
        resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: ".claude-profile" }),
        path.resolve(".claude-profile"),
      );
      assert.equal(
        resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: "/isolated/.claude" }, childCwd),
        path.resolve("/isolated/.claude"),
      );
    });

    it.effect("probes the provider environment's config dir, not the server's", () => {
      const probeCalls: Array<ClaudeSessionProbeInput> = [];
      const harness = makeHarness({
        processEnvironment: { CLAUDE_CONFIG_DIR: "/profiles/abc/provider-homes/claude/.claude" },
        probeResumableClaudeSession: (input) => {
          probeCalls.push(input);
          return Effect.succeed("present" as const);
        },
      });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: RESUME_THREAD_ID,
          provider: "claudeAgent",
          resumeCursor: { threadId: RESUME_THREAD_ID, resume: probeSessionId, turnCount: 2 },
          runtimeMode: "full-access",
        });

        assert.equal(probeCalls.length, 1);
        assert.equal(probeCalls[0]?.sessionId, probeSessionId);
        assert.equal(probeCalls[0]?.claudeConfigDir, "/profiles/abc/provider-homes/claude/.claude");
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("probes a relative config dir under the session cwd, not the server cwd", () => {
      const probeCalls: Array<ClaudeSessionProbeInput> = [];
      const sessionCwd = path.resolve("/work/project");
      const harness = makeHarness({
        processEnvironment: { CLAUDE_CONFIG_DIR: ".claude-local" },
        probeResumableClaudeSession: (input) => {
          probeCalls.push(input);
          return Effect.succeed("present" as const);
        },
      });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: RESUME_THREAD_ID,
          provider: "claudeAgent",
          cwd: sessionCwd,
          resumeCursor: { threadId: RESUME_THREAD_ID, resume: probeSessionId, turnCount: 2 },
          runtimeMode: "full-access",
        });

        assert.notEqual(process.cwd(), sessionCwd);
        assert.equal(probeCalls[0]?.claudeConfigDir, path.join(sessionCwd, ".claude-local"));
        const createInput = harness.getLastCreateQueryInput();
        assert.equal(createInput?.options.cwd, sessionCwd);
        assert.equal(createInput?.options.env?.CLAUDE_CONFIG_DIR, ".claude-local");
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("resumes a transcript stored under an isolated CLAUDE_CONFIG_DIR", () =>
      withClaudeConfigDir((configDir) => {
        writeTranscript(configDir, "-Users-me-project", probeSessionId);
        const harness = makeHarness({
          processEnvironment: { CLAUDE_CONFIG_DIR: configDir },
          probeResumableClaudeSession: (input) => probeClaudeSessionAvailability(input),
        });
        return Effect.gen(function* () {
          const adapter = yield* ClaudeAdapter;
          const session = yield* adapter.startSession({
            threadId: RESUME_THREAD_ID,
            provider: "claudeAgent",
            resumeCursor: { threadId: RESUME_THREAD_ID, resume: probeSessionId, turnCount: 3 },
            runtimeMode: "full-access",
          });

          const createInput = harness.getLastCreateQueryInput();
          assert.equal(createInput?.options.resume, probeSessionId);
          assert.equal(createInput?.options.sessionId, undefined);
          assert.equal((session.resumeCursor as Record<string, unknown>).turnCount, 3);
          const firstEvent = yield* Stream.runHead(adapter.streamEvents);
          assert.equal(firstEvent._tag, "Some");
          if (firstEvent._tag !== "Some" || firstEvent.value.type !== "session.started") {
            assert.fail("Expected session.started without a context reset warning.");
          }
          assert.deepEqual(firstEvent.value.payload, { resume: probeSessionId });
        }).pipe(
          Effect.provideService(Random.Random, makeDeterministicRandomService()),
          Effect.provide(harness.layer),
        );
      }),
    );
  });

  it.effect("surfaces a non-UUID resume cursor and starts fresh", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: "claudeAgent",
        resumeCursor: {
          threadId: RESUME_THREAD_ID,
          resume: "not-a-uuid",
          turnCount: 7,
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.resume, undefined);
      assert.equal(typeof createInput?.options.sessionId, "string");
      const warning = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(warning._tag, "Some");
      if (warning._tag === "Some" && warning.value.type === "runtime.warning") {
        assert.equal(warning.value.payload.category, "provider");
        assert.equal(warning.value.payload.actionable, true);
      } else {
        assert.fail("Expected the context reset warning before session startup events.");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("invalidates a rejected resume so the next start is fresh", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const attempted = "550e8400-e29b-41d4-a716-446655440000";
      const events: Array<ProviderRuntimeEvent> = [];
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: "claudeAgent",
        resumeCursor: {
          threadId: RESUME_THREAD_ID,
          resume: attempted,
          turnCount: 5,
          baseContextChars: 1_000,
          approximateConversationChars: 2_000,
          compactionRecommendationEmitted: true,
        },
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "continue",
        attachments: [],
      });
      harness.query.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: [`No conversation found with session ID: ${attempted}`],
        session_id: attempted,
        uuid: "resume-error-result",
      } as unknown as SDKMessage);
      harness.query.fail(new Error(`No conversation found with session ID: ${attempted}`));
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 25)));

      const completed = events.find((event) => event.type === "turn.completed");
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type !== "turn.completed") return;
      const cursor = completed.resumeCursor as Record<string, unknown>;
      assert.equal("resume" in cursor, false);
      assert.equal("sessionId" in cursor, false);
      assert.equal(cursor.turnCount, 0);
      assert.equal(cursor.baseContextChars, 0);
      assert.equal(cursor.approximateConversationChars, 0);
      assert.equal(cursor.compactionRecommendationEmitted, false);

      yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: "claudeAgent",
        resumeCursor: cursor,
        threadTitle: "Recovered thread",
        runtimeMode: "full-access",
      });
      const secondCreate = harness.getCreateQueryInputs()[1];
      assert.equal(secondCreate?.options.resume, undefined);
      assert.equal(typeof secondCreate?.options.sessionId, "string");
      assert.equal(
        typeof (
          secondCreate?.options as
            | (ClaudeQueryOptionsForTest & {
                systemPrompt?: { append: string };
              })
            | undefined
        )?.systemPrompt?.append,
        "string",
      );
      yield* Fiber.interrupt(eventFiber);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps a resume token after the resumed session is confirmed", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const attempted = "550e8400-e29b-41d4-a716-446655440000";
      const events: Array<ProviderRuntimeEvent> = [];
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: "claudeAgent",
        resumeCursor: { threadId: RESUME_THREAD_ID, resume: attempted },
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: RESUME_THREAD_ID,
        input: "continue",
        attachments: [],
      });
      harness.query.emit({
        type: "assistant",
        session_id: attempted,
        uuid: "confirmed-assistant",
        parent_tool_use_id: null,
        message: { id: "confirmed-message", content: [{ type: "text", text: "ready" }] },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: [`No conversation found with session ID: ${attempted}`],
        session_id: attempted,
        uuid: "confirmed-error-result",
      } as unknown as SDKMessage);
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

      const completed = events.findLast((event) => event.type === "turn.completed");
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal((completed.resumeCursor as { resume?: string }).resume, attempted);
      }
      yield* Fiber.interrupt(eventFiber);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("closes a mismatched resume and restarts next time with host instructions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const attempted = "550e8400-e29b-41d4-a716-446655440000";
      const reported = "550e8400-e29b-41d4-a716-446655440001";
      const events: Array<ProviderRuntimeEvent> = [];
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: "claudeAgent",
        resumeCursor: { threadId: RESUME_THREAD_ID, resume: attempted },
        runtimeMode: "full-access",
      });
      harness.query.emit({
        type: "system",
        subtype: "init",
        session_id: reported,
        uuid: "mismatched-init",
        model: "claude-opus-4-6",
      } as unknown as SDKMessage);
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.length, 0);
      assert.equal(harness.query.closeCalls, 1);
      const warning = events.find(
        (event) => event.type === "runtime.warning" && event.payload.category === "provider",
      );
      assert.equal(warning?.type, "runtime.warning");
      if (warning?.type === "runtime.warning") {
        assert.equal(warning.payload.actionable, true);
      }
      const exited = events.findLast((event) => event.type === "session.exited");
      assert.equal(exited?.type, "session.exited");
      if (exited?.type !== "session.exited") return;
      const cleanedCursor = exited.resumeCursor as Record<string, unknown>;
      assert.equal("resume" in cleanedCursor, false);

      yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: "claudeAgent",
        resumeCursor: cleanedCursor,
        threadTitle: "Recovered mismatch",
        runtimeMode: "full-access",
      });
      const replacementInput = harness.getCreateQueryInputs()[1];
      assert.equal(replacementInput?.options.resume, undefined);
      assert.equal(
        typeof (
          replacementInput?.options as
            | (ClaudeQueryOptionsForTest & { systemPrompt?: { append: string } })
            | undefined
        )?.systemPrompt?.append,
        "string",
      );
      yield* Fiber.interrupt(eventFiber);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("replaces a same-thread query atomically", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const events: Array<ProviderRuntimeEvent> = [];
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(Effect.forkChild);
      const first = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        resumeCursor: first.resumeCursor,
        runtimeMode: "full-access",
      });

      assert.equal(harness.query.closeCalls, 1);
      assert.equal(harness.queries.length, 2);
      assert.equal((yield* adapter.listSessions()).length, 1);

      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "replacement", attachments: [] });
      assert.equal(
        (yield* Effect.promise(() =>
          readFirstPromptText(harness.getCreateQueryInputs()[1]),
        ))?.endsWith("replacement"),
        true,
      );
      harness.query.fail(new Error("late old stream failure"));
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
      assert.equal((yield* adapter.listSessions()).length, 1);
      assert.equal(
        events.some((event) => event.type === "session.exited"),
        false,
      );
      yield* Fiber.interrupt(eventFiber);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores detached model metadata from a replaced session generation", () => {
    const harness = makeHarness();
    const oldCatalog = Promise.withResolvers<ReadonlyArray<unknown>>();
    harness.query.setSupportedModelsPromise(oldCatalog.promise);
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const events: Array<ProviderRuntimeEvent> = [];
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        runtimeMode: "full-access",
      });
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        runtimeMode: "full-access",
      });
      oldCatalog.resolve([
        {
          value: "claude-opus-4-6",
          capabilities: { max_input_tokens: 987_654 },
        },
      ]);
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

      const staleConfigured = events.some(
        (event) =>
          event.type === "session.configured" &&
          event.payload.config.modelContextWindowTokens === 987_654,
      );
      assert.equal(staleConfigured, false);
      assert.equal((yield* adapter.listSessions()).length, 1);
      yield* Fiber.interrupt(eventFiber);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("serializes concurrent starts for the same thread", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* Effect.all(
        [
          adapter.startSession({
            threadId: THREAD_ID,
            provider: "claudeAgent",
            runtimeMode: "full-access",
          }),
          adapter.startSession({
            threadId: THREAD_ID,
            provider: "claudeAgent",
            runtimeMode: "full-access",
          }),
        ],
        { concurrency: "unbounded" },
      );

      assert.equal(harness.queries.length, 2);
      assert.equal(
        harness.queries.reduce((sum, query) => sum + query.closeCalls, 0),
        1,
      );
      assert.equal((yield* adapter.listSessions()).length, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses an app-generated Claude session id for fresh sessions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      const sessionResumeCursor = session.resumeCursor as {
        threadId?: string;
        resume?: string;
        turnCount?: number;
      };
      assert.equal(sessionResumeCursor.threadId, THREAD_ID);
      assert.equal(typeof sessionResumeCursor.resume, "string");
      assert.equal(sessionResumeCursor.turnCount, 0);
      assert.match(
        sessionResumeCursor.resume ?? "",
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      assert.equal(createInput?.options.resume, undefined);
      assert.equal(createInput?.options.sessionId, sessionResumeCursor.resume);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("steers a live Claude prompt without replacing or completing its turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      const first = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "first",
        submissionSource: "human",
        attachments: [],
      });
      const rejected = yield* Effect.exit(
        adapter.sendTurn({ threadId: THREAD_ID, input: "another start", attachments: [] }),
      );
      assert.equal(rejected._tag, "Failure");
      const steered = yield* adapter.steerTurn!({
        threadId: THREAD_ID,
        input: "follow up",
        submissionSource: "human",
        attachments: [],
        expectedTurnId: first.turnId,
      });
      assert.equal(steered.turnId, first.turnId);
      assert.equal(harness.getCreateQueryInputs().length, 1);
      const prompts = harness.getLastCreateQueryInput()!.prompt[Symbol.asyncIterator]();
      const firstPrompt = (yield* Effect.promise(() => prompts.next())).value!;
      assert.deepEqual(firstPrompt.origin, { kind: "human" });
      assert.deepEqual(firstPrompt.message.content, [{ type: "text", text: "first" }]);
      const steerPrompt = (yield* Effect.promise(() => prompts.next())).value!;
      assert.deepEqual(steerPrompt.origin, { kind: "human" });
      assert.notEqual(firstPrompt.uuid, steerPrompt.uuid);
      assert.deepEqual(steerPrompt.message.content, [{ type: "text", text: "follow up" }]);
      const session = (yield* adapter.listSessions())[0]!;
      assert.equal(session.activeTurnId, first.turnId);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("preserves history when a retained Claude turn has no assistant boundary", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      for (const input of ["silent first", "second"]) {
        yield* adapter.sendTurn({ threadId: session.threadId, input, attachments: [] });
        const completed = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "turn.completed",
        ).pipe(Stream.runHead, Effect.forkChild);
        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "123e4567-e89b-42d3-a456-426614174000",
          uuid: `result-${input}`,
        } as unknown as SDKMessage);
        yield* Fiber.join(completed);
      }
      const queryInput = harness.getLastCreateQueryInput();
      const error = yield* adapter.rollbackThread(session.threadId, 1).pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.equal((yield* adapter.readThread(session.threadId)).turns.length, 2);
      assert.equal(harness.getLastCreateQueryInput(), queryInput);
      for (const count of [0, -1, 1.5]) {
        const invalid = yield* adapter.rollbackThread(session.threadId, count).pipe(Effect.flip);
        assert.equal(invalid._tag, "ProviderAdapterRequestError");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "supports rollbackThread by trimming in-memory turns and preserving earlier turns",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        const firstTurn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "first",
          attachments: [],
        });

        const firstCompletedFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "turn.completed",
        ).pipe(Stream.runHead, Effect.forkChild);

        harness.query.emit({
          type: "assistant",
          session_id: "123e4567-e89b-42d3-a456-426614174000",
          uuid: "123e4567-e89b-42d3-a456-426614174001",
          parent_tool_use_id: null,
          message: { id: "first-message", content: [{ type: "text", text: "first" }] },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "123e4567-e89b-42d3-a456-426614174000",
          uuid: "result-first",
        } as unknown as SDKMessage);

        const firstCompleted = yield* Fiber.join(firstCompletedFiber);
        assert.equal(firstCompleted._tag, "Some");
        if (firstCompleted._tag === "Some" && firstCompleted.value.type === "turn.completed") {
          assert.equal(String(firstCompleted.value.turnId), String(firstTurn.turnId));
        }

        const secondTurn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "second",
          attachments: [],
        });

        const secondCompletedFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "turn.completed",
        ).pipe(Stream.runHead, Effect.forkChild);

        harness.query.emit({
          type: "assistant",
          session_id: "123e4567-e89b-42d3-a456-426614174000",
          uuid: "123e4567-e89b-42d3-a456-426614174002",
          parent_tool_use_id: null,
          message: { id: "second-message", content: [{ type: "text", text: "second" }] },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "123e4567-e89b-42d3-a456-426614174000",
          uuid: "result-second",
        } as unknown as SDKMessage);

        const secondCompleted = yield* Fiber.join(secondCompletedFiber);
        assert.equal(secondCompleted._tag, "Some");
        if (secondCompleted._tag === "Some" && secondCompleted.value.type === "turn.completed") {
          assert.equal(String(secondCompleted.value.turnId), String(secondTurn.turnId));
        }

        const threadBeforeRollback = yield* adapter.readThread(session.threadId);
        assert.equal(threadBeforeRollback.turns.length, 2);

        const rolledBack = yield* adapter.rollbackThread(session.threadId, 1);
        assert.equal(rolledBack.turns.length, 1);
        assert.equal(rolledBack.turns[0]?.id, firstTurn.turnId);

        assert.equal(
          harness.getLastCreateQueryInput()?.options.resumeSessionAt,
          "123e4567-e89b-42d3-a456-426614174001",
        );
        const threadAfterRollback = yield* adapter.readThread(session.threadId);
        assert.equal(threadAfterRollback.turns.length, 1);
        assert.equal(threadAfterRollback.turns[0]?.id, firstTurn.turnId);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("updates model on sendTurn when model override is provided", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        model: "claude-opus-4-6",
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, ["claude-opus-4-6"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("canonicalizes Opus 5 aliases on follow-up setModel calls", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        model: "opus-5[1m]",
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, ["claude-opus-5"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("applies Opus 5 effort and Fast Mode when switching an active session", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-fable-5",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "switch",
        modelSelection: createModelSelection(ProviderInstanceId.make("claudeAgent"), "opus-5[1m]", [
          { id: "effort", value: "high" },
          { id: "fastMode", value: true },
        ]),
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, ["claude-opus-5"]);
      assert.deepEqual(harness.query.applyFlagSettingsCalls, [
        {
          effortLevel: "high",
          fastMode: true,
          alwaysThinkingEnabled: null,
        },
      ]);
      const promptText = yield* Effect.promise(() =>
        readFirstPromptText(harness.getLastCreateQueryInput()),
      );
      assert.match(promptText ?? "", /Active model: "claude-opus-5"/);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  function completeCostTurn(
    harness: ReturnType<typeof makeHarness>,
    total: number | undefined,
    failed = false,
  ) {
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "next", attachments: [] });
      harness.queries.at(-1)!.emit({
        type: "result",
        subtype: failed ? "error_during_execution" : "success",
        is_error: failed,
        errors: failed ? ["runtime crashed"] : [],
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        uuid: crypto.randomUUID(),
        ...(total !== undefined ? { total_cost_usd: total } : {}),
        modelUsage: {},
      } as unknown as SDKMessage);
      const events = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === (failed ? "session.exited" : "turn.completed")),
        Stream.runCollect,
      );
      const completed = events.find((event) => event.type === "turn.completed");
      if (!completed || completed.type !== "turn.completed") throw new Error("Missing completion");
      assert.equal(completed.raw, undefined);
      assert.deepEqual(completed.payload.modelUsage, {});
      if (failed) {
        // Failed processes are retired before another user turn is admitted.
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
          resumeCursor: completed.resumeCursor,
        });
      }
      return completed.payload.totalCostUsd;
    });
  }

  it.effect("resets explicit clear costs even when the new total exceeds the old total", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      assert.equal(yield* completeCostTurn(harness, 1), 1);
      harness.query.emit({
        type: "conversation_reset",
        trigger: "clear",
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        uuid: "clear-cost",
        new_conversation_id: "cleared",
      } as unknown as SDKMessage);
      yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "thread.state.changed"),
        Stream.take(1),
        Stream.runCollect,
      );
      assert.equal(yield* completeCostTurn(harness, 1.5), 1.5);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  for (const scenario of [
    { name: "free successful turns", totals: [0, 0.1], deltas: [0, 0.1] },
    {
      name: "startup crash placeholders",
      totals: [0, 0.1],
      deltas: [undefined, 0.1],
      failedIndex: 0,
    },
    { name: "rising and duplicated totals", totals: [0.1, 0.3, 0.3], deltas: [0.1, 0.2, 0] },
    { name: "positive resets after clear", totals: [0.3, 0.05, 0.1], deltas: [0.3, 0.05, 0.05] },
    {
      name: "zeroed error results",
      totals: [0.3, 0, 0.35],
      deltas: [0.3, undefined, 0.05],
      failedIndex: 1,
    },
    {
      name: "zeroed success-shaped crash results",
      totals: [0.3, 0, 0.35],
      deltas: [0.3, undefined, 0.05],
    },
    {
      name: "invalid or absent totals",
      totals: [0.3, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, 0.35],
      deltas: [0.3, undefined, undefined, undefined, undefined, 0.05],
    },
    {
      name: "positive costs on failed turns",
      totals: [0.3, 0.35, 0.4],
      deltas: [0.3, 0.05, 0.05],
      failedIndex: 1,
    },
  ]) {
    it.effect(`normalizes Claude costs for ${scenario.name}`, () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
          model: "claude-opus-5-5",
        });
        for (const [index, total] of scenario.totals.entries()) {
          const cost = yield* completeCostTurn(harness, total, scenario.failedIndex === index);
          assert.equal(cost, scenario.deltas[index], `result ${index}: cumulative ${total}`);
        }
      }).pipe(Effect.provide(harness.layer));
    });
  }

  it.effect("ignores orphaned duplicate results without emitting another completion", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      assert.equal(yield* completeCostTurn(harness, 0.3), 0.3);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        total_cost_usd: 0.3,
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "status",
        status: "requesting",
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        uuid: "after-duplicate",
      } as unknown as SDKMessage);
      const afterDuplicate = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "session.state.changed"),
        Stream.runCollect,
      );
      assert.equal(
        afterDuplicate.some((event) => event.type === "turn.completed"),
        false,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  for (const rpc of ["absent", "unsupported", "rejected", "pending", "invalid"] as const) {
    it.effect(`resumes without depending on a ${rpc} usage RPC`, () => {
      const harness = makeHarness();
      let calls = 0;
      if (rpc !== "absent")
        Object.assign(harness.query, {
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
            calls++;
            if (rpc === "pending") return new Promise(() => {});
            if (rpc === "invalid") return { session: { total_cost_usd: Number.NaN } };
            throw new Error(
              rpc === "unsupported"
                ? "Unsupported control request subtype: get_usage"
                : "Network unavailable",
            );
          },
        });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
          model: "claude-opus-4-8",
          resumeCursor: { resume: "550e8400-e29b-41d4-a716-446655440000" },
        });
        assert.equal(harness.query.closeCalls, 0);
        assert.equal(calls, 0);
        // Error zeros cannot establish a restored-session baseline either.
        assert.equal(yield* completeCostTurn(harness, 0, true), undefined);
        assert.equal(yield* completeCostTurn(harness, 4.85), undefined);
        assert.equal(yield* completeCostTurn(harness, 4.9), 0.05);
      }).pipe(Effect.provide(harness.layer));
    });
  }

  it.effect("handles legacy resumed queries whose cost total starts fresh", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        resumeCursor: { resume: "550e8400-e29b-41d4-a716-446655440000" },
      });
      assert.equal(yield* completeCostTurn(harness, 0.1), undefined);
      assert.equal(yield* completeCostTurn(harness, 0.3), 0.2);
    }).pipe(Effect.provide(harness.layer));
  });

  for (const resumedTotal of [0.35, 0.05]) {
    it.effect(`preserves cost on an effort-change restart with SDK total ${resumedTotal}`, () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const selection = (effort: string) =>
          createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-5-5", [
            { id: "effort", value: effort },
          ]);
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
          modelSelection: selection("medium"),
        });
        assert.equal(yield* completeCostTurn(harness, 0.3), 0.3);
        const sessions = yield* adapter.listSessions();
        const cursor = sessions[0]!.resumeCursor as Record<string, unknown>;
        assert.equal(cursor.lastTotalCostUsd, 0.3);
        // Match the reactor's restart path, including durable JSON serialization.
        const resumeCursor = JSON.parse(
          JSON.stringify({ ...cursor, resume: "550e8400-e29b-41d4-a716-446655440000" }),
        );
        yield* adapter.stopSession(THREAD_ID);
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
          modelSelection: selection("high"),
          resumeCursor,
        });
        assert.equal(harness.getLastCreateQueryInput()?.options.effort, "high");
        assert.equal(yield* completeCostTurn(harness, resumedTotal), 0.05);
      }).pipe(Effect.provide(harness.layer));
    });
  }

  it.effect("carries the cost baseline through a stopped session and ignores late results", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      assert.equal(yield* completeCostTurn(harness, 0.3), 0.3);
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "interrupt", attachments: [] });
      yield* adapter.interruptTurn(THREAD_ID);
      yield* TestClock.adjust("3 seconds");
      const interrupted = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead);
      assert.equal(interrupted._tag, "Some");
      if (interrupted._tag === "Some") {
        assert.equal(interrupted.value.payload.state, "interrupted");
        assert.equal(interrupted.value.payload.totalCostUsd, undefined);
      }
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        total_cost_usd: 0.35,
      } as unknown as SDKMessage);
      for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
      assert.equal(interrupted._tag, "Some");
      if (interrupted._tag !== "Some") return;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        resumeCursor: {
          ...(interrupted.value.resumeCursor as Record<string, unknown>),
          resume: "550e8400-e29b-41d4-a716-446655440000",
        },
      });
      assert.equal(harness.queries.length, 2);
      // The replacement process resumes the cumulative baseline, while a late
      // result from the closed process cannot be counted a second time.
      assert.equal(yield* completeCostTurn(harness, 0.4), 0.1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("starts a replacement fresh query with a zero cost baseline", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const input = {
        threadId: THREAD_ID,
        provider: "claudeAgent" as const,
        runtimeMode: "full-access" as const,
      };
      yield* adapter.startSession(input);
      assert.equal(yield* completeCostTurn(harness, 0.3), 0.3);
      yield* adapter.stopSession(THREAD_ID);
      yield* adapter.startSession(input);
      assert.equal(yield* completeCostTurn(harness, 0.4), 0.4);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("switches Haiku with thinking disabled to native Opus 5.5 and resumes", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const instance = ProviderInstanceId.make("claudeAgent");
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        modelSelection: createModelSelection(instance, "claude-haiku-4-5", [
          { id: "thinking", value: false },
        ]),
      });
      const initial = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "session.configured",
      ).pipe(Stream.take(1), Stream.runCollect);
      assert.deepEqual(harness.getLastCreateQueryInput()?.options.settings, {
        cleanupPeriodDays: 3650,
        alwaysThinkingEnabled: false,
      });
      assert.equal(
        initial.find((event) => event.type === "session.configured")?.payload.config
          .modelContextWindowTokens,
        200_000,
      );
      const selection = createModelSelection(instance, "opus[1m]", [
        { id: "contextWindow", value: "1m" },
        { id: "fastMode", value: true },
        { id: "thinking", value: false },
      ]);
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "switch",
        modelSelection: selection,
        attachments: [],
      });
      assert.deepEqual(harness.query.setModelCalls, ["claude-opus-5-5"]);
      assert.deepEqual(harness.query.applyFlagSettingsCalls, [
        { effortLevel: "medium", fastMode: true, alwaysThinkingEnabled: null },
      ]);
      const promptText = yield* Effect.promise(() =>
        readFirstPromptText(harness.getLastCreateQueryInput()),
      );
      assert.match(promptText ?? "", /Active model: "claude-opus-5-5"/);
      yield* adapter.stopSession(THREAD_ID);
      const resumed = yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        modelSelection: selection,
        resumeCursor: {
          threadId: THREAD_ID,
          resume: "550e8400-e29b-41d4-a716-446655440000",
          turnCount: 1,
        },
      });
      assert.equal(resumed.model, "claude-opus-5-5");
      assert.equal(harness.getLastCreateQueryInput()?.options.model, "claude-opus-5-5");
      const resumedConfig = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "session.configured",
      ).pipe(Stream.runHead);
      if (resumedConfig._tag === "Some") {
        assert.equal(resumedConfig.value.payload.config.context_window, undefined);
        assert.equal(resumedConfig.value.payload.config.effort, "medium");
        assert.equal(resumedConfig.value.payload.config.alwaysThinkingEnabled, undefined);
        assert.equal(resumedConfig.value.payload.config.modelContextWindowTokens, 1_000_000);
      }
      assert.equal(harness.getLastCreateQueryInput()?.options.effort, "medium");
      assert.equal(
        harness.getLastCreateQueryInput()?.options.resume,
        "550e8400-e29b-41d4-a716-446655440000",
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("switches Fable 5 at 200k to native 1M Fable 5.1, resumes, and switches back", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const instance = ProviderInstanceId.make("claudeAgent");
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        modelSelection: createModelSelection(instance, "claude-fable-5", [
          { id: "contextWindow", value: "200k" },
        ]),
      });
      const initial = yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runCollect);
      assert.equal(
        initial.find((event) => event.type === "session.configured")?.payload.config
          .modelContextWindowTokens,
        200_000,
      );
      const selection = createModelSelection(instance, "fable[200k]", [
        { id: "contextWindow", value: "200k" },
        { id: "fastMode", value: true },
        { id: "thinking", value: false },
      ]);
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "switch",
        modelSelection: selection,
        attachments: [],
      });
      assert.deepEqual(harness.query.setModelCalls, ["claude-fable-5-1"]);
      assert.deepEqual(harness.query.applyFlagSettingsCalls, [
        { effortLevel: "high", fastMode: false, alwaysThinkingEnabled: null },
      ]);
      const configured = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "session.configured",
      ).pipe(Stream.runHead);
      assert.equal(configured._tag, "Some");
      if (configured._tag === "Some") {
        assert.equal(configured.value.payload.config.model, "claude-fable-5-1");
        assert.equal(configured.value.payload.config.context_window, undefined);
        assert.equal(configured.value.payload.config.modelContextWindowTokens, 1_000_000);
      }
      yield* adapter.stopSession(THREAD_ID);
      const resumed = yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
        modelSelection: selection,
        resumeCursor: {
          threadId: THREAD_ID,
          resume: "550e8400-e29b-41d4-a716-446655440000",
          turnCount: 1,
        },
      });
      assert.equal(resumed.model, "claude-fable-5-1");
      assert.equal(harness.getLastCreateQueryInput()?.options.model, "claude-fable-5-1");
      const resumedConfig = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "session.configured",
      ).pipe(Stream.runHead);
      if (resumedConfig._tag === "Some") {
        assert.equal(resumedConfig.value.payload.config.context_window, undefined);
        assert.equal(resumedConfig.value.payload.config.modelContextWindowTokens, 1_000_000);
      }
      yield* adapter.sendTurn({
        threadId: RESUME_THREAD_ID,
        input: "switch back",
        attachments: [],
        modelSelection: createModelSelection(instance, "fable-5", [
          { id: "contextWindow", value: "200k" },
        ]),
      });
      const back = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "session.configured",
      ).pipe(Stream.runHead);
      assert.equal(back._tag, "Some");
      if (back._tag === "Some") {
        assert.equal(back.value.payload.config.model, "claude-fable-5");
        assert.equal(back.value.payload.config.context_window, "200k");
        assert.equal(back.value.payload.config.modelContextWindowTokens, 200_000);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("applies trait-only changes without restarting or resetting the model", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-5",
          [
            { id: "effort", value: "high" },
            { id: "fastMode", value: true },
          ],
        ),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "change traits",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-5",
          [
            { id: "effort", value: "low" },
            { id: "fastMode", value: false },
          ],
        ),
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, []);
      assert.deepEqual(harness.query.applyFlagSettingsCalls, [
        {
          effortLevel: "low",
          fastMode: false,
          alwaysThinkingEnabled: null,
        },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("sets Claude Code 1M model id on follow-up turns", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-fable-5",
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        model: "claude-fable-5",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-fable-5",
          [{ id: "contextWindow", value: "1m" }],
        ),
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, ["claude-fable-5[1m]"]);
      const configured = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(configured._tag, "Some");
      if (configured._tag === "Some" && configured.value.type === "session.configured") {
        assert.equal(configured.value.payload.config.context_window, "1m");
        assert.equal(configured.value.payload.config.modelContextWindowTokens, 1_000_000);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("preserves 1M context on model-only follow-up turns", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-fable-5",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-fable-5",
          [{ id: "contextWindow", value: "1m" }],
        ),
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        model: "claude-fable-5",
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, []);
      const nextEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(nextEvent._tag, "Some");
      if (nextEvent._tag === "Some") {
        assert.notEqual(nextEvent.value.type, "session.configured");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("honors follow-up model selections for non-default Claude instances", () => {
    const harness = makeHarness();
    const instanceId = ProviderInstanceId.make("claude_work");
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        providerInstanceId: instanceId,
        model: "claude-fable-5",
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        model: "claude-fable-5",
        modelSelection: createModelSelection(instanceId, "claude-fable-5", [
          { id: "contextWindow", value: "1m" },
        ]),
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, ["claude-fable-5[1m]"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not apply 1M suffix to models without context-window support", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-fable-5",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-fable-5",
          [{ id: "contextWindow", value: "1m" }],
        ),
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        model: "claude-haiku-4-5",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-haiku-4-5",
          [{ id: "contextWindow", value: "1m" }],
        ),
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, ["claude-haiku-4-5"]);
      const configured = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(configured._tag, "Some");
      if (configured._tag === "Some" && configured.value.type === "session.configured") {
        assert.equal(configured.value.payload.config.context_window, undefined);
        assert.equal(configured.value.payload.config.modelContextWindowTokens, 200_000);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("resets Claude Code model id to plain base model for follow-up 200k selection", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        model: "claude-fable-5",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-fable-5",
          [{ id: "contextWindow", value: "1m" }],
        ),
        runtimeMode: "full-access",
      });
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        model: "claude-fable-5",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-fable-5",
          [{ id: "contextWindow", value: "200k" }],
        ),
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, ["claude-fable-5"]);
      const configured = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(configured._tag, "Some");
      if (configured._tag === "Some" && configured.value.type === "session.configured") {
        assert.equal(configured.value.payload.config.context_window, "200k");
        assert.equal(configured.value.payload.config.modelContextWindowTokens, 200_000);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("sets plan permission mode on sendTurn when interactionMode is plan", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this for me",
        interactionMode: "plan",
        attachments: [],
      });

      assert.deepEqual(harness.query.setPermissionModeCalls, ["plan"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("restores base permission mode on sendTurn when interactionMode is default", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      // First turn in plan mode
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this",
        interactionMode: "plan",
        attachments: [],
      });

      // Complete the turn so we can send another
      const turnCompletedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-plan-restore",
        uuid: "result-plan",
      } as unknown as SDKMessage);

      yield* Fiber.join(turnCompletedFiber);

      // Second turn back to default
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "now do it",
        interactionMode: "default",
        attachments: [],
      });

      // First call sets "plan", second call restores "bypassPermissions" (the base for full-access)
      assert.deepEqual(harness.query.setPermissionModeCalls, ["plan", "bypassPermissions"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not call setPermissionMode when interactionMode is absent", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      assert.deepEqual(harness.query.setPermissionModeCalls, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("captures ExitPlanMode as a proposed plan and denies auto-exit", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this",
        interactionMode: "plan",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const permissionPromise = canUseTool(
        "ExitPlanMode",
        {
          plan: "# Ship it\n\n- one\n- two",
          allowedPrompts: [{ tool: "Bash", prompt: "run tests" }],
        },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-exit-1",
          requestId: "request-tool-exit-1",
        },
      );

      const proposedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(proposedEvent._tag, "Some");
      if (proposedEvent._tag !== "Some") {
        return;
      }
      assert.equal(proposedEvent.value.type, "turn.proposed.completed");
      if (proposedEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(proposedEvent.value.payload.planMarkdown, "# Ship it\n\n- one\n- two");
      assert.deepEqual(proposedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.makeUnsafe("tool-exit-1"),
      });

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "deny");
      const deniedResult = permissionResult as PermissionResult & {
        message?: string;
      };
      assert.equal(deniedResult.message?.includes("captured your proposed plan"), true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("extracts proposed plans from assistant ExitPlanMode snapshots", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this",
        interactionMode: "plan",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      const proposedEventFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.proposed.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-exit-plan",
        uuid: "assistant-exit-plan",
        parent_tool_use_id: null,
        message: {
          model: "claude-opus-4-6",
          id: "msg-exit-plan",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-exit-2",
              name: "ExitPlanMode",
              input: {
                plan: "# Final plan\n\n- capture it",
              },
            },
          ],
          stop_reason: null,
          stop_sequence: null,
          usage: {},
        },
      } as unknown as SDKMessage);

      const proposedEvent = yield* Fiber.join(proposedEventFiber);
      assert.equal(proposedEvent._tag, "Some");
      if (proposedEvent._tag !== "Some") {
        return;
      }
      assert.equal(proposedEvent.value.type, "turn.proposed.completed");
      if (proposedEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(proposedEvent.value.payload.planMarkdown, "# Final plan\n\n- capture it");
      assert.deepEqual(proposedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.makeUnsafe("tool-exit-2"),
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "turns a resume compaction dialog into blocking input and handles an already-aborted signal",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
          providerOptions: {
            claudeAgent: { resumeCompactionPrompt: true, autoCompactWindow: 120000 },
          },
        });
        yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);
        const options = harness.getLastCreateQueryInput()?.options as ClaudeQueryOptions;
        assert.deepEqual(options.supportedDialogKinds, ["resume_return"]);
        assert.equal(
          (options.settings as { autoCompactWindow?: number }).autoCompactWindow,
          120000,
        );
        const dialog = options.onUserDialog;
        assert.ok(dialog);
        const controller = new AbortController();
        controller.abort();
        const resultPromise = dialog(
          { dialogKind: "resume_return", payload: {} },
          { signal: controller.signal, requestId: "resume-dialog" },
        );
        const requested = yield* Stream.runHead(adapter.streamEvents);
        assert.equal(requested._tag, "Some");
        if (requested._tag === "Some") assert.equal(requested.value.type, "user-input.requested");
        assert.deepEqual(yield* Effect.promise(() => resultPromise), { behavior: "cancelled" });
        assert.deepEqual(
          yield* Effect.promise(() =>
            dialog(
              { dialogKind: "unknown", payload: {} },
              { signal: new AbortController().signal, requestId: "unknown-dialog" },
            ),
          ),
          { behavior: "cancelled" },
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("handles AskUserQuestion via user-input.requested/resolved lifecycle", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Start session in approval-required mode so canUseTool fires.
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });

      // Drain the session startup events (started, configured, state.changed).
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "question turn",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-user-input-1",
        uuid: "stream-user-input-thread",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-user-input-thread",
          },
        },
      } as unknown as SDKMessage);

      const threadStarted = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(threadStarted._tag, "Some");
      if (threadStarted._tag !== "Some" || threadStarted.value.type !== "thread.started") {
        return;
      }

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      // Simulate Claude calling AskUserQuestion with structured questions.
      const askInput = {
        questions: [
          {
            question: "Which framework?",
            header: "Framework",
            options: [
              { label: "React", description: "React.js" },
              { label: "Vue", description: "Vue.js" },
            ],
            multiSelect: false,
          },
        ],
      };

      const permissionPromise = canUseTool("AskUserQuestion", askInput, {
        signal: new AbortController().signal,
        toolUseID: "tool-ask-1",
        requestId: "request-tool-ask-1",
      });

      // The adapter should emit a user-input.requested event.
      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some") {
        return;
      }
      assert.equal(requestedEvent.value.type, "user-input.requested");
      if (requestedEvent.value.type !== "user-input.requested") {
        return;
      }
      const requestId = requestedEvent.value.requestId;
      assert.equal(typeof requestId, "string");
      assert.equal(requestedEvent.value.payload.questions.length, 1);
      assert.equal(requestedEvent.value.payload.questions[0]?.question, "Which framework?");
      // Regression for #2388: the UI's draft-answer key must match the
      // question text that Claude uses when rendering AskUserQuestion output.
      assert.equal(requestedEvent.value.payload.questions[0]?.id, "Which framework?");
      assert.deepEqual(requestedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.makeUnsafe("tool-ask-1"),
      });

      // Respond with the user's answers.
      yield* adapter.respondToUserInput(
        session.threadId,
        ApprovalRequestId.makeUnsafe(requestId!),
        { "Which framework?": "React" },
      );

      // The adapter should emit a user-input.resolved event.
      const resolvedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolvedEvent._tag, "Some");
      if (resolvedEvent._tag !== "Some") {
        return;
      }
      assert.equal(resolvedEvent.value.type, "user-input.resolved");
      if (resolvedEvent.value.type !== "user-input.resolved") {
        return;
      }
      assert.deepEqual(resolvedEvent.value.payload.answers, {
        "Which framework?": "React",
      });
      assert.deepEqual(resolvedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.makeUnsafe("tool-ask-1"),
      });

      // The canUseTool promise should resolve with the answers in SDK format.
      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
      const updatedInput = (permissionResult as { updatedInput: Record<string, unknown> })
        .updatedInput;
      assert.deepEqual(updatedInput.answers, { "Which framework?": "React" });
      // Original questions should be passed through.
      assert.deepEqual(updatedInput.questions, askInput.questions);

      const sdkAnswers = updatedInput.answers as Record<string, unknown>;
      const sdkQuestions = updatedInput.questions as ReadonlyArray<{
        readonly question: string;
      }>;

      // Older Claude CLIs iterated over answer entries directly.
      const keyAgnosticRendered = Object.entries(sdkAnswers)
        .map(([key, value]) => `"${key}"="${String(value)}"`)
        .join(", ");
      assert.equal(keyAgnosticRendered, '"Which framework?"="React"');

      // Newer Claude CLIs look answers up by the full question text.
      const questionLookupRendered = sdkQuestions
        .map(({ question }) => {
          const answer = sdkAnswers[question];
          return answer === undefined ? null : `"${question}"="${String(answer)}"`;
        })
        .filter((entry): entry is string => entry !== null)
        .join(", ");
      assert.notEqual(questionLookupRendered, "", "Expected non-empty AskUserQuestion result");
      assert.equal(questionLookupRendered, '"Which framework?"="React"');
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("routes AskUserQuestion through user-input flow even in full-access mode", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // In full-access mode, regular tools are auto-approved.
      // AskUserQuestion should still go through the user-input flow.
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const askInput = {
        questions: [
          {
            question: "Deploy to which env?",
            header: "Env",
            options: [
              { label: "Staging", description: "Staging environment" },
              { label: "Production", description: "Production environment" },
            ],
            multiSelect: false,
          },
        ],
      };

      const permissionPromise = canUseTool("AskUserQuestion", askInput, {
        signal: new AbortController().signal,
        toolUseID: "tool-ask-2",
        requestId: "request-tool-ask-2",
      });

      // Should still get user-input.requested even in full-access mode.
      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }
      const requestId = requestedEvent.value.requestId;

      yield* adapter.respondToUserInput(
        session.threadId,
        ApprovalRequestId.makeUnsafe(requestId!),
        { "Deploy to which env?": "Staging" },
      );

      // Drain the resolved event.
      yield* Stream.runHead(adapter.streamEvents);

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
      const updatedInput = (permissionResult as { updatedInput: Record<string, unknown> })
        .updatedInput;
      assert.deepEqual(updatedInput.answers, { "Deploy to which env?": "Staging" });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps AskUserQuestion answerable in an attended workflow stage", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // `merge` and `revision` stages run attended-readonly: the user is
      // watching and the workflow blocks on the answer, so the question must
      // reach a real reply path rather than being auto-declined.
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        interactionMode: "plan",
        workflowExecutionProfile: "attended-readonly",
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const askInput = {
        questions: [
          {
            question: "Which plan wins?",
            header: "Merge",
            options: [
              { label: "Plan A", description: "Take plan A" },
              { label: "Plan B", description: "Take plan B" },
            ],
            multiSelect: false,
          },
        ],
      };

      const permissionPromise = canUseTool("AskUserQuestion", askInput, {
        signal: new AbortController().signal,
        toolUseID: "tool-ask-attended",
        requestId: "request-tool-ask-attended",
      });

      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }
      const requestId = requestedEvent.value.requestId;

      // The request must be pending (answerable), not pre-resolved.
      yield* adapter.respondToUserInput(
        session.threadId,
        ApprovalRequestId.makeUnsafe(requestId!),
        { "Which plan wins?": "Plan A" },
      );
      yield* Stream.runHead(adapter.streamEvents);

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
      const updatedInput = (permissionResult as { updatedInput: Record<string, unknown> })
        .updatedInput;
      assert.deepEqual(updatedInput.answers, { "Which plan wins?": "Plan A" });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("pairs requested/resolved when auto-declining in an unattended stage", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        interactionMode: "plan",
        workflowExecutionProfile: "unattended-readonly",
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const result = yield* Effect.promise(() =>
        canUseTool(
          "AskUserQuestion",
          {
            questions: [
              {
                question: "Which plan wins?",
                header: "Merge",
                options: [{ label: "Plan A", description: "Take plan A" }],
                multiSelect: false,
              },
            ],
          },
          {
            signal: new AbortController().signal,
            toolUseID: "tool-ask-unattended",
            requestId: "request-tool-ask-unattended",
          },
        ),
      );

      // The deny message is the recovery path the model is expected to follow.
      assert.equal((result as PermissionResult).behavior, "deny");

      // Both events must be emitted so the timeline records what was asked and
      // the UI does not leave an unanswerable question card open.
      const events = yield* Stream.take(adapter.streamEvents, 2).pipe(Stream.runCollect);
      const emitted = Array.from(events);
      assert.equal(emitted[0]?.type, "user-input.requested");
      assert.equal(emitted[1]?.type, "user-input.resolved");
      assert.equal(emitted[0]?.requestId, emitted[1]?.requestId);
      assert.deepEqual((emitted[1] as { payload: { answers: unknown } }).payload.answers, {});
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("denies AskUserQuestion when the waiting turn is aborted", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const controller = new AbortController();
      const permissionPromise = canUseTool(
        "AskUserQuestion",
        {
          questions: [
            {
              question: "Continue?",
              header: "Continue",
              options: [{ label: "Yes", description: "Proceed" }],
              multiSelect: false,
            },
          ],
        },
        {
          signal: controller.signal,
          toolUseID: "tool-ask-abort",
          requestId: "request-tool-ask-abort",
        },
      );

      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }
      assert.equal(requestedEvent.value.threadId, session.threadId);

      controller.abort();

      const resolvedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolvedEvent._tag, "Some");
      if (resolvedEvent._tag !== "Some" || resolvedEvent.value.type !== "user-input.resolved") {
        assert.fail("Expected user-input.resolved event");
        return;
      }
      assert.deepEqual(resolvedEvent.value.payload.answers, {});

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.deepEqual(permissionResult, {
        behavior: "deny",
        message: "User cancelled tool execution.",
      } satisfies PermissionResult);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("writes provider-native observability records when enabled", () => {
    const nativeEvents: Array<{
      event?: {
        provider?: string;
        method?: string;
        threadId?: string;
        turnId?: string;
      };
    }> = [];
    const nativeThreadIds: Array<string | null> = [];
    const harness = makeHarness({
      nativeEventLogger: {
        filePath: "memory://claude-native-events",
        write: (event, threadId) => {
          nativeEvents.push(event as (typeof nativeEvents)[number]);
          nativeThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: "claudeAgent",
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const turnCompletedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-native-log",
        uuid: "stream-native-log",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "hi",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-native-log",
        uuid: "result-native-log",
      } as unknown as SDKMessage);

      const turnCompleted = yield* Fiber.join(turnCompletedFiber);
      assert.equal(turnCompleted._tag, "Some");

      assert.equal(nativeEvents.length > 0, true);
      assert.equal(
        nativeEvents.some((record) => record.event?.provider === "claudeAgent"),
        true,
      );
      assert.equal(
        nativeEvents.some(
          (record) =>
            String(
              (record.event as { readonly providerThreadId?: string } | undefined)
                ?.providerThreadId,
            ) === "sdk-session-native-log",
        ),
        true,
      );
      assert.equal(
        nativeEvents.some((record) => String(record.event?.turnId) === String(turn.turnId)),
        true,
      );
      assert.equal(
        nativeEvents.some(
          (record) => record.event?.method === "claude/stream_event/content_block_delta/text_delta",
        ),
        true,
      );
      assert.equal(
        nativeThreadIds.every((threadId) => threadId === String(THREAD_ID)),
        true,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  describe("interruptTurn", () => {
    it.effect("serializes Stop behind a send waiting for model setup", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const events: ProviderRuntimeEvent[] = [];
        const observer = yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          ),
          Effect.forkChild,
        );
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "approval-required",
        });
        let release!: () => void;
        harness.query.setModelWait = new Promise<void>((resolve) => {
          release = resolve;
        });
        const sending = yield* adapter
          .sendTurn({
            threadId: session.threadId,
            input: "work",
            attachments: [],
            model: "claude-opus-5",
          })
          .pipe(Effect.forkChild);
        while (!harness.query.setModelCalls.length) yield* Effect.yieldNow;
        const stopping = yield* adapter.interruptTurn(session.threadId).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        assert.equal(harness.query.closeCalls, 0);
        release();
        yield* Fiber.join(sending);
        yield* Fiber.join(stopping);
        yield* Effect.yieldNow;
        assert.equal(harness.query.closeCalls, 1);
        const started = events.findIndex((event) => event.type === "turn.started");
        const exited = events.findIndex((event) => event.type === "session.exited");
        assert.ok(started >= 0 && exited > started);
        yield* Fiber.interrupt(observer);
      }).pipe(Effect.provide(harness.layer));
    });

    it.effect("completes the turn as interrupted when the SDK emits a result", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const runtimeEventsFiber = Effect.runFork(
          Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => {
              runtimeEvents.push(event);
            }),
          ),
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        const turn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "write an essay",
          attachments: [],
        });

        yield* adapter.interruptTurn(session.threadId, turn.turnId);

        harness.query.emit({
          type: "result",
          subtype: "error_during_execution",
          is_error: false,
          errors: ["Error: Request was aborted."],
          stop_reason: "tool_use",
          session_id: "sdk-session-interrupt-1",
          uuid: "result-interrupt-1",
        } as unknown as SDKMessage);

        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        runtimeEventsFiber.interruptUnsafe();

        const turnCompleted = runtimeEvents.filter((event) => event.type === "turn.completed");
        assert.equal(turnCompleted.length, 1);
        const firstTurnCompleted = turnCompleted[0];
        if (firstTurnCompleted?.type === "turn.completed") {
          assert.equal(firstTurnCompleted.payload.state, "interrupted");
        }
        assert.equal(harness.query.interruptCalls.length, 0);
        assert.equal(harness.query.closeCalls, 1);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("cancels pending canUseTool approvals and returns deny when interrupted", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "approval-required",
        });

        yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

        const turn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "run this",
          attachments: [],
        });
        yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

        const createInput = harness.getLastCreateQueryInput();
        const canUseTool = createInput?.options.canUseTool;
        assert.equal(typeof canUseTool, "function");
        if (!canUseTool) {
          return;
        }

        const controller = new AbortController();
        const permissionPromise = canUseTool(
          "Bash",
          { command: "pwd" },
          {
            signal: controller.signal,
            toolUseID: "tool-interrupt-approval",
            requestId: "request-tool-interrupt-approval",
          },
        );

        const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
        assert.equal(requestedEvent._tag, "Some");
        if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "request.opened") {
          assert.fail("Expected request.opened event");
          return;
        }
        const requestId = requestedEvent.value.requestId;

        yield* adapter.interruptTurn(session.threadId, turn.turnId);

        const resolvedEvent = yield* Stream.runHead(adapter.streamEvents);
        assert.equal(resolvedEvent._tag, "Some");
        if (resolvedEvent._tag !== "Some" || resolvedEvent.value.type !== "request.resolved") {
          assert.fail("Expected request.resolved event");
          return;
        }
        assert.equal(resolvedEvent.value.requestId, requestId);
        assert.equal(resolvedEvent.value.payload.decision, "cancel");

        const permissionResult = yield* Effect.promise(() => permissionPromise);
        assert.equal((permissionResult as PermissionResult).behavior, "deny");
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("cancels pending AskUserQuestion interactions when interrupted", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });
        yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

        const turn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "need clarification",
          attachments: [],
        });
        yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

        const createInput = harness.getLastCreateQueryInput();
        const canUseTool = createInput?.options.canUseTool;
        assert.equal(typeof canUseTool, "function");
        if (!canUseTool) {
          return;
        }

        const askInput = {
          questions: [
            {
              question: "Which environment?",
              header: "Env",
              options: [
                { label: "Staging", description: "Staging" },
                { label: "Production", description: "Production" },
              ],
              multiSelect: false,
            },
          ],
        };

        const permissionPromise = canUseTool("AskUserQuestion", askInput, {
          signal: new AbortController().signal,
          toolUseID: "tool-interrupt-ask",
          requestId: "request-tool-interrupt-ask",
        });

        const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
        assert.equal(requestedEvent._tag, "Some");
        if (
          requestedEvent._tag !== "Some" ||
          requestedEvent.value.type !== "user-input.requested"
        ) {
          assert.fail("Expected user-input.requested event");
          return;
        }

        yield* adapter.interruptTurn(session.threadId, turn.turnId);

        const resolvedEvent = yield* Stream.runHead(adapter.streamEvents);
        assert.equal(resolvedEvent._tag, "Some");
        if (resolvedEvent._tag !== "Some" || resolvedEvent.value.type !== "user-input.resolved") {
          assert.fail("Expected user-input.resolved event");
          return;
        }
        assert.deepEqual(resolvedEvent.value.payload.answers, {});

        const permissionResult = yield* Effect.promise(() => permissionPromise);
        assert.equal((permissionResult as PermissionResult).behavior, "deny");
        assert.equal(
          (permissionResult as { message?: string }).message,
          "User cancelled tool execution.",
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("closes the runtime and completes the turn even when no result arrives", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const runtimeEventsFiber = Effect.runFork(
          Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => {
              runtimeEvents.push(event);
            }),
          ),
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hi",
          attachments: [],
        });

        yield* adapter.interruptTurn(session.threadId);

        // SDK never emits a result. Advance the TestClock past the watchdog.
        yield* TestClock.adjust("3 seconds");
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        runtimeEventsFiber.interruptUnsafe();

        const turnCompleted = runtimeEvents.filter((event) => event.type === "turn.completed");
        assert.equal(turnCompleted.length, 1);
        const firstTurnCompleted = turnCompleted[0];
        if (firstTurnCompleted?.type === "turn.completed") {
          assert.equal(firstTurnCompleted.payload.state, "interrupted");
          assert.equal(firstTurnCompleted.payload.errorMessage, "Session stopped.");
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("is idempotent for back-to-back interrupt calls", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const runtimeEventsFiber = Effect.runFork(
          Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => {
              runtimeEvents.push(event);
            }),
          ),
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hi",
          attachments: [],
        });

        yield* adapter.interruptTurn(session.threadId);
        yield* adapter.interruptTurn(session.threadId);

        harness.query.emit({
          type: "result",
          subtype: "error_during_execution",
          is_error: false,
          errors: ["Error: Request was aborted."],
          stop_reason: "tool_use",
          session_id: "sdk-session-idempotent",
          uuid: "result-idempotent",
        } as unknown as SDKMessage);

        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        runtimeEventsFiber.interruptUnsafe();

        assert.equal(harness.query.interruptCalls.length, 0);
        assert.equal(harness.query.closeCalls, 1);
        const turnCompleted = runtimeEvents.filter((event) => event.type === "turn.completed");
        assert.equal(turnCompleted.length, 1);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("closes an interrupted session and permits a follow-up in a new runtime", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = Effect.runFork(
          Stream.runForEach(adapter.streamEvents, () => Effect.void),
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "first",
          attachments: [],
        });
        yield* adapter.interruptTurn(session.threadId);
        harness.query.emit({
          type: "result",
          subtype: "error_during_execution",
          is_error: false,
          errors: ["Error: Request was aborted."],
          stop_reason: "tool_use",
          session_id: "sdk-session-reuse",
          uuid: "result-reuse",
        } as unknown as SDKMessage);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        assert.equal(yield* adapter.hasSession(session.threadId), false);
        assert.equal(harness.query.closeCalls, 1);
        yield* adapter.startSession({
          threadId: session.threadId,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        // A follow-up turn should succeed.
        const followUp = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "second",
          attachments: [],
        });
        assert.equal(followUp.threadId, session.threadId);

        runtimeEventsFiber.interruptUnsafe();
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });

    it.effect("suppresses buffered stream-event deltas after an interrupt request", () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const runtimeEventsFiber = Effect.runFork(
          Stream.runForEach(adapter.streamEvents, (event) =>
            Effect.sync(() => {
              runtimeEvents.push(event);
            }),
          ),
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hi",
          attachments: [],
        });

        yield* adapter.interruptTurn(session.threadId);

        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-interrupt-delta",
          uuid: "stream-interrupt-delta",
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "text_delta",
              text: "late-text",
            },
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "result",
          subtype: "error_during_execution",
          is_error: false,
          errors: ["Error: Request was aborted."],
          stop_reason: "tool_use",
          session_id: "sdk-session-interrupt-delta",
          uuid: "result-interrupt-delta",
        } as unknown as SDKMessage);

        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        runtimeEventsFiber.interruptUnsafe();

        const contentDeltaEvents = runtimeEvents.filter((event) => event.type === "content.delta");
        assert.equal(contentDeltaEvents.length, 0);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });
  });
});
