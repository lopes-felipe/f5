import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  OrchestrationProject,
  OrchestrationThread,
  OrchestrationCommand,
  QueueReasonCode,
  ProjectId,
  ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Stream } from "effect";

import { ServerConfig } from "../config.ts";
import { GitCoreLive } from "../git/Layers/GitCore.ts";
import { GitServiceLive } from "../git/Layers/GitService.ts";
import { NextTurnQueueStore } from "../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TerminalManager, type TerminalSessionSummary } from "../terminal/Services/Manager.ts";
import {
  type AutomaticThreadPurgeResult,
  type DatabaseSpaceResult,
  StorageMaintenance,
} from "./StorageMaintenance.ts";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** Mutable world the stubbed services read on every call. */
export interface AutomationWorld {
  projects: OrchestrationProject[];
  threads: OrchestrationThread[];
  terminals: TerminalSessionSummary[];
  sessions: Array<{ threadId: string; cwd: string; status: string }>;
  queuedThreadIds: Set<string>;
  queueStates: Map<
    string,
    {
      revision: number;
      paused: boolean;
      pauseReasonCode: QueueReasonCode | null;
      worktreeBlockToken: string | null;
    }
  >;
  /** Threads with a turn start accepted but not yet delivered to the provider. */
  pendingTurnStarts: Set<string>;
  /** Incremented on every read-model read, so race tests can tell when a pass reached removal. */
  readModelReads: number;
  /** Calls the worker made to the stubbed StorageMaintenance. */
  maintenanceCalls: Array<{ readonly method: string; readonly input: unknown }>;
  /** Result the stubbed `purgeThreads` returns. */
  purgeResult: AutomaticThreadPurgeResult;
  /** Result the stubbed `reclaimDatabaseSpace` returns. */
  spaceResult: DatabaseSpaceResult;
}

export const makeWorld = (): AutomationWorld => ({
  projects: [],
  threads: [],
  terminals: [],
  sessions: [],
  queuedThreadIds: new Set(),
  queueStates: new Map(),
  pendingTurnStarts: new Set(),
  readModelReads: 0,
  maintenanceCalls: [],
  purgeResult: { purgedThreadIds: [], archivedThreadIds: [], reclaimedBytes: 0, warnings: [] },
  spaceResult: { action: "none", reclaimedBytes: 0 },
});

export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=F5 Test", "-c", "user.email=f5@example.com", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

