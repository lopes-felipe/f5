import {
  PROJECT_WATCHED_PATHS_MAX,
  type ProjectWatchedPathsChangedPayload,
} from "@t3tools/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { readNativeApi } from "../nativeApi";
import { getWsConnectionState, subscribeWsConnectionState } from "../wsConnectionState";
import { projectQueryKeys } from "./projectQueryKeys";
import { providerQueryKeys } from "./providerQueryKeys";

/**
 * Keeps the server watching the workspace files that are open and the
 * directories that are visible, and turns its change notifications into
 * targeted query invalidations. Surfaces retain paths while mounted; the set
 * per workspace is synced (debounced) and resent after reconnects.
 *
 * Refetching an open file never replaces dirty editor text: the file view
 * compares the new content hash with the draft's base and marks a conflict.
 */

type WatchKind = "file" | "directory";

const SYNC_DEBOUNCE_MS = 100;

interface WorkspaceWatchState {
  readonly refCounts: Map<string, number>;
  syncTimer: ReturnType<typeof setTimeout> | null;
  /** Bumped per request; only the latest request's answer applies. */
  syncSequence: number;
  /** `null` until the first sync answers; false when the request failed. */
  watching: boolean | null;
  /** False when some retained path was capped or rejected by the server. */
  complete: boolean;
  degraded: boolean;
}

const workspaces = new Map<string, WorkspaceWatchState>();

function pathKey(kind: WatchKind, relativePath: string): string {
  return `${kind}:${relativePath}`;
}

function workspaceState(cwd: string): WorkspaceWatchState {
  let state = workspaces.get(cwd);
  if (!state) {
    state = {
      refCounts: new Map(),
      syncTimer: null,
      syncSequence: 0,
      watching: null,
      complete: true,
      degraded: false,
    };
    workspaces.set(cwd, state);
  }
  return state;
}

function syncWorkspace(cwd: string): void {
  const state = workspaces.get(cwd);
  if (!state) return;
  state.syncTimer = null;
  const api = readNativeApi();
  // Partial native API doubles in tests may not implement watching.
  if (typeof api?.projects.setWatchedPaths !== "function") return;
  const files: string[] = [];
  const directories: string[] = [];
  for (const key of state.refCounts.keys()) {
    const separator = key.indexOf(":");
    const kind = key.slice(0, separator) as WatchKind;
    (kind === "file" ? files : directories).push(key.slice(separator + 1));
  }
  if (files.length === 0 && directories.length === 0) {
    workspaces.delete(cwd);
  }
  // Open files first, then directories, within the per-request limit.
  const sentFiles = files.slice(0, PROJECT_WATCHED_PATHS_MAX);
  const sentDirectories = directories.slice(0, PROJECT_WATCHED_PATHS_MAX - sentFiles.length);
  const capped = sentFiles.length < files.length || sentDirectories.length < directories.length;
  const sequence = ++state.syncSequence;
  const current = () => {
    const latest = workspaces.get(cwd);
    return latest?.syncSequence === sequence ? latest : undefined;
  };
  // A synchronous transport failure is handled like a rejected request.
  Promise.resolve()
    .then(() =>
      api.projects.setWatchedPaths({ cwd, files: sentFiles, directories: sentDirectories }),
    )
    .then((result) => {
      const latest = current();
      if (!latest) return;
      latest.degraded = result.degraded;
      latest.complete = !capped && result.rejected.length === 0;
      latest.watching = true;
    })
    .catch(() => {
      const latest = current();
      if (latest) latest.watching = false;
    });
}

function scheduleSync(cwd: string): void {
  const state = workspaceState(cwd);
  // Until the server confirms the new set, it may not watch every retained
  // path; answers to earlier requests no longer apply.
  state.syncSequence += 1;
  state.watching = null;
  if (state.syncTimer !== null) return;
  state.syncTimer = setTimeout(() => syncWorkspace(cwd), SYNC_DEBOUNCE_MS);
}

