import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import type { ProjectWatchedPathChange } from "@t3tools/contracts";

/**
 * Ref-counted watches on workspace files and directories that clients have
 * open. Each watched path keeps a stat signature and a revision that advances
 * on every observed change; subscribers get batched change notifications.
 *
 * `fs.watch` events are hints only: every event re-stats the path, so atomic
 * saves (write a temp file, rename it over the target), renames and deletes
 * are reported from what is on disk. When a watch cannot be established or
 * fails, the path is polled instead and subscribers are told they are
 * degraded, so they can keep broader refresh triggers. One shared timer also
 * reconciles healthy watches because native notifications can silently be lost.
 */

export type WorkspaceWatchKind = "file" | "directory";

export interface WorkspaceWatchNotification {
  readonly cwd: string;
  readonly changes: ReadonlyArray<ProjectWatchedPathChange>;
  /** True while any of this subscriber's paths in `cwd` are polled. */
  readonly degraded: boolean;
}

export interface WorkspaceWatchRegistryOptions<S> {
  readonly notify: (subscriber: S, notification: WorkspaceWatchNotification) => void;
  readonly debounceMs?: number;
  readonly maxDebounceMs?: number;
  readonly pollIntervalMs?: number;
  readonly maxPathsPerSubscriber?: number;
  /** Test seam; defaults to `fs.watch`. */
  readonly watch?: (target: string, listener: (eventType: string) => void) => fs.FSWatcher;
}

export interface WorkspaceWatchResult {
  readonly watched: number;
  readonly degraded: boolean;
  /** Paths rejected as invalid or outside the workspace. */
  readonly rejected: ReadonlyArray<string>;
}

interface WatchEntry<S> {
  readonly key: string;
  readonly kind: WorkspaceWatchKind;
  readonly absolutePath: string;
  /**
   * One OS watch per absolute path, fanned out per registration: a subscriber
   * can reach the same path from several workspaces (for example `/repo` and
   * `/repo/nested`), each with its own `cwd` and relative path.
   */
  readonly registrations: Map<S, Map<string, string>>;
  /** Deepest workspace root registered; the path must resolve inside it. */
  root: string;
  watcher: fs.FSWatcher | null;
  polling: boolean;
  /** Watching failed, as opposed to waiting for a path or reconciling directory names. */
  watchFailed: boolean;
  ready: Promise<void>;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  signature: string | null;
  revision: number;
  checking: Promise<void> | null;
  needsRearm: boolean;
  dirty: boolean;
  debounceStartedAt: number | null;
  disposed: boolean;
}

const DEFAULT_DEBOUNCE_MS = 60;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_PATHS_PER_SUBSCRIBER = 512;

/** Workspace-relative, forward slashes, no `.`/`..`/`.git` segments. */
export function normalizeWatchedRelativePath(relativePath: string): string | null {
  if (path.isAbsolute(relativePath) || /^[a-zA-Z]:[\\/]/.test(relativePath)) return null;
  const segments = relativePath
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment && segment !== ".");
  if (segments.some((segment) => segment === ".." || segment === ".git")) return null;
  return segments.join("/");
}

function isWithin(root: string, resolved: string): boolean {
  const relative = path.relative(root, resolved);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Whether `absolutePath` resolves inside `root`. A path that does not exist
 * yet is checked through its nearest existing ancestor, so a missing file
 * below a symlink that leaves the workspace is rejected too.
 */
async function resolvesInsideWorkspace(root: string, absolutePath: string): Promise<boolean> {
  let candidate = absolutePath;
  for (;;) {
    try {
      return isWithin(root, await fsp.realpath(candidate));
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate || !isWithin(root, parent)) return false;
      candidate = parent;
    }
  }
}

async function statSignature(absolutePath: string, kind: WorkspaceWatchKind) {
  try {
    const stat = await fsp.stat(absolutePath);
    if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) return null;
    if (kind === "file") return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    // Entry names as well as mtime: a directory's mtime can miss a rename where
    // timestamps are coarse or lazily updated (NTFS ticks, FAT, network shares).
    const names = (await fsp.readdir(absolutePath)).toSorted();
    const listing = createHash("sha1").update(names.join("\0")).digest("base64url");
    return `${stat.ino}:${stat.mtimeMs}:${listing}`;
  } catch {
    return null;
  }
}

