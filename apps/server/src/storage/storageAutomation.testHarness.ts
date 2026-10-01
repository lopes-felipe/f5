import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  OrchestrationProject,
  OrchestrationThread,
  ProjectId,
  ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Layer, Stream } from "effect";

import { ServerConfig } from "../config.ts";
import { GitCoreLive } from "../git/Layers/GitCore.ts";
import { GitServiceLive } from "../git/Layers/GitService.ts";
import { NextTurnQueueStore } from "../nextTurnQueue/Services/NextTurnQueueStore.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TerminalManager, type TerminalSessionSummary } from "../terminal/Services/Manager.ts";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** Mutable world the stubbed services read on every call. */
export interface AutomationWorld {
  projects: OrchestrationProject[];
  threads: OrchestrationThread[];
  terminals: TerminalSessionSummary[];
  sessions: Array<{ threadId: string; cwd: string; status: string }>;
  queuedThreadIds: Set<string>;
  /** Incremented on every read-model read, so race tests can tell when a pass reached removal. */
  readModelReads: number;
}

export const makeWorld = (): AutomationWorld => ({
  projects: [],
  threads: [],
  terminals: [],
  sessions: [],
  queuedThreadIds: new Set(),
  readModelReads: 0,
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

export function automationLayer(
  world: AutomationWorld,
  settings: DeepPartial<ServerSettings>,
  prefix: string,
) {
  const engine = Layer.succeed(OrchestrationEngineService, {
    getReadModel: () =>
      Effect.sync(() => {
        world.readModelReads++;
        return { projects: world.projects, threads: world.threads } as never;
      }),
    streamDomainEvents: Stream.empty,
  } as never);
  const terminals = Layer.succeed(TerminalManager, {
    listSessions: Effect.sync(() => world.terminals),
  } as never);
  const providers = Layer.succeed(ProviderService, {
    listSessions: () => Effect.sync(() => world.sessions),
  } as never);
  const queue = Layer.succeed(NextTurnQueueStore, {
    listByThread: (threadId: string) =>
      Effect.sync(() => ({ items: world.queuedThreadIds.has(threadId) ? [{}] : [] })),
  } as never);
  return Layer.mergeAll(
    GitCoreLive.pipe(Layer.provideMerge(GitServiceLive)),
    engine,
    terminals,
    providers,
    queue,
    ServerSettingsService.layerTest(settings as never),
    SqlitePersistenceMemory,
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(NodeServices.layer),
  );
}
