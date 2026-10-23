import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  normalizeWatchedRelativePath,
  type WorkspaceWatchNotification,
  WorkspaceWatchRegistry,
} from "./workspaceWatch";

type Subscriber = { readonly name: string };

let root: string;
let registry: WorkspaceWatchRegistry<Subscriber>;
let notifications: Array<{ subscriber: string } & WorkspaceWatchNotification>;

function createRegistry(
  options: Partial<ConstructorParameters<typeof WorkspaceWatchRegistry<Subscriber>>[0]> = {},
) {
  return new WorkspaceWatchRegistry<Subscriber>({
    debounceMs: 20,
    pollIntervalMs: 50,
    notify: (subscriber, notification) =>
      notifications.push({ subscriber: subscriber.name, ...notification }),
    ...options,
  });
}

function changesFor(subscriber: string) {
  return notifications
    .filter((entry) => entry.subscriber === subscriber)
    .flatMap((entry) => entry.changes);
}

async function waitForChange(
  subscriber: string,
  match: { relativePath: string; change: string },
): Promise<void> {
  await vi.waitFor(
    () =>
      expect(changesFor(subscriber)).toContainEqual(
        expect.objectContaining({ relativePath: match.relativePath, change: match.change }),
      ),
    { timeout: 5_000, interval: 20 },
  );
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "f5-workspace-watch-"));
  await fsp.mkdir(path.join(root, "src"));
  await fsp.writeFile(path.join(root, "src", "app.ts"), "export const a = 1;\n");
  notifications = [];
  registry = createRegistry();
});

afterEach(async () => {
  registry.dispose();
  await fsp.rm(root, { recursive: true, force: true });
});

describe("normalizeWatchedRelativePath", () => {
  it("normalizes workspace-relative paths and rejects escapes", () => {
    expect(normalizeWatchedRelativePath("./src//app.ts")).toBe("src/app.ts");
    expect(normalizeWatchedRelativePath("src\\app.ts")).toBe("src/app.ts");
    expect(normalizeWatchedRelativePath("")).toBe("");
    expect(normalizeWatchedRelativePath("../outside")).toBeNull();
    expect(normalizeWatchedRelativePath("src/../../outside")).toBeNull();
    expect(normalizeWatchedRelativePath(".git/config")).toBeNull();
    expect(normalizeWatchedRelativePath("/etc/passwd")).toBeNull();
    expect(normalizeWatchedRelativePath("C:\\Windows")).toBeNull();
  });
});

