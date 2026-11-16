import {
  CheckpointRef,
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProjectSetWatchedPathsInput,
  type ProjectWatchedPathsChangedPayload,
} from "@t3tools/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  noteWsConnectionClosed,
  noteWsConnectionOpened,
  resetWsConnectionStateForTests,
} from "../wsConnectionState";
import { projectQueryKeys } from "./projectReactQuery";
import { providerQueryKeys } from "./providerReactQuery";
import {
  invalidateWorkspaceForEvent,
  isWorkspaceEffectEvent,
  type ThreadWorkspace,
} from "./workspaceInvalidation";
import {
  isWorkspaceWatchReliable,
  resetWorkspaceWatchForTests,
  retainWatchedWorkspacePath,
  startWorkspaceWatchSync,
} from "./workspaceWatch";

const api = vi.hoisted(() => ({
  setWatchedPaths: vi.fn(),
  changeListeners: new Set<(payload: ProjectWatchedPathsChangedPayload) => void>(),
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    projects: {
      setWatchedPaths: api.setWatchedPaths,
      onWatchedPathsChanged: (listener: (payload: ProjectWatchedPathsChangedPayload) => void) => {
        api.changeListeners.add(listener);
        return () => api.changeListeners.delete(listener);
      },
    },
  }),
}));

const CWD = "/repo/project";
const OTHER_CWD = "/repo/other";
const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const THREAD_ID = ThreadId.makeUnsafe("thread-1");

function lastSync(): ProjectSetWatchedPathsInput | undefined {
  return api.setWatchedPaths.mock.calls.at(-1)?.[0];
}

function seedQueries(queryClient: QueryClient) {
  const keys = {
    appFile: providerQueryKeys.fileContent({ cwd: CWD, relativePath: "src/app.ts" }),
    otherFile: providerQueryKeys.fileContent({ cwd: CWD, relativePath: "src/other.ts" }),
    otherWorkspaceFile: providerQueryKeys.fileContent({ cwd: OTHER_CWD, relativePath: "a.ts" }),
    rootListing: projectQueryKeys.listDirectory(CWD, "", false, 5_000),
    srcListing: projectQueryKeys.listDirectory(CWD, "src", false, 5_000),
    otherWorkspaceListing: projectQueryKeys.listDirectory(OTHER_CWD, "", false, 5_000),
    search: projectQueryKeys.searchEntries(CWD, "app", 100),
  };
  for (const key of Object.values(keys)) queryClient.setQueryData(key, { seeded: true });
  const invalidated = (key: readonly unknown[]) =>
    queryClient.getQueryState(key)?.isInvalidated ?? false;
  return { keys, invalidated };
}

function turnDiffCompleted(
  files: Array<{ path: string }>,
  status: "ready" | "missing" = "ready",
): OrchestrationEvent {
  return {
    sequence: 1,
    eventId: EventId.makeUnsafe("event-1"),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: "2026-03-01T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.turn-diff-completed",
    payload: {
      threadId: THREAD_ID,
      turnId: TurnId.makeUnsafe("turn-1"),
      checkpointTurnCount: 1,
      checkpointRef: CheckpointRef.makeUnsafe("ref-1"),
      status,
      files: files.map((file) => ({ ...file, kind: "modified", additions: 1, deletions: 0 })),
      assistantMessageId: null,
      completedAt: "2026-03-01T00:00:00.000Z",
    },
  } as OrchestrationEvent;
}

async function watchReliably(paths: Array<[string, "file" | "directory"]>) {
  api.setWatchedPaths.mockResolvedValue({ watched: paths.length, degraded: false, rejected: [] });
  const releases = paths.map(([path, kind]) => retainWatchedWorkspacePath(CWD, path, kind));
  await vi.waitFor(() => expect(isWorkspaceWatchReliable(CWD)).toBe(true));
  return () => releases.forEach((release) => release());
}

beforeEach(() => {
  api.setWatchedPaths.mockReset();
  api.setWatchedPaths.mockResolvedValue({ watched: 0, degraded: false, rejected: [] });
  api.changeListeners.clear();
  resetWorkspaceWatchForTests();
  resetWsConnectionStateForTests();
});

