import fs from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";

import {
  PROJECT_SEARCH_CONTENTS_MAX_LIMIT,
  PROJECT_SEARCH_CONTENTS_MAX_MATCHES_PER_FILE,
  type ProjectSearchContentsInput,
  type ProjectSearchContentsResult,
} from "@t3tools/contracts";

import { createLogger } from "./logger";
import { PROJECT_CONTENT_SEARCH_WORKER_SOURCE } from "./projectContentSearchWorker";

export const PROJECT_CONTENT_SEARCH_ACTIVE_INDEX_LIMIT = 2;
export const PROJECT_CONTENT_SEARCH_INDEX_PATH_LIMIT = 25_000;
export const PROJECT_CONTENT_SEARCH_SCAN_TIMEOUT_MS = 15_000;
export const PROJECT_CONTENT_SEARCH_TIME_BUDGET_MS = 250;
export const PROJECT_CONTENT_SEARCH_IDLE_EVICTION_MS = 15 * 60_000;
export const PROJECT_CONTENT_SEARCH_RESCAN_AFTER_MS = 15_000;

const searchLogger = createLogger("projectContentSearch");

interface WorkerSearchResult {
  readonly matches: ProjectSearchContentsResult["matches"];
  readonly truncated: boolean;
  readonly indexedPathCount: number;
  readonly indexTruncated: boolean;
  readonly regexFallbackError?: string;
}

interface WorkerResponse {
  readonly id: number;
  readonly type: "result" | "error";
  readonly value?: unknown;
  readonly error?: string;
}

interface PendingWorkerCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface ContentWorkerClient {
  readonly call: <T>(message: Record<string, unknown>, timeoutMs: number) => Promise<T>;
  readonly terminate: (reason: Error) => Promise<void>;
  readonly isTerminated: () => boolean;
}

interface ContentIndexEntry {
  readonly rootPath: string;
  readonly rootAliases: Set<string>;
  readonly worker: ContentWorkerClient;
  initialized: boolean;
  invalidated: boolean;
  lastAccessedAt: number;
  lastScannedAt: number;
  pendingOperations: number;
  operationTail: Promise<void>;
}

interface ActiveSearch {
  readonly abortController: AbortController;
  entry: ContentIndexEntry | null;
  executing: boolean;
}

export class ProjectContentSearchError extends Error {
  readonly failure:
    | "cancelled"
    | "identity_not_found"
    | "invalid_workspace"
    | "scan_failed"
    | "search_failed";

  constructor(
    failure: ProjectContentSearchError["failure"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectContentSearchError";
    this.failure = failure;
  }
}

function cancellationError(): ProjectContentSearchError {
  return new ProjectContentSearchError("cancelled", "Project content search was cancelled.");
}

function makeWorkerClient(worker: Worker): ContentWorkerClient {
  let nextId = 1;
  let terminated = false;
  const pending = new Map<number, PendingWorkerCall>();

  const rejectPending = (error: Error) => {
    for (const [id, call] of pending) {
      clearTimeout(call.timeout);
      pending.delete(id);
      call.reject(error);
    }
  };

  worker.on("message", (message: WorkerResponse) => {
    if (!message || typeof message.id !== "number") return;
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timeout);
    if (message.type === "error") {
      call.reject(new Error(message.error ?? "Project content search worker failed."));
    } else {
      call.resolve(message.value);
    }
  });
  worker.on("error", (cause) => {
    terminated = true;
    rejectPending(cause);
  });
  worker.on("exit", (code) => {
    terminated = true;
    rejectPending(
      new Error(
        code === 0
          ? "Project content search worker exited."
          : `Project content search worker exited with code ${code}.`,
      ),
    );
  });

  return {
    isTerminated: () => terminated,
    call: <T>(message: Record<string, unknown>, timeoutMs: number): Promise<T> => {
      if (terminated) {
        return Promise.reject(new Error("Project content search worker was terminated."));
      }
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Project content search worker did not respond before its deadline."));
        }, timeoutMs);
        pending.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
          timeout,
        });
        worker.postMessage({ ...message, id });
      });
    },
    terminate: async (reason) => {
      if (terminated) return;
      terminated = true;
      rejectPending(reason);
      await worker.terminate();
    },
  };
}

function defaultWorkerFactory(): ContentWorkerClient {
  return makeWorkerClient(
    new Worker(PROJECT_CONTENT_SEARCH_WORKER_SOURCE, {
      eval: true,
      name: "f5-project-content-search",
    }),
  );
}

export interface ProjectContentSearchManager {
  readonly search: (input: {
    readonly requestKey: string;
    readonly workspaceRoot: string;
    readonly request: ProjectSearchContentsInput;
  }) => Promise<ProjectSearchContentsResult>;
  readonly cancel: (requestKey: string) => Promise<boolean>;
  readonly invalidateWorkspaceRoot: (workspaceRoot: string) => void;
  readonly dispose: () => Promise<void>;
}