describe("WorkspaceWatchRegistry", () => {
  const client = { name: "client" };

  it("retains a rename hint when a later change hint arrives before observation", async () => {
    registry.dispose();
    let hint!: (eventType: string) => void;
    const watch = vi.fn((_path: string, listener: (eventType: string) => void) => {
      hint = listener;
      return Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as fs.FSWatcher;
    });
    registry = createRegistry({ watch });
    await registry.setWatchedPaths(client, { cwd: root, files: ["src/app.ts"], directories: [] });
    const temporary = path.join(root, "src", "replacement");
    await fsp.writeFile(temporary, "replaced");
    await fsp.rename(temporary, path.join(root, "src", "app.ts"));
    hint("rename");
    hint("change");
    await waitForChange("client", { relativePath: "src/app.ts", change: "changed" });
    expect(watch).toHaveBeenCalledTimes(2);
  });

  it("checks by the maximum debounce delay during continuous hints", async () => {
    registry.dispose();
    let hint!: (eventType: string) => void;
    registry = createRegistry({
      debounceMs: 50,
      maxDebounceMs: 100,
      watch: (_target, listener) => {
        hint = listener;
        return Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as fs.FSWatcher;
      },
    });
    await registry.setWatchedPaths(client, { cwd: root, files: ["src/app.ts"], directories: [] });
    const internals = registry as unknown as {
      observe: (entry: unknown) => Promise<string | null>;
    };
    const observe = vi.spyOn(internals, "observe").mockResolvedValue("changed");
    vi.useFakeTimers();
    try {
      hint("change");
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(20);
        hint("change");
      }
      expect(observe).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20);
      expect(observe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases polling capacity between dirty observations and caps concurrent polls", async () => {
    registry.dispose();
    registry = createRegistry({
      debounceMs: 60_000,
      maxDebounceMs: 60_000,
      pollIntervalMs: 60_000,
      watch: () => {
        throw new Error("unavailable");
      },
    });
    const files = Array.from({ length: 5 }, (_, i) => `src/${i}.ts`);
    await Promise.all(files.map((file) => fsp.writeFile(path.join(root, file), "x")));
    await registry.setWatchedPaths(client, { cwd: root, files, directories: [] });
    const internals = registry as unknown as {
      observe: (entry: { absolutePath: string }) => Promise<string | null>;
      scheduleCheck: (entry: unknown, rearm: boolean) => void;
      poll: () => Promise<void>;
    };
    const original = internals.observe.bind(registry);
    const releases: Array<() => void> = [];
    let active = 0,
      maximum = 0;
    const observed = new Set<string>();
    vi.spyOn(internals, "observe").mockImplementation(async (entry) => {
      observed.add(entry.absolutePath);
      maximum = Math.max(maximum, ++active);
      await new Promise<void>((resolve) => releases.push(resolve));
      const result = await original(entry);
      active--;
      // Every completed path remains dirty; that cannot retain a poll lease.
      internals.scheduleCheck(entry, false);
      return result;
    });
    const polling = internals.poll();
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    expect(observed.size).toBe(4);
    for (const release of releases.splice(0)) release();
    await vi.waitFor(() => expect(observed.size).toBe(5));
    registry.dispose();
    for (const release of releases.splice(0)) release();
    await polling;
    expect(maximum).toBeLessThanOrEqual(4);
  });

  it("disposal during observation prevents notifications and rearming", async () => {
    registry.dispose();
    let hint!: (eventType: string) => void;
    const watch = vi.fn((_target: string, listener: (eventType: string) => void) => {
      hint = listener;
      return Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as fs.FSWatcher;
    });
    registry = createRegistry({ watch });
    await registry.setWatchedPaths(client, { cwd: root, files: ["src/app.ts"], directories: [] });
    let release!: (value: string) => void;
    const internals = registry as unknown as {
      observe: (entry: unknown) => Promise<string | null>;
    };
    const observe = vi.spyOn(internals, "observe").mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    hint("rename");
    await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(1));
    registry.dispose();
    release("replacement");
    await Promise.resolve();
    await Promise.resolve();
    expect(notifications).toEqual([]);
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it("reports external edits with advancing revisions", async () => {
    await registry.setWatchedPaths(client, { cwd: root, files: ["src/app.ts"], directories: [] });

    await fsp.writeFile(path.join(root, "src", "app.ts"), "export const a = 2;\n");
    await waitForChange("client", { relativePath: "src/app.ts", change: "changed" });

    await fsp.writeFile(path.join(root, "src", "app.ts"), "export const a = 33;\n");
    await vi.waitFor(() => expect(changesFor("client").length).toBeGreaterThanOrEqual(2), {
      timeout: 5_000,
    });
    const revisions = changesFor("client").map((change) => change.revision);
    expect(revisions).toEqual([...revisions].sort((left, right) => left - right));
    expect(new Set(revisions).size).toBe(revisions.length);
  });

  it("follows atomic editor saves that rename a temp file over the target", async () => {
    await registry.setWatchedPaths(client, { cwd: root, files: ["src/app.ts"], directories: [] });

    const temp = path.join(root, "src", ".app.ts.tmp");
    await fsp.writeFile(temp, "export const a = 'atomic';\n");
    await fsp.rename(temp, path.join(root, "src", "app.ts"));
    await waitForChange("client", { relativePath: "src/app.ts", change: "changed" });

    // The watch was re-armed on the new inode, so later edits still arrive.
    notifications = [];
    await fsp.writeFile(path.join(root, "src", "app.ts"), "export const a = 'after';\n");
    await waitForChange("client", { relativePath: "src/app.ts", change: "changed" });
  });

  it("reports deletes, then re-creation of the same path", async () => {
    await registry.setWatchedPaths(client, { cwd: root, files: ["src/app.ts"], directories: [] });

    await fsp.rm(path.join(root, "src", "app.ts"));
    await waitForChange("client", { relativePath: "src/app.ts", change: "deleted" });

    await fsp.writeFile(path.join(root, "src", "app.ts"), "export const back = true;\n");
    await waitForChange("client", { relativePath: "src/app.ts", change: "created" });
  });

  it("reports entries added to and renamed within a watched directory", async () => {
    // The registry consumes OS hints; native directory hints may be coalesced
    // across both mutations. Inject them to test directory signatures without
    // relying on platform event-delivery timing or adding periodic I/O.
    registry.dispose();
    let hint!: (eventType: string) => void;
    registry = createRegistry({
      watch: (_target, listener) => {
        hint = listener;
        return Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as fs.FSWatcher;
      },
    });
    await registry.setWatchedPaths(client, { cwd: root, files: [], directories: ["src"] });

    await fsp.writeFile(path.join(root, "src", "new.ts"), "");
    hint("rename");
    await waitForChange("client", { relativePath: "src", change: "changed" });

    notifications = [];
    await fsp.rename(path.join(root, "src", "new.ts"), path.join(root, "src", "renamed.ts"));
    hint("rename");
    await waitForChange("client", { relativePath: "src", change: "changed" });
  });

  it("does not poll healthy directory watchers", async () => {
    registry.dispose();
    registry = createRegistry({
      watch: () => Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as fs.FSWatcher,
    });
    await registry.setWatchedPaths(client, { cwd: root, files: [], directories: ["src"] });
    const internals = registry as unknown as {
      observe: (entry: unknown) => Promise<string | null>;
    };
    const observe = vi.spyOn(internals, "observe");
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(observe).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a rename within a watched directory whose mtime did not move", async () => {
    registry.dispose();
    let hint!: (eventType: string) => void;
    registry = createRegistry({
      watch: (_target, listener) => {
        hint = listener;
        return Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as fs.FSWatcher;
      },
    });
    const dir = path.join(root, "src");
    // Whole seconds, so restoring the mtime yields an identical mtimeMs.
    fs.utimesSync(dir, 1_700_000_000, 1_700_000_000);
    await registry.setWatchedPaths(client, { cwd: root, files: [], directories: ["src"] });

    fs.renameSync(path.join(dir, "app.ts"), path.join(dir, "main.ts"));
    fs.utimesSync(dir, 1_700_000_000, 1_700_000_000);
    hint("rename");
    await waitForChange("client", { relativePath: "src", change: "changed" });
  });

  it("reconciles directory changes when a native watcher silently misses its events", async () => {
    registry.dispose();
    const close = vi.fn();
    class SilentWatcher extends EventEmitter implements fs.FSWatcher {
      close = close;
      ref() {
        return this;
      }
      unref() {
        return this;
      }
    }
    const watch = vi.fn(() => new SilentWatcher());
    registry = createRegistry({ watch });
    await registry.setWatchedPaths(client, { cwd: root, files: [], directories: ["src"] });

    await fsp.writeFile(path.join(root, "src", "missed.ts"), "");
    await waitForChange("client", { relativePath: "src", change: "changed" });
    notifications = [];
    await fsp.rename(path.join(root, "src", "missed.ts"), path.join(root, "src", "renamed.ts"));
    await waitForChange("client", { relativePath: "src", change: "changed" });

    expect(notifications.every((notification) => !notification.degraded)).toBe(true);
    expect(watch).toHaveBeenCalledOnce();
    registry.releaseSubscriber(client);
    expect(close).toHaveBeenCalledOnce();
    notifications = [];
    await fsp.writeFile(path.join(root, "src", "after-release.ts"), "");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(notifications).toEqual([]);
  });

  it("shares one watch between subscribers and releases it with the last one", async () => {
    const other = { name: "other" };
    await registry.setWatchedPaths(client, { cwd: root, files: ["src/app.ts"], directories: [] });
    await registry.setWatchedPaths(other, { cwd: root, files: ["src/app.ts"], directories: [] });
    expect(registry.size).toBe(1);

    await fsp.writeFile(path.join(root, "src", "app.ts"), "export const shared = 1;\n");
    await waitForChange("client", { relativePath: "src/app.ts", change: "changed" });
    await waitForChange("other", { relativePath: "src/app.ts", change: "changed" });

    registry.releaseSubscriber(client);
    expect(registry.size).toBe(1);
    // Replacing the set with nothing releases the remaining watch.
    await registry.setWatchedPaths(other, { cwd: root, files: [], directories: [] });
    expect(registry.size).toBe(0);
  });

  it("rejects paths outside the workspace, including through symlinks", async () => {
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "f5-workspace-watch-outside-"));
    try {
      await fsp.symlink(outside, path.join(root, "escape"));
      const result = await registry.setWatchedPaths(client, {
        cwd: root,
        files: ["../secret", ".git/config"],
        directories: ["escape", "src"],
      });
      expect(result.rejected).toEqual(["../secret", ".git/config", "escape"]);
      expect(result.watched).toBe(1);
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects missing paths below a symlink that leaves the workspace", async () => {
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "f5-workspace-watch-outside-"));
    try {
      await fsp.symlink(outside, path.join(root, "escape"));
      const result = await registry.setWatchedPaths(client, {
        cwd: root,
        files: ["escape/new.ts", "src/new.ts"],
        directories: [],
      });
      expect(result.rejected).toEqual(["escape/new.ts"]);
      expect(result.watched).toBe(1);
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it("does not follow a missing path once a parent appears as a symlink out", async () => {
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "f5-workspace-watch-outside-"));
    try {
      await registry.setWatchedPaths(client, {
        cwd: root,
        files: ["later/new.ts"],
        directories: [],
      });
      await fsp.symlink(outside, path.join(root, "later"));
      await fsp.writeFile(path.join(outside, "new.ts"), "outside\n");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(changesFor("client")).toEqual([]);
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it("notifies each workspace that reaches a shared path with its own relative path", async () => {
    const nested = path.join(root, "nested");
    await fsp.mkdir(nested);
    await fsp.writeFile(path.join(nested, "app.ts"), "");
    const other = { name: "other" };
    await registry.setWatchedPaths(client, {
      cwd: root,
      files: ["nested/app.ts"],
      directories: [],
    });
    await registry.setWatchedPaths(client, { cwd: nested, files: ["app.ts"], directories: [] });
    await registry.setWatchedPaths(other, { cwd: nested, files: ["app.ts"], directories: [] });
    expect(registry.size).toBe(1);

    await fsp.writeFile(path.join(nested, "app.ts"), "changed\n");
    await vi.waitFor(
      () => {
        const byCwd = (name: string, cwd: string) =>
          notifications
            .filter((entry) => entry.subscriber === name && entry.cwd === cwd)
            .flatMap((entry) => entry.changes.map((change) => change.relativePath));
        expect(byCwd("client", root)).toContain("nested/app.ts");
        expect(byCwd("client", nested)).toContain("app.ts");
        expect(byCwd("other", nested)).toContain("app.ts");
      },
      { timeout: 5_000, interval: 20 },
    );

    // Dropping one workspace keeps the watch for the other registrations.
    await registry.setWatchedPaths(client, { cwd: root, files: [], directories: [] });
    expect(registry.size).toBe(1);
    registry.releaseSubscriber(client);
    registry.releaseSubscriber(other);
    expect(registry.size).toBe(0);
  });

  it("applies one subscriber's overlapping calls in order", async () => {
    const slow = registry.setWatchedPaths(client, {
      cwd: root,
      files: ["src/app.ts", "src/a.ts", "src/b.ts"],
      directories: ["src", ""],
    });
    const fast = registry.setWatchedPaths(client, { cwd: root, files: [], directories: [] });
    await Promise.all([slow, fast]);
    expect(registry.size).toBe(0);
  });

  it("does not keep watches for a subscriber released while a call is pending", async () => {
    registry.dispose();
    registry = createRegistry({
      watch: (target, listener) => {
        // Disconnect lands after the call started watching, before it commits.
        registry.releaseSubscriber(client);
        return fs.watch(target, listener);
      },
    });

    const result = await registry.setWatchedPaths(client, {
      cwd: root,
      files: ["src/app.ts"],
      directories: ["src"],
    });
    expect(result.watched).toBe(0);
    expect(registry.size).toBe(0);

    await fsp.writeFile(path.join(root, "src", "app.ts"), "export const ignored = 1;\n");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(notifications).toEqual([]);
  });

  it("re-creates a shared watch another subscriber released mid-call", async () => {
    const other = { name: "other" };
    registry.dispose();
    registry = createRegistry({
      watch: (target, listener) => {
        // `other` drops the shared file watch while the client's call is
        // still setting up its directory watch.
        if (target === srcDirectory) registry.releaseSubscriber(other);
        return fs.watch(target, listener);
      },
    });
    const srcDirectory = await fsp.realpath(path.join(root, "src"));
    await registry.setWatchedPaths(other, { cwd: root, files: ["src/app.ts"], directories: [] });
    const result = await registry.setWatchedPaths(client, {
      cwd: root,
      files: ["src/app.ts"],
      directories: ["src"],
    });
    expect(result.watched).toBe(2);
    expect(registry.size).toBe(2);

    await fsp.writeFile(path.join(root, "src", "app.ts"), "export const kept = 1;\n");
    await waitForChange("client", { relativePath: "src/app.ts", change: "changed" });
  });

  it("falls back to polling when watching fails and reports degraded status", async () => {
    registry.dispose();
    registry = createRegistry({
      watch: () => {
        throw Object.assign(new Error("ENOSPC: watch limit reached"), { code: "ENOSPC" });
      },
    });

    const result = await registry.setWatchedPaths(client, {
      cwd: root,
      files: ["src/app.ts"],
      directories: [],
    });
    expect(result.degraded).toBe(true);

    await fsp.writeFile(path.join(root, "src", "app.ts"), "export const polled = 1;\n");
    await waitForChange("client", { relativePath: "src/app.ts", change: "changed" });
    expect(notifications.at(-1)?.degraded).toBe(true);
  });

  it("keeps watching a path that does not exist yet without reporting degraded", async () => {
    const result = await registry.setWatchedPaths(client, {
      cwd: root,
      files: ["src/later.ts"],
      directories: [],
    });
    expect(result.degraded).toBe(false);

    await fsp.writeFile(path.join(root, "src", "later.ts"), "");
    await waitForChange("client", { relativePath: "src/later.ts", change: "created" });
  });

  it("stops notifying after a subscriber is released", async () => {
    await registry.setWatchedPaths(client, { cwd: root, files: ["src/app.ts"], directories: [] });
    registry.releaseSubscriber(client);
    expect(registry.size).toBe(0);

    await fsp.writeFile(path.join(root, "src", "app.ts"), "export const ignored = 1;\n");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(notifications).toEqual([]);
    expect(fs.existsSync(path.join(root, "src", "app.ts"))).toBe(true);
  });
});