afterEach(() => {
  resetWorkspaceWatchForTests();
});

describe("workspace watch registry", () => {
  it("syncs the ref-counted watched set per workspace, debounced", async () => {
    const releaseA = retainWatchedWorkspacePath(CWD, "src/app.ts", "file");
    const releaseB = retainWatchedWorkspacePath(CWD, "src/app.ts", "file");
    const releaseDir = retainWatchedWorkspacePath(CWD, "", "directory");
    await vi.waitFor(() => expect(api.setWatchedPaths).toHaveBeenCalledTimes(1));
    expect(lastSync()).toEqual({ cwd: CWD, files: ["src/app.ts"], directories: [""] });

    releaseA();
    releaseDir();
    await vi.waitFor(() => expect(api.setWatchedPaths).toHaveBeenCalledTimes(2));
    expect(lastSync()).toEqual({ cwd: CWD, files: ["src/app.ts"], directories: [] });

    releaseB();
    await vi.waitFor(() => expect(api.setWatchedPaths).toHaveBeenCalledTimes(3));
    expect(lastSync()).toEqual({ cwd: CWD, files: [], directories: [] });
  });

  it("is reliable only after the server confirms a non-degraded watch", async () => {
    api.setWatchedPaths.mockResolvedValue({ watched: 1, degraded: true, rejected: [] });
    const release = retainWatchedWorkspacePath(CWD, "src/app.ts", "file");
    expect(isWorkspaceWatchReliable(CWD)).toBe(false);
    await vi.waitFor(() => expect(api.setWatchedPaths).toHaveBeenCalled());
    await Promise.resolve();
    expect(isWorkspaceWatchReliable(CWD)).toBe(false);
    release();
  });

  it("is not reliable while the server rejected part of the watched set", async () => {
    api.setWatchedPaths.mockResolvedValue({ watched: 1, degraded: false, rejected: ["b.ts"] });
    const releaseA = retainWatchedWorkspacePath(CWD, "a.ts", "file");
    const releaseB = retainWatchedWorkspacePath(CWD, "b.ts", "file");
    await vi.waitFor(() => expect(api.setWatchedPaths).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(isWorkspaceWatchReliable(CWD)).toBe(false);
    releaseA();
    releaseB();
  });

  it("ignores the answer to a request a newer set superseded", async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    api.setWatchedPaths.mockImplementationOnce(
      () => new Promise((resolve) => (resolveFirst = resolve)),
    );
    const releaseA = retainWatchedWorkspacePath(CWD, "a.ts", "file");
    await vi.waitFor(() => expect(api.setWatchedPaths).toHaveBeenCalledTimes(1));

    // A newly retained path is not confirmed yet, so an answer to the
    // earlier request must not make the workspace reliable.
    api.setWatchedPaths.mockImplementationOnce(() => new Promise(() => {}));
    const releaseB = retainWatchedWorkspacePath(CWD, "b.ts", "file");
    resolveFirst({ watched: 1, degraded: false, rejected: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(isWorkspaceWatchReliable(CWD)).toBe(false);
    releaseA();
    releaseB();
  });

  it("invalidates exactly the changed file and directory queries", async () => {
    const queryClient = new QueryClient();
    const { keys, invalidated } = seedQueries(queryClient);
    const stop = startWorkspaceWatchSync(queryClient);
    const release = await watchReliably([["src/app.ts", "file"]]);

    for (const listener of api.changeListeners) {
      listener({
        cwd: CWD,
        changes: [{ relativePath: "src/app.ts", kind: "file", change: "changed", revision: 1 }],
        degraded: false,
      });
    }
    expect(invalidated(keys.appFile)).toBe(true);
    expect(invalidated(keys.otherFile)).toBe(false);
    expect(invalidated(keys.srcListing)).toBe(false);
    expect(invalidated(keys.search)).toBe(false);

    for (const listener of api.changeListeners) {
      listener({
        cwd: CWD,
        changes: [{ relativePath: "src", kind: "directory", change: "changed", revision: 1 }],
        degraded: true,
      });
    }
    expect(invalidated(keys.srcListing)).toBe(true);
    expect(invalidated(keys.rootListing)).toBe(false);
    expect(invalidated(keys.search)).toBe(true);
    expect(invalidated(keys.otherWorkspaceListing)).toBe(false);
    // A degraded notification ends narrow refreshes for the workspace.
    expect(isWorkspaceWatchReliable(CWD)).toBe(false);
    release();
    stop();
  });

  it("resends watched sets and refreshes the workspace after a reconnect", async () => {
    const queryClient = new QueryClient();
    const { keys, invalidated } = seedQueries(queryClient);
    noteWsConnectionOpened();
    const stop = startWorkspaceWatchSync(queryClient);
    const release = await watchReliably([["src/app.ts", "file"]]);
    const callsBefore = api.setWatchedPaths.mock.calls.length;

    noteWsConnectionClosed();
    noteWsConnectionOpened();

    await vi.waitFor(() =>
      expect(api.setWatchedPaths.mock.calls.length).toBeGreaterThan(callsBefore),
    );
    expect(lastSync()).toEqual({ cwd: CWD, files: ["src/app.ts"], directories: [] });
    expect(invalidated(keys.appFile)).toBe(true);
    expect(invalidated(keys.otherFile)).toBe(true);
    expect(invalidated(keys.rootListing)).toBe(true);
    expect(invalidated(keys.otherWorkspaceFile)).toBe(false);
    release();
    stop();
  });
});

describe("invalidateWorkspaceForEvent", () => {
  const resolveWorkspace = (): ThreadWorkspace | null => ({ cwd: CWD, projectId: PROJECT_ID });

  function apply(queryClient: QueryClient, event: OrchestrationEvent, resolve = resolveWorkspace) {
    if (!isWorkspaceEffectEvent(event)) throw new Error("not a workspace effect event");
    return invalidateWorkspaceForEvent(queryClient, event, resolve);
  }

  it("refreshes only the listed files when the workspace watch is reliable", async () => {
    const queryClient = new QueryClient();
    const { keys, invalidated } = seedQueries(queryClient);
    const release = await watchReliably([["src/app.ts", "file"]]);

    expect(apply(queryClient, turnDiffCompleted([{ path: "src/app.ts" }]))).toBe("narrow");

    expect(invalidated(keys.appFile)).toBe(true);
    expect(invalidated(keys.otherFile)).toBe(false);
    // Agent-created or deleted files show up in the workspace's listings.
    expect(invalidated(keys.rootListing)).toBe(true);
    expect(invalidated(keys.search)).toBe(true);
    expect(invalidated(keys.otherWorkspaceFile)).toBe(false);
    expect(invalidated(keys.otherWorkspaceListing)).toBe(false);
    release();
  });

  it("refreshes every open file of the workspace without a reliable watch", () => {
    const queryClient = new QueryClient();
    const { keys, invalidated } = seedQueries(queryClient);

    apply(queryClient, turnDiffCompleted([{ path: "src/app.ts" }]));

    expect(invalidated(keys.appFile)).toBe(true);
    expect(invalidated(keys.otherFile)).toBe(true);
    expect(invalidated(keys.otherWorkspaceFile)).toBe(false);
  });

  it("refreshes the whole workspace when the changed files are unknown", async () => {
    const queryClient = new QueryClient();
    const { keys, invalidated } = seedQueries(queryClient);
    const release = await watchReliably([["src/app.ts", "file"]]);

    apply(queryClient, turnDiffCompleted([], "missing"));

    expect(invalidated(keys.appFile)).toBe(true);
    expect(invalidated(keys.otherFile)).toBe(true);
    expect(invalidated(keys.srcListing)).toBe(true);
    expect(invalidated(keys.otherWorkspaceFile)).toBe(false);
    release();
  });

  it("falls back to refreshing every workspace when the thread is unknown", () => {
    const queryClient = new QueryClient();
    const { keys, invalidated } = seedQueries(queryClient);

    expect(apply(queryClient, turnDiffCompleted([{ path: "src/app.ts" }]), () => null)).toBe(
      "broad",
    );

    expect(invalidated(keys.otherWorkspaceFile)).toBe(true);
    expect(invalidated(keys.otherWorkspaceListing)).toBe(true);
  });
});