export function makeProjectContentSearchManager(options?: {
  readonly now?: () => number;
  readonly workerFactory?: () => ContentWorkerClient;
}): ProjectContentSearchManager {
  const now = options?.now ?? Date.now;
  const workerFactory = options?.workerFactory ?? defaultWorkerFactory;
  const indexes = new Map<string, ContentIndexEntry>();
  const activeSearches = new Map<string, ActiveSearch>();
  const capacityWaiters = new Set<() => void>();
  let disposed = false;

  const signalCapacityChanged = () => {
    for (const resolve of capacityWaiters) resolve();
    capacityWaiters.clear();
  };

  const destroyEntry = async (entry: ContentIndexEntry, reason: Error): Promise<void> => {
    if (indexes.get(entry.rootPath) === entry) indexes.delete(entry.rootPath);
    await entry.worker.terminate(reason).catch(() => undefined);
    signalCapacityChanged();
  };

  const pruneIdleEntries = () => {
    const timestamp = now();
    for (const entry of indexes.values()) {
      if (
        entry.pendingOperations === 0 &&
        timestamp - entry.lastAccessedAt >= PROJECT_CONTENT_SEARCH_IDLE_EVICTION_MS
      ) {
        void destroyEntry(entry, new Error("Project content index was evicted after inactivity."));
      }
    }
  };

  const waitForCapacity = (signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(cancellationError());
        return;
      }
      const cleanup = () => {
        capacityWaiters.delete(onCapacity);
        signal.removeEventListener("abort", onAbort);
      };
      const onCapacity = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(cancellationError());
      };
      capacityWaiters.add(onCapacity);
      signal.addEventListener("abort", onAbort, { once: true });
    });

  const raceWithAbort = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(cancellationError());
        return;
      }
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      const onAbort = () => {
        cleanup();
        reject(cancellationError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void operation.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (cause) => {
          cleanup();
          reject(cause);
        },
      );
    });

  const acquireEntry = async (
    workspaceRoot: string,
    signal: AbortSignal,
  ): Promise<ContentIndexEntry> => {
    const rootPath = await fs.realpath(workspaceRoot).catch((cause) => {
      throw new ProjectContentSearchError(
        "invalid_workspace",
        "Registered project workspace is unavailable.",
        { cause },
      );
    });
    const stat = await fs.stat(rootPath).catch((cause) => {
      throw new ProjectContentSearchError(
        "invalid_workspace",
        "Registered project workspace is unavailable.",
        { cause },
      );
    });
    if (!stat.isDirectory()) {
      throw new ProjectContentSearchError(
        "invalid_workspace",
        "Registered project workspace is not a directory.",
      );
    }

    while (true) {
      if (signal.aborted) throw cancellationError();
      pruneIdleEntries();
      const existing = indexes.get(rootPath);
      if (existing && !existing.worker.isTerminated()) {
        existing.rootAliases.add(path.resolve(workspaceRoot));
        existing.lastAccessedAt = now();
        return existing;
      }
      if (existing) indexes.delete(rootPath);

      if (indexes.size >= PROJECT_CONTENT_SEARCH_ACTIVE_INDEX_LIMIT) {
        const idleEntry = [...indexes.values()]
          .filter((entry) => entry.pendingOperations === 0)
          .toSorted((left, right) => left.lastAccessedAt - right.lastAccessedAt)[0];
        if (idleEntry) {
          await destroyEntry(
            idleEntry,
            new Error("Project content index was evicted for another workspace."),
          );
          continue;
        }
        await waitForCapacity(signal);
        continue;
      }

      const entry: ContentIndexEntry = {
        rootPath,
        rootAliases: new Set([path.resolve(workspaceRoot), path.resolve(rootPath)]),
        worker: workerFactory(),
        initialized: false,
        invalidated: false,
        lastAccessedAt: now(),
        lastScannedAt: 0,
        pendingOperations: 0,
        operationTail: Promise.resolve(),
      };
      indexes.set(rootPath, entry);
      return entry;
    }
  };

  const enqueueOperation = <T>(
    entry: ContentIndexEntry,
    operation: () => Promise<T>,
  ): Promise<T> => {
    entry.pendingOperations += 1;
    const result = entry.operationTail.catch(() => undefined).then(operation);
    entry.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    void result.then(
      () => {
        entry.pendingOperations = Math.max(0, entry.pendingOperations - 1);
        entry.lastAccessedAt = now();
        signalCapacityChanged();
      },
      () => {
        entry.pendingOperations = Math.max(0, entry.pendingOperations - 1);
        entry.lastAccessedAt = now();
        signalCapacityChanged();
      },
    );
    return result;
  };

  const runSearch = async (
    state: ActiveSearch,
    workspaceRoot: string,
    request: ProjectSearchContentsInput,
  ): Promise<ProjectSearchContentsResult> => {
    if (state.abortController.signal.aborted) throw cancellationError();
    const entry = await acquireEntry(workspaceRoot, state.abortController.signal);
    state.entry = entry;
    let stage: "scan" | "search" = "scan";
    try {
      const result = await raceWithAbort(
        enqueueOperation(entry, async () => {
          if (state.abortController.signal.aborted) throw cancellationError();
          if (entry.worker.isTerminated()) {
            throw new Error("Project content index was replaced.");
          }
          state.executing = true;
          try {
            if (!entry.initialized) {
              await entry.worker.call(
                { type: "initialize", rootPath: entry.rootPath },
                PROJECT_CONTENT_SEARCH_SCAN_TIMEOUT_MS,
              );
              entry.initialized = true;
              entry.lastScannedAt = now();
            } else if (
              entry.invalidated ||
              now() - entry.lastScannedAt >= PROJECT_CONTENT_SEARCH_RESCAN_AFTER_MS
            ) {
              await entry.worker.call({ type: "refresh" }, PROJECT_CONTENT_SEARCH_SCAN_TIMEOUT_MS);
              entry.invalidated = false;
              entry.lastScannedAt = now();
            }

            stage = "search";
            return await entry.worker.call<WorkerSearchResult>(
              {
                type: "search",
                query: request.query,
                limit: Math.min(request.limit, PROJECT_SEARCH_CONTENTS_MAX_LIMIT),
                caseSensitive: request.caseSensitive,
                wholeWord: request.wholeWord,
                useRegex: request.useRegex,
              },
              PROJECT_CONTENT_SEARCH_TIME_BUDGET_MS,
            );
          } finally {
            state.executing = false;
          }
        }),
        state.abortController.signal,
      );
      return {
        requestId: request.requestId,
        matches: result.matches.slice(0, PROJECT_SEARCH_CONTENTS_MAX_LIMIT),
        truncated: result.truncated,
        indexedPathCount: Math.min(
          Math.max(0, result.indexedPathCount),
          PROJECT_CONTENT_SEARCH_INDEX_PATH_LIMIT,
        ),
        indexTruncated: result.indexTruncated,
        ...(result.regexFallbackError !== undefined
          ? { regexFallbackError: result.regexFallbackError }
          : {}),
      };
    } catch (cause) {
      if (state.abortController.signal.aborted) throw cancellationError();
      await destroyEntry(entry, new Error("Project content index failed and was replaced."));
      throw new ProjectContentSearchError(
        stage === "scan" ? "scan_failed" : "search_failed",
        stage === "scan" ? "Project content indexing failed." : "Project content search failed.",
        { cause },
      );
    } finally {
      state.entry = null;
      state.executing = false;
    }
  };

  const idleTimer = setInterval(pruneIdleEntries, 60_000);
  idleTimer.unref?.();

  return {
    search: async ({ requestKey, workspaceRoot, request }) => {
      if (disposed) {
        throw new ProjectContentSearchError("search_failed", "Project content search is stopped.");
      }
      const previous = activeSearches.get(requestKey);
      if (previous) {
        previous.abortController.abort();
        if (previous.executing && previous.entry) {
          await destroyEntry(previous.entry, cancellationError());
        }
      }
      const state: ActiveSearch = {
        abortController: new AbortController(),
        entry: null,
        executing: false,
      };
      activeSearches.set(requestKey, state);
      try {
        return await runSearch(state, workspaceRoot, request);
      } catch (cause) {
        if (!(cause instanceof ProjectContentSearchError && cause.failure === "cancelled")) {
          searchLogger.warn("Project content search failed", {
            projectId: request.projectId,
            threadId: request.threadId ?? null,
            cause: cause instanceof Error ? cause.message : String(cause),
          });
        }
        throw cause;
      } finally {
        if (activeSearches.get(requestKey) === state) activeSearches.delete(requestKey);
      }
    },
    cancel: async (requestKey) => {
      const state = activeSearches.get(requestKey);
      if (!state) return false;
      state.abortController.abort();
      if (state.executing && state.entry) {
        await destroyEntry(state.entry, cancellationError());
      }
      return true;
    },
    invalidateWorkspaceRoot: (workspaceRoot) => {
      const normalizedRoot = path.resolve(workspaceRoot);
      for (const entry of indexes.values()) {
        if (entry.rootAliases.has(normalizedRoot)) entry.invalidated = true;
      }
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      clearInterval(idleTimer);
      for (const state of activeSearches.values()) state.abortController.abort();
      activeSearches.clear();
      const activeIndexes = [...indexes.values()];
      indexes.clear();
      await Promise.all(
        activeIndexes.map((entry) =>
          entry.worker.terminate(new Error("Project content search manager stopped.")),
        ),
      );
      signalCapacityChanged();
    },
  };
}

export const PROJECT_CONTENT_SEARCH_RESULT_LIMIT = PROJECT_SEARCH_CONTENTS_MAX_LIMIT;
export const PROJECT_CONTENT_SEARCH_PER_FILE_LIMIT = PROJECT_SEARCH_CONTENTS_MAX_MATCHES_PER_FILE;