/** Watches one path while retained; returns the release function. */
export function retainWatchedWorkspacePath(
  cwd: string,
  relativePath: string,
  kind: WatchKind,
): () => void {
  const state = workspaceState(cwd);
  const key = pathKey(kind, relativePath);
  const count = state.refCounts.get(key) ?? 0;
  state.refCounts.set(key, count + 1);
  if (count === 0) scheduleSync(cwd);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = workspaces.get(cwd);
    const remaining = (current?.refCounts.get(key) ?? 1) - 1;
    if (!current) return;
    if (remaining > 0) {
      current.refCounts.set(key, remaining);
      return;
    }
    current.refCounts.delete(key);
    scheduleSync(cwd);
  };
}

/**
 * True when the server confirmed it watches every retained path of `cwd`
 * without falling back to polling, so event-driven refreshes can stay narrow.
 */
export function isWorkspaceWatchReliable(cwd: string): boolean {
  const state = workspaces.get(cwd);
  return state?.watching === true && state.complete && !state.degraded;
}

export function applyWatchedPathsChanged(
  queryClient: QueryClient,
  payload: ProjectWatchedPathsChangedPayload,
): void {
  const state = workspaces.get(payload.cwd);
  if (state) state.degraded = payload.degraded;
  for (const change of payload.changes) {
    if (change.kind === "file") {
      void queryClient.invalidateQueries({
        queryKey: providerQueryKeys.fileContent({
          cwd: payload.cwd,
          relativePath: change.relativePath,
        }),
      });
    } else {
      void queryClient.invalidateQueries({
        queryKey: [...projectQueryKeys.listDirectories(payload.cwd), change.relativePath],
      });
    }
  }
  if (
    payload.changes.some((change) => change.change !== "changed" || change.kind === "directory")
  ) {
    // Entries were added, removed or renamed: file search results may be stale.
    void queryClient.invalidateQueries({ queryKey: ["projects", "search-entries", payload.cwd] });
    void queryClient.invalidateQueries({ queryKey: ["projects", "list-entries", payload.cwd] });
  }
}

/**
 * Routes change notifications into the query cache and resends every watched
 * set after a reconnect (the server drops a client's watches on disconnect).
 */
export function startWorkspaceWatchSync(queryClient: QueryClient): () => void {
  const api = readNativeApi();
  const unsubscribeChanges =
    typeof api?.projects.onWatchedPathsChanged === "function"
      ? api.projects.onWatchedPathsChanged((payload) =>
          applyWatchedPathsChanged(queryClient, payload),
        )
      : undefined;
  let wasConnected = getWsConnectionState().phase === "connected";
  const unsubscribeConnection = subscribeWsConnectionState(() => {
    const connected = getWsConnectionState().phase === "connected";
    if (connected && !wasConnected) {
      for (const cwd of workspaces.keys()) {
        scheduleSync(cwd);
        // Changes during the outage were not observed.
        void queryClient.invalidateQueries({
          queryKey: [...providerQueryKeys.fileContentAll, cwd],
        });
        void queryClient.invalidateQueries({ queryKey: projectQueryKeys.listDirectories(cwd) });
      }
    }
    wasConnected = connected;
  });
  return () => {
    unsubscribeChanges?.();
    unsubscribeConnection();
  };
}

/** Retains `files` and `directories` of `cwd` while the component is mounted. */
export function useWatchedWorkspacePaths(
  cwd: string | null | undefined,
  files: ReadonlyArray<string>,
  directories: ReadonlyArray<string>,
): void {
  // Content keys, so callers may pass fresh arrays every render.
  const filesKey = JSON.stringify(files);
  const directoriesKey = JSON.stringify(directories);
  useEffect(() => {
    if (!cwd) return;
    const releases = [
      ...(JSON.parse(filesKey) as string[]).map((path) =>
        retainWatchedWorkspacePath(cwd, path, "file"),
      ),
      ...(JSON.parse(directoriesKey) as string[]).map((path) =>
        retainWatchedWorkspacePath(cwd, path, "directory"),
      ),
    ];
    return () => {
      for (const release of releases) release();
    };
  }, [cwd, directoriesKey, filesKey]);
}

export function resetWorkspaceWatchForTests(): void {
  for (const state of workspaces.values()) {
    if (state.syncTimer !== null) clearTimeout(state.syncTimer);
  }
  workspaces.clear();
}
