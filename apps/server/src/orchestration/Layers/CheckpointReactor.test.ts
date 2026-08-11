import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ProviderRuntimeEvent, ProviderSession } from "@t3tools/contracts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CheckpointStore,
  type CheckpointStoreShape,
} from "../../checkpointing/Services/CheckpointStore.ts";
import { CheckpointInvariantError } from "../../checkpointing/Errors.ts";
import { CheckpointReactorLive } from "./CheckpointReactor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBusLive } from "./RuntimeReceiptBus.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { ServerConfig } from "../../config.ts";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: "codex";
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

function createProviderServiceHarness(
  cwd: string,
  hasSession = true,
  sessionCwd = cwd,
  providerName: ProviderSession["provider"] = "codex",
) {
  const now = new Date().toISOString();
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const rollbackConversation = vi.fn(
    (_input: { readonly threadId: ThreadId; readonly numTurns: number }) => Effect.void,
  );

  const unsupported = <A>() =>
    Effect.die(new Error("Unsupported provider call in test")) as Effect.Effect<A, never>;
  const listSessions = () =>
    hasSession
      ? Effect.succeed([
          {
            provider: providerName,
            status: "ready",
            runtimeMode: "full-access",
            threadId: ThreadId.makeUnsafe("thread-1"),
            cwd: sessionCwd,
            createdAt: now,
            updatedAt: now,
          },
        ] satisfies ReadonlyArray<ProviderSession>)
      : Effect.succeed([] as ReadonlyArray<ProviderSession>);
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions,
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    readThread: () => unsupported(),
    rollbackConversation,
    runOneOffPrompt: () => unsupported(),
    compactConversation: () => unsupported(),
    reloadMcpConfigForProject: () => unsupported(),
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  return {
    service,
    rollbackConversation,
    emit,
  };
}