export class WorkspaceWatchRegistry<S> {
  private readonly entries = new Map<string, WatchEntry<S>>();
  private readonly keysBySubscriber = new Map<S, Map<string, Set<string>>>();
  private readonly pendingBySubscriber = new Map<S, Map<string, ProjectWatchedPathChange[]>>();
  /** Serializes each subscriber's calls; `released` stops a pending call from committing. */
  private readonly callsBySubscriber = new Map<S, { tail: Promise<void>; released: boolean }>();
  private flushScheduled = false;
  private reconciliationTimer: ReturnType<typeof setInterval> | null = null;
  private readonly debounceMs: number;
  private readonly maxDebounceMs: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollingActive = false;
  private readonly pollIntervalMs: number;
  private readonly maxPathsPerSubscriber: number;
  private readonly watch: NonNullable<WorkspaceWatchRegistryOptions<S>["watch"]>;

  constructor(private readonly options: WorkspaceWatchRegistryOptions<S>) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxDebounceMs = Math.max(this.debounceMs, options.maxDebounceMs ?? 500);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxPathsPerSubscriber = options.maxPathsPerSubscriber ?? DEFAULT_MAX_PATHS_PER_SUBSCRIBER;
    this.watch = options.watch ?? ((target, listener) => fs.watch(target, listener));
  }

  /**
   * Replaces the subscriber's watched set for `cwd`. Idempotent, so clients
   * resend their full set after a reconnect. Calls from one subscriber apply
   * in arrival order, so an older set never overwrites a newer one.
   */
  setWatchedPaths(
    subscriber: S,
    input: {
      readonly cwd: string;
      readonly files: ReadonlyArray<string>;
      readonly directories: ReadonlyArray<string>;
    },
  ): Promise<WorkspaceWatchResult> {
    let calls = this.callsBySubscriber.get(subscriber);
    if (!calls) {
      calls = { tail: Promise.resolve(), released: false };
      this.callsBySubscriber.set(subscriber, calls);
    }
    const state = calls;
    const run = state.tail.then(() => this.applyWatchedPaths(subscriber, input, state));
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    state.tail = tail;
    void tail.then(() => {
      if (state.tail === tail && this.callsBySubscriber.get(subscriber) === state) {
        this.callsBySubscriber.delete(subscriber);
      }
    });
    return run;
  }

  private async applyWatchedPaths(
    subscriber: S,
    input: {
      readonly cwd: string;
      readonly files: ReadonlyArray<string>;
      readonly directories: ReadonlyArray<string>;
    },
    state: { readonly released: boolean },
  ): Promise<WorkspaceWatchResult> {
    const rejected: string[] = [];
    if (state.released) return { watched: 0, degraded: false, rejected };
    const root = await fsp.realpath(input.cwd);
    const nextPaths = new Map<
      string,
      { relativePath: string; kind: WorkspaceWatchKind; absolutePath: string }
    >();
    const created: string[] = [];
    const requests: Array<{ relativePath: string; kind: WorkspaceWatchKind }> = [
      ...input.files.map((relativePath) => ({ relativePath, kind: "file" as const })),
      ...input.directories.map((relativePath) => ({ relativePath, kind: "directory" as const })),
    ];
    const otherCwdCount = [...(this.keysBySubscriber.get(subscriber)?.entries() ?? [])]
      .filter(([cwd]) => cwd !== input.cwd)
      .reduce((sum, [, keys]) => sum + keys.size, 0);

    try {
      for (const request of requests) {
        const relativePath = normalizeWatchedRelativePath(request.relativePath);
        if (relativePath === null || otherCwdCount + nextPaths.size >= this.maxPathsPerSubscriber) {
          rejected.push(request.relativePath);
          continue;
        }
        const absolutePath = relativePath ? path.join(root, relativePath) : root;
        if (!(await resolvesInsideWorkspace(root, absolutePath))) {
          rejected.push(request.relativePath);
          continue;
        }
        const key = `${request.kind}\u0000${absolutePath}`;
        nextPaths.set(key, { relativePath, kind: request.kind, absolutePath });
        let entry = this.entries.get(key);
        if (!entry) {
          entry = this.createEntry(key, request.kind, absolutePath, root);
          this.entries.set(key, entry);
          created.push(key);
        }
        await entry.ready;
      }

      // The subscriber disconnected while this call was pending.
      if (state.released) return { watched: 0, degraded: false, rejected };

      const byCwd = this.keysBySubscriber.get(subscriber) ?? new Map<string, Set<string>>();
      const previousKeys = byCwd.get(input.cwd) ?? new Set<string>();
      const recreated: Array<Promise<void>> = [];
      for (const [key, { relativePath, kind, absolutePath }] of nextPaths) {
        let entry = this.entries.get(key);
        if (!entry) {
          // Another subscriber released the last reference while this call awaited.
          entry = this.createEntry(key, kind, absolutePath, root);
          this.entries.set(key, entry);
          recreated.push(entry.ready);
        }
        if (root.length > entry.root.length) entry.root = root;
        const registrations = entry.registrations.get(subscriber) ?? new Map<string, string>();
        registrations.set(input.cwd, relativePath);
        entry.registrations.set(subscriber, registrations);
      }
      for (const key of previousKeys) {
        if (!nextPaths.has(key)) this.releaseRegistration(subscriber, input.cwd, key);
      }
      const nextKeys = new Set(nextPaths.keys());
      if (nextKeys.size > 0) {
        byCwd.set(input.cwd, nextKeys);
        this.keysBySubscriber.set(subscriber, byCwd);
      } else {
        byCwd.delete(input.cwd);
        if (byCwd.size === 0) this.keysBySubscriber.delete(subscriber);
      }
      // Registered above, so a release while this waits still closes them. Waiting
      // keeps the baseline stat ahead of edits the caller makes after resolving.
      await Promise.all(recreated);

      return {
        watched: nextKeys.size,
        degraded: this.isDegraded(nextKeys),
        rejected,
      };
    } finally {
      // Entries this call created but never registered (released, or failed).
      for (const key of created) {
        const entry = this.entries.get(key);
        if (entry && entry.registrations.size === 0) {
          this.closeEntry(entry);
          this.entries.delete(key);
          this.stopReconciliationIfEmpty();
        }
      }
    }
  }

  /** Drops every watch held by a subscriber (for example on disconnect). */
  releaseSubscriber(subscriber: S): void {
    const calls = this.callsBySubscriber.get(subscriber);
    if (calls) {
      calls.released = true;
      this.callsBySubscriber.delete(subscriber);
    }
    const byCwd = this.keysBySubscriber.get(subscriber);
    this.keysBySubscriber.delete(subscriber);
    this.pendingBySubscriber.delete(subscriber);
    if (!byCwd) return;
    for (const [cwd, keys] of byCwd) {
      for (const key of keys) this.releaseRegistration(subscriber, cwd, key);
    }
  }

  dispose(): void {
    for (const calls of this.callsBySubscriber.values()) calls.released = true;
    this.callsBySubscriber.clear();
    for (const entry of this.entries.values()) this.closeEntry(entry);
    this.entries.clear();
    this.stopReconciliationIfEmpty();
    this.keysBySubscriber.clear();
    this.pendingBySubscriber.clear();
  }

  /** Number of distinct watched paths across subscribers (for tests and metrics). */
  get size(): number {
    return this.entries.size;
  }

  private isDegraded(keys: Iterable<string>): boolean {
    for (const key of keys) {
      if (this.entries.get(key)?.watchFailed) return true;
    }
    return false;
  }

  /** Stat signature, or null when missing or now resolving outside the workspace. */
  private async observe(entry: WatchEntry<S>): Promise<string | null> {
    const signature = await statSignature(entry.absolutePath, entry.kind);
    if (signature === null) return null;
    // The path, or a parent created after registration, may be a symlink out.
    return (await resolvesInsideWorkspace(entry.root, entry.absolutePath)) ? signature : null;
  }

  private createEntry(
    key: string,
    kind: WorkspaceWatchKind,
    absolutePath: string,
    root: string,
  ): WatchEntry<S> {
    const entry: WatchEntry<S> = {
      key,
      kind,
      absolutePath,
      registrations: new Map(),
      root,
      watcher: null,
      polling: false,
      watchFailed: false,
      ready: Promise.resolve(),
      debounceTimer: null,
      signature: null,
      revision: 0,
      checking: null,
      needsRearm: false,
      dirty: false,
      debounceStartedAt: null,
      disposed: false,
    };
    entry.ready = this.observe(entry).then((signature) => {
      entry.signature = signature;
      if (!entry.disposed) this.arm(entry);
    });
    return entry;
  }

  /** Watches the path when it exists, and polls when it does not or watching fails. */
  private arm(entry: WatchEntry<S>): void {
    entry.watcher?.close();
    entry.watcher = null;
    if (entry.signature !== null) {
      try {
        const watcher = this.watch(entry.absolutePath, (eventType) => {
          this.scheduleCheck(entry, eventType === "rename");
        });
        watcher.on("error", () => {
          if (entry.watcher !== watcher) return;
          watcher.close();
          entry.watcher = null;
          this.startPolling(entry, true);
        });
        entry.watcher = watcher;
        this.stopPolling(entry);
        this.startReconciliation();
        return;
      } catch {
        // Unsupported file system, watch limit reached, or permissions.
        this.startPolling(entry, true);
        return;
      }
    }
    // Missing path: poll until it appears, then watch it.
    this.startPolling(entry, false);
  }

  private startPolling(entry: WatchEntry<S>, watchFailed: boolean): void {
    if (entry.disposed) return;
    if (entry.watchFailed !== watchFailed) {
      entry.watchFailed = watchFailed;
      this.queueStatusChange(entry);
    }
    entry.polling = true;
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.poll(), this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  private async poll(): Promise<void> {
    if (this.pollingActive) return;
    this.pollingActive = true;
    try {
      const entries = [...this.entries.values()].filter(
        (entry) => entry.polling && !entry.disposed,
      );
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, entries.length) }, async () => {
          for (;;) {
            const entry = entries[next++];
            if (!entry) return;
            if (!entry.polling || entry.disposed) continue;
            entry.needsRearm = true;
            await this.check(entry);
          }
        }),
      );
    } finally {
      this.pollingActive = false;
    }
  }

  private stopPolling(entry: WatchEntry<S>): void {
    entry.polling = false;
    if (
      this.pollTimer &&
      ![...this.entries.values()].some((candidate) => candidate.polling && !candidate.disposed)
    ) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (entry.watchFailed) {
      entry.watchFailed = false;
      this.queueStatusChange(entry);
    }
  }

  private scheduleCheck(entry: WatchEntry<S>, rearm: boolean): void {
    if (entry.disposed) return;
    // A later change hint must not erase a preceding rename hint.
    entry.needsRearm ||= rearm;
    if (entry.checking) {
      entry.dirty = true;
      return;
    }
    const now = Date.now();
    entry.debounceStartedAt ??= now;
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    const delay = Math.min(
      this.debounceMs,
      Math.max(0, this.maxDebounceMs - (now - entry.debounceStartedAt)),
    );
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      entry.debounceStartedAt = null;
      void this.check(entry);
    }, delay);
    entry.debounceTimer.unref?.();
  }

  private startReconciliation(): void {
    if (this.reconciliationTimer) return;
    this.reconciliationTimer = setInterval(() => {
      for (const entry of this.entries.values()) {
        // Failed watches already poll. Do not accumulate observations behind
        // slow I/O or a pending native event's debounce.
        if (
          entry.registrations.size > 0 &&
          entry.watcher &&
          !entry.polling &&
          !entry.disposed &&
          !entry.checking &&
          !entry.debounceTimer
        ) {
          entry.needsRearm = true;
          void this.check(entry);
        }
      }
    }, this.pollIntervalMs);
    this.reconciliationTimer.unref?.();
  }

  private stopReconciliationIfEmpty(): void {
    if (this.entries.size !== 0 || !this.reconciliationTimer) return;
    clearInterval(this.reconciliationTimer);
    this.reconciliationTimer = null;
  }

  private async check(entry: WatchEntry<S>): Promise<void> {
    if (entry.disposed) return;
    if (entry.checking) {
      entry.dirty = true;
      return entry.checking;
    }
    const run = (async () => {
      {
        entry.dirty = false;
        const rearm = entry.needsRearm;
        entry.needsRearm = false;
        const previous = entry.signature;
        const next = await this.observe(entry);
        if (entry.disposed) return;
        entry.signature = next;
        const inodeChanged = previous?.split(":")[0] !== next?.split(":")[0];
        if (rearm && (inodeChanged || next === null || !entry.watcher)) this.arm(entry);
        else if (!entry.watcher && !entry.polling) this.arm(entry);
        if (previous !== next) {
          entry.revision++;
          this.queueChange(entry, {
            kind: entry.kind,
            change: next === null ? "deleted" : previous === null ? "created" : "changed",
            revision: entry.revision,
          });
        }
      }
    })();
    entry.checking = run;
    try {
      await run;
    } finally {
      if (entry.checking === run) {
        entry.checking = null;
        // Yield the shared polling slot after one observation. More hints get
        // one debounced rerun instead of extending this lease indefinitely.
        if (!entry.disposed && (entry.dirty || entry.needsRearm))
          this.scheduleCheck(entry, entry.needsRearm);
      }
    }
  }

  private queueChange(
    entry: WatchEntry<S>,
    change: Omit<ProjectWatchedPathChange, "relativePath">,
  ): void {
    for (const [subscriber, registrations] of entry.registrations) {
      const byCwd = this.pendingBySubscriber.get(subscriber) ?? new Map();
      for (const [cwd, relativePath] of registrations) {
        const changes = byCwd.get(cwd) ?? [];
        changes.push({ ...change, relativePath });
        byCwd.set(cwd, changes);
      }
      this.pendingBySubscriber.set(subscriber, byCwd);
    }
    this.scheduleFlush();
  }

  /** Watch/poll transitions reach subscribers as an empty change batch. */
  private queueStatusChange(entry: WatchEntry<S>): void {
    for (const [subscriber, registrations] of entry.registrations) {
      const byCwd = this.pendingBySubscriber.get(subscriber) ?? new Map();
      for (const cwd of registrations.keys()) {
        if (!byCwd.has(cwd)) byCwd.set(cwd, []);
      }
      this.pendingBySubscriber.set(subscriber, byCwd);
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      const pending = [...this.pendingBySubscriber];
      this.pendingBySubscriber.clear();
      for (const [subscriber, byCwd] of pending) {
        const keysByCwd = this.keysBySubscriber.get(subscriber);
        if (!keysByCwd) continue;
        for (const [cwd, changes] of byCwd) {
          const keys = keysByCwd.get(cwd);
          if (!keys) continue;
          this.options.notify(subscriber, { cwd, changes, degraded: this.isDegraded(keys) });
        }
      }
    });
  }

  private releaseRegistration(subscriber: S, cwd: string, key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    const registrations = entry.registrations.get(subscriber);
    registrations?.delete(cwd);
    if (registrations?.size === 0) entry.registrations.delete(subscriber);
    if (entry.registrations.size > 0) return;
    this.closeEntry(entry);
    this.entries.delete(key);
    this.stopReconciliationIfEmpty();
  }

  private closeEntry(entry: WatchEntry<S>): void {
    entry.disposed = true;
    entry.watcher?.close();
    entry.watcher = null;
    this.stopPolling(entry);
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = null;
    entry.debounceStartedAt = null;
    entry.dirty = entry.needsRearm = false;
  }
}