/** A bare `origin` with one commit on `main` and a clone of it as the project root. */
export async function makeClonedRepo(prefix: string) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  const seed = path.join(dir, "seed");
  await fs.mkdir(seed);
  git(seed, "init", "-q", "-b", "main");
  await fs.writeFile(path.join(seed, "README.md"), "hello\n");
  await fs.writeFile(path.join(seed, ".gitignore"), ".env\nnode_modules/\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  const origin = path.join(dir, "origin.git");
  git(dir, "clone", "-q", "--bare", seed, origin);
  const root = path.join(dir, "root");
  git(dir, "clone", "-q", origin, root);
  return {
    dir,
    origin,
    root,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

/** Push one more commit to `origin/main` from a separate clone. */
export async function pushUpstreamCommit(dir: string, origin: string, name: string) {
  const other = path.join(dir, `other-${name}`);
  git(dir, "clone", "-q", origin, other);
  await fs.writeFile(path.join(other, `${name}.txt`), `${name}\n`);
  git(other, "add", ".");
  git(other, "commit", "-q", "-m", name);
  git(other, "push", "-q", "origin", "main");
  return git(other, "rev-parse", "HEAD");
}

export const project = (id: string, workspaceRoot: string): OrchestrationProject =>
  ({
    id: id as ProjectId,
    title: `Project ${id}`,
    workspaceRoot,
    defaultModel: null,
    defaultModelSelection: null,
    defaultEnvMode: null,
    icon: null,
    scripts: [],
    memories: [],
    skills: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  }) as OrchestrationProject;

export const thread = (input: {
  id: string;
  projectId: string;
  worktreePath: string | null;
  branch?: string | null;
  lastInteractionAt?: string;
  deletedAt?: string | null;
}): OrchestrationThread =>
  ({
    id: input.id as ThreadId,
    projectId: input.projectId as ProjectId,
    worktreePath: input.worktreePath,
    branch: input.branch ?? null,
    lastInteractionAt: input.lastInteractionAt ?? new Date().toISOString(),
    deletedAt: input.deletedAt ?? null,
    session: null,
  }) as unknown as OrchestrationThread;

/**
 * Codex home the default test settings point at. Without it Codex resolves to
 * the developer's real `~/.codex`, which the marketplace staging sweep would scan.
 */
export const isolatedCodexHome = (prefix: string) =>
  path.join(os.tmpdir(), `${prefix}codex-home-${randomUUID()}`);

export function automationLayer(
  world: AutomationWorld,
  settings: DeepPartial<ServerSettings>,
  prefix: string,
) {
  const isolatedSettings: DeepPartial<ServerSettings> = {
    ...settings,
    providers: {
      ...settings.providers,
      codex: {
        homePath: isolatedCodexHome(prefix),
        ...settings.providers?.codex,
      },
    },
  };
  const engine = Layer.succeed(OrchestrationEngineService, {
    getReadModel: () =>
      Effect.sync(() => {
        world.readModelReads++;
        return { projects: world.projects, threads: world.threads } as never;
      }),
    dispatch: (command: OrchestrationCommand) =>
      Effect.sync(() => {
        if (command.type === "thread.meta.update")
          world.threads = world.threads.map((thread) =>
            thread.id === command.threadId
              ? {
                  ...thread,
                  ...(command.branch !== undefined ? { branch: command.branch } : {}),
                  ...(command.worktreePath !== undefined
                    ? { worktreePath: command.worktreePath }
                    : {}),
                }
              : thread,
          );
        return { sequence: 1 };
      }),
    streamDomainEvents: Stream.empty,
  } as never);
  const terminals = Layer.succeed(TerminalManager, {
    listSessions: Effect.sync(() => world.terminals),
    close: ({ threadId }: { threadId: string }) =>
      Effect.sync(() => {
        world.terminals = world.terminals.filter((terminal) => terminal.threadId !== threadId);
      }),
  } as never);
  const providers = Layer.succeed(ProviderService, {
    listSessions: () => Effect.sync(() => world.sessions),
    stopSession: ({ threadId }: { threadId: string }) =>
      Effect.sync(() => {
        world.sessions = world.sessions.filter((session) => session.threadId !== threadId);
      }),
  } as never);
  const queueState = (id: string) => {
    const state = world.queueStates.get(id) ?? {
      revision: 0,
      paused: false,
      pauseReasonCode: null,
      worktreeBlockToken: null,
    };
    world.queueStates.set(id, state);
    return state;
  };
  const queue = Layer.succeed(NextTurnQueueStore, {
    setWorktreeBlockToken: (input: {
      threadId: string;
      token: string | null;
      expectedToken?: string | null;
    }) =>
      Effect.sync(() => {
        const state = queueState(input.threadId);
        if (input.expectedToken === undefined || input.expectedToken === state.worktreeBlockToken) {
          state.worktreeBlockToken = input.token;
          state.revision++;
        }
      }),
    setPaused: (input: { threadId: string; paused: boolean; reasonCode?: QueueReasonCode }) =>
      Effect.sync(() => {
        const state = queueState(input.threadId);
        state.paused = input.paused;
        state.pauseReasonCode = input.reasonCode ?? null;
        state.revision++;
      }),
    readWorkspaceClaims: (threadIds: ReadonlyArray<ThreadId>) =>
      Effect.sync(() =>
        threadIds.map((threadId) => ({
          threadId,
          hasQueuedWork: world.queuedThreadIds.has(threadId),
          worktreeBlockToken: queueState(threadId).worktreeBlockToken,
        })),
      ),
    listByThread: (threadId: string) =>
      Effect.sync(() => ({
        items: world.queuedThreadIds.has(threadId) ? [{}] : [],
        state: queueState(threadId),
      })),
  } as never);
  const turns = Layer.succeed(ProjectionTurnRepository, {
    getPendingTurnStartByThreadId: ({ threadId }: { readonly threadId: string }) =>
      Effect.sync(() =>
        world.pendingTurnStarts.has(threadId) ? Option.some({ threadId }) : Option.none(),
      ),
  } as never);
  const call = <A>(method: string, input: unknown, result: () => A) =>
    Effect.sync(() => {
      world.maintenanceCalls.push({ method, input });
      return result();
    });
  const maintenance = Layer.succeed(StorageMaintenance, {
    purgeThreads: (input: unknown) => call("purgeThreads", input, () => world.purgeResult),
    reclaimDatabaseSpace: (input: unknown) =>
      call("reclaimDatabaseSpace", input, () => world.spaceResult),
    listTerminalThreadLogs: (input: unknown) => call("listTerminalThreadLogs", input, () => []),
    pruneTerminalThreadLogs: (input: unknown) =>
      call("pruneTerminalThreadLogs", input, () => ({
        categoryId: "providerLogsForTerminalThreads",
        status: "Skipped",
        reclaimedBytes: 0,
        perTargetReclaimed: [],
        warnings: [],
      })),
  } as never);
  return Layer.mergeAll(
    GitCoreLive.pipe(Layer.provideMerge(GitServiceLive)),
    engine,
    terminals,
    providers,
    queue,
    turns,
    maintenance,
    ServerSettingsService.layerTest(isolatedSettings as never),
    SqlitePersistenceMemory,
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(NodeServices.layer),
  );
}