async function waitForThread(
  engine: OrchestrationEngineShape,
  predicate: (thread: {
    latestTurn: { turnId: string } | null;
    checkpoints: ReadonlyArray<{ checkpointTurnCount: number }>;
    activities: ReadonlyArray<{ kind: string }>;
  }) => boolean,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<{
    latestTurn: { turnId: string } | null;
    checkpoints: ReadonlyArray<{ checkpointTurnCount: number }>;
    activities: ReadonlyArray<{ kind: string }>;
  }> => {
    const readModel = await Effect.runPromise(engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    if (thread && predicate(thread)) {
      return thread;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for thread state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

async function waitForEvent(
  engine: OrchestrationEngineShape,
  predicate: (event: { type: string }) => boolean,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async () => {
    const events = await Effect.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
    );
    if (events.some(predicate)) {
      return events;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for orchestration event.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

type WorkspaceSnapshot = ReadonlyMap<string, string>;

const fakeCheckpointSnapshots = new Map<string, Map<string, WorkspaceSnapshot>>();

function snapshotWorkspace(cwd: string): WorkspaceSnapshot {
  const snapshot = new Map<string, string>();
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (directory === cwd && entry.name === ".git") {
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile()) {
        snapshot.set(path.relative(cwd, absolutePath), fs.readFileSync(absolutePath, "utf8"));
      }
    }
  };
  visit(cwd);
  return snapshot;
}

function restoreWorkspace(cwd: string, snapshot: WorkspaceSnapshot): void {
  for (const entry of fs.readdirSync(cwd, { withFileTypes: true })) {
    if (entry.name !== ".git") {
      fs.rmSync(path.join(cwd, entry.name), { recursive: true, force: true });
    }
  }
  for (const [relativePath, contents] of snapshot) {
    const absolutePath = path.join(cwd, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, contents, "utf8");
  }
}

function createUnifiedDiff(before: WorkspaceSnapshot, after: WorkspaceSnapshot): string {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .toSorted()
    .flatMap((filePath) => {
      const oldContents = before.get(filePath) ?? "";
      const newContents = after.get(filePath) ?? "";
      if (oldContents === newContents) {
        return [];
      }
      const oldLines = oldContents.split("\n").filter((line, index, lines) => {
        return index < lines.length - 1 || line.length > 0;
      });
      const newLines = newContents.split("\n").filter((line, index, lines) => {
        return index < lines.length - 1 || line.length > 0;
      });
      return [
        `diff --git a/${filePath} b/${filePath}`,
        `--- a/${filePath}`,
        `+++ b/${filePath}`,
        `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
        ...oldLines.map((line) => `-${line}`),
        ...newLines.map((line) => `+${line}`),
      ];
    })
    .join("\n");
}

const fakeCheckpointStore: CheckpointStoreShape = {
  isGitRepository: (cwd) => Effect.succeed(fs.existsSync(path.join(cwd, ".git"))),
  captureCheckpoint: ({ cwd, checkpointRef }) =>
    Effect.sync(() => {
      const snapshots = fakeCheckpointSnapshots.get(cwd) ?? new Map();
      snapshots.set(checkpointRef, snapshotWorkspace(cwd));
      fakeCheckpointSnapshots.set(cwd, snapshots);
    }),
  hasCheckpointRef: ({ cwd, checkpointRef }) =>
    Effect.succeed(fakeCheckpointSnapshots.get(cwd)?.has(checkpointRef) ?? false),
  restoreCheckpoint: ({ cwd, checkpointRef }) =>
    Effect.sync(() => {
      const snapshot = fakeCheckpointSnapshots.get(cwd)?.get(checkpointRef);
      if (!snapshot) {
        return false;
      }
      restoreWorkspace(cwd, snapshot);
      return true;
    }),
  diffCheckpoints: ({ cwd, fromCheckpointRef, toCheckpointRef }) =>
    Effect.gen(function* () {
      const snapshots = fakeCheckpointSnapshots.get(cwd);
      const before = snapshots?.get(fromCheckpointRef);
      const after = snapshots?.get(toCheckpointRef);
      if (!before || !after) {
        return yield* new CheckpointInvariantError({
          operation: "fakeCheckpointStore.diffCheckpoints",
          detail: `Missing checkpoint ${!before ? fromCheckpointRef : toCheckpointRef}.`,
        });
      }
      return createUnifiedDiff(before, after);
    }),
  deleteCheckpointRefs: ({ cwd, checkpointRefs }) =>
    Effect.sync(() => {
      const snapshots = fakeCheckpointSnapshots.get(cwd);
      for (const checkpointRef of checkpointRefs) {
        snapshots?.delete(checkpointRef);
      }
    }),
};

function createGitRepository() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "t3-checkpoint-handler-"));
  fs.mkdirSync(path.join(cwd, ".git"));
  fs.writeFileSync(path.join(cwd, "README.md"), "v1\n", "utf8");
  return cwd;
}

function gitRefExists(cwd: string, ref: string): boolean {
  return fakeCheckpointSnapshots.get(cwd)?.has(ref) ?? false;
}

function gitShowFileAtRef(cwd: string, ref: string, filePath: string): string {
  const contents = fakeCheckpointSnapshots.get(cwd)?.get(ref)?.get(filePath);
  if (contents === undefined) {
    throw new Error(`Missing fake checkpoint file ${ref}:${filePath}.`);
  }
  return contents;
}

async function waitForGitFileAtRefContent(
  cwd: string,
  ref: string,
  filePath: string,
  expected: string,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastObserved = "<unread>";
  const poll = async (): Promise<void> => {
    try {
      lastObserved = gitShowFileAtRef(cwd, ref, filePath);
      if (lastObserved === expected) {
        return;
      }
    } catch (error) {
      lastObserved = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${ref}:${filePath} to equal ${JSON.stringify(expected)}. Last observed: ${JSON.stringify(lastObserved)}.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

async function waitForGitRefExists(cwd: string, ref: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (gitRefExists(cwd, ref)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for git ref '${ref}'.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

describe("CheckpointReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | CheckpointReactor | CheckpointStore,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    fakeCheckpointSnapshots.clear();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  async function createHarness(options?: {
    readonly hasSession?: boolean;
    readonly seedFilesystemCheckpoints?: boolean;
    readonly projectWorkspaceRoot?: string;
    readonly threadWorktreePath?: string | null;
    readonly providerSessionCwd?: string;
    readonly stallStartupQuiescence?: boolean;
  }) {
    const cwd = createGitRepository();
    tempDirs.push(cwd);
    const provider = createProviderServiceHarness(
      cwd,
      options?.hasSession ?? true,
      options?.providerSessionCwd ?? cwd,
      "codex",
    );
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
    );

    const layer = CheckpointReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(RuntimeReceiptBusLive),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(Layer.succeed(CheckpointStore, fakeCheckpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionTurnRepository, {
          listTerminalUnquiesced: options?.stallStartupQuiescence
            ? Effect.never
            : Effect.succeed([]),
        } as never),
      ),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const reactor = await runtime.runPromise(Effect.service(CheckpointReactor));
    const checkpointStore = await runtime.runPromise(Effect.service(CheckpointStore));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start.pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(reactor.drain);

    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Test Project",
        workspaceRoot: options?.projectWorkspaceRoot ?? cwd,
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        model: "gpt-5-codex",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: options?.threadWorktreePath ?? cwd,
        createdAt,
      }),
    );

    if (options?.seedFilesystemCheckpoints ?? true) {
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
        }),
      );
      fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        }),
      );
      fs.writeFileSync(path.join(cwd, "README.md"), "v3\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 2),
        }),
      );
    }

    return {
      engine,
      provider,
      cwd,
      drain,
    };
  }

  it("does not block readiness on startup quiescence recovery", async () => {
    const harness = await createHarness({ stallStartupQuiescence: true });
    const readModel = await Effect.runPromise(harness.engine.getReadModel());

    expect(readModel.threads.some((thread) => thread.id === "thread-1")).toBe(true);
  });

  it("captures pre-turn baseline on turn.started and post-turn checkpoint on turn.completed", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-capture"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-1"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-1"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-1"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.engine,
      (entry) => entry.latestTurn?.turnId === "turn-1" && entry.checkpoints.length === 1,
    );
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0)),
    ).toBe(true);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1)),
    ).toBe(true);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
        "README.md",
      ),
    ).toBe("v1\n");
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        "README.md",
      ),
    ).toBe("v2\n");
  });

  it("captures and quiesces from the durable domain completion path without turn.completed", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId("turn-domain-only");
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-domain-only-started"),
      provider: "codex",
      createdAt: "2026-04-23T10:00:00.000Z",
      threadId,
      turnId,
    });
    await waitForGitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 0));
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "domain-only\n", "utf8");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-domain-only-placeholder"),
        threadId,
        turnId,
        completedAt: "2026-04-23T10:00:01.000Z",
        checkpointRef: checkpointRefForThreadTurn(threadId, 1),
        status: "missing",
        files: [],
        checkpointTurnCount: 1,
        assistantMessageId: MessageId.makeUnsafe("assistant-domain-only"),
        createdAt: "2026-04-23T10:00:01.000Z",
      }),
    );

    const events = await waitForEvent(
      harness.engine,
      (event) => event.type === "thread.turn-processing-quiesced",
    );
    const eventTypes = events.map((event) => event.type);
    expect(eventTypes).toContain("thread.turn-diff-completed");
    expect(eventTypes).toContain("thread.activity-appended");
    expect(eventTypes).toContain("thread.turn-processing-quiesced");
    expect(eventTypes.indexOf("thread.turn-processing-quiesced")).toBeGreaterThan(
      eventTypes.lastIndexOf("thread.activity-appended"),
    );
    expect(
      gitShowFileAtRef(harness.cwd, checkpointRefForThreadTurn(threadId, 1), "README.md"),
    ).toBe("domain-only\n");
  });

  it("refreshes the same turn checkpoint when a missing placeholder is re-emitted mid-turn", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-refresh"),
      provider: "codex",
      createdAt: "2026-04-23T10:00:00.000Z",
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-refresh"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-turn-refresh-placeholder-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-refresh"),
        completedAt: "2026-04-23T10:00:01.000Z",
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        status: "missing",
        files: [],
        checkpointTurnCount: 1,
        assistantMessageId: MessageId.makeUnsafe("assistant-refresh"),
        createdAt: "2026-04-23T10:00:01.000Z",
      }),
    );

    await waitForGitFileAtRefContent(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
      "README.md",
      "v2\n",
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v3\n", "utf8");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-turn-refresh-placeholder-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-refresh"),
        completedAt: "2026-04-23T10:00:02.000Z",
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        status: "missing",
        files: [],
        checkpointTurnCount: 1,
        assistantMessageId: MessageId.makeUnsafe("assistant-refresh"),
        createdAt: "2026-04-23T10:00:02.000Z",
      }),
    );

    await waitForGitFileAtRefContent(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
      "README.md",
      "v3\n",
    );

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.latestTurn?.turnId === "turn-refresh" &&
        entry.checkpoints.length === 1 &&
        entry.checkpoints[0]?.checkpointTurnCount === 1,
    );
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
  });

  it("ignores auxiliary thread turn completion while primary turn is active", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-primary-running"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-main"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-main"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-main"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-aux"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-aux"),
      payload: { state: "completed" },
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(midThread?.checkpoints).toHaveLength(0);

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-main"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-main"),
      payload: { state: "completed" },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) => entry.latestTurn?.turnId === "turn-main" && entry.checkpoints.length === 1,
    );
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
  });

  it("appends capture failure activity when turn diff summary cannot be derived", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-missing-baseline-diff"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-missing-baseline"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-missing-baseline"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.checkpoints.length === 1 &&
        entry.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    );

    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      thread.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    ).toBe(true);
  });

  it("captures pre-turn baseline from project workspace root when thread worktree is unset", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-for-baseline"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: MessageId.makeUnsafe("message-user-1"),
          role: "user",
          text: "start turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );

    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
    );
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
        "README.md",
      ),
    ).toBe("v1\n");
  });

  it("captures turn completion checkpoint from project workspace root when provider session cwd is unavailable", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-missing-provider-cwd"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-missing-cwd"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-missing-provider-cwd"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-missing-cwd"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1)),
    ).toBe(true);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        "README.md",
      ),
    ).toBe("v2\n");
  });

  it("ignores non-v2 checkpoint.captured runtime events", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-checkpoint-captured"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "checkpoint.captured",
      eventId: EventId.makeUnsafe("evt-checkpoint-captured-3"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-3"),
      turnCount: 3,
      status: "completed",
    });

    await harness.drain();
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 3)).toBe(
      false,
    );
  });

  it("continues processing runtime events after a single checkpoint runtime failure", async () => {
    const nonRepositorySessionCwd = fs.mkdtempSync(
      path.join(os.tmpdir(), "t3-checkpoint-runtime-non-repo-"),
    );
    tempDirs.push(nonRepositorySessionCwd);

    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerSessionCwd: nonRepositorySessionCwd,
    });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-non-repo-runtime"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-runtime-capture-failure"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-runtime-failure"),
      payload: { state: "completed" },
    });

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-after-runtime-failure"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-after-runtime-failure"),
    });

    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
    );
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0)),
    ).toBe(true);
  });

  it("executes provider revert and emits thread.reverted for checkpoint revert requests", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-diff-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-diff-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-revert-request"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    const thread = await waitForThread(harness.engine, (entry) => entry.checkpoints.length === 1);

    expect(thread.latestTurn?.turnId).toBe("turn-1");
    expect(thread.checkpoints).toHaveLength(1);
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
      numTurns: 1,
    });
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 2)),
    ).toBe(false);
  });

  it("processes consecutive revert requests with deterministic rollback sequencing", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-inline-revert"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-inline-revert-diff-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-inline-revert-diff-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-sequenced-revert-request-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-sequenced-revert-request-0"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 0,
        createdAt,
      }),
    );

    const deadline = Date.now() + 2000;
    const waitForRollbackCalls = async (): Promise<void> => {
      if (harness.provider.rollbackConversation.mock.calls.length >= 2) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for rollbackConversation calls.");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      return waitForRollbackCalls();
    };
    await waitForRollbackCalls();

    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(2);
    expect(harness.provider.rollbackConversation.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.makeUnsafe("thread-1"),
      numTurns: 1,
    });
    expect(harness.provider.rollbackConversation.mock.calls[1]?.[0]).toEqual({
      threadId: ThreadId.makeUnsafe("thread-1"),
      numTurns: 1,
    });
  });

  it("appends an error activity when revert is requested without an active session", async () => {
    const harness = await createHarness({ hasSession: false });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-revert-no-session"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(thread.activities.some((activity) => activity.kind === "checkpoint.revert.failed")).toBe(
      true,
    );
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
  });
});
