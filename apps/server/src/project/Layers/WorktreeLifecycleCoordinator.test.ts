import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { acquireInstanceLock } from "../../profiles/InstanceLock.ts";
import {
  holdsWorktreeLifecycleLock,
  repositoryLockPath,
  withRepositoryLifecycleLock,
  withWorktreeLifecycleLock,
} from "./WorktreeLifecycleCoordinator.ts";

it("refuses a repository lock held by another profile and releases its own lock", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "f5-repository-lock-"));
  const common = path.join(base, "common");
  await fs.mkdir(common);
  const key = createHash("sha256")
    .update(await fs.realpath(common))
    .digest("hex");
  const lockPath = path.join(base, "locks", `${key}.sqlite`);
  const otherProfile = await acquireInstanceLock(lockPath);
  try {
    await expect(
      Effect.runPromise(withRepositoryLifecycleLock(base, common, Effect.succeed("unexpected"))),
    ).rejects.toThrow(/another F5 profile/i);
    otherProfile.release();
    expect(
      await Effect.runPromise(
        withRepositoryLifecycleLock(base, common, Effect.succeed("acquired")),
      ),
    ).toBe("acquired");
    const after = await acquireInstanceLock(lockPath);
    after.release();
  } finally {
    otherProfile.release();
    await fs.rm(base, { recursive: true, force: true });
  }
});

it("serializes two same-process repository mutations beyond the cross-profile retry window", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "f5-repository-serial-"));
  try {
    const order: string[] = [];
    await Effect.runPromise(
      Effect.all(
        [1, 2].map((id) =>
          withRepositoryLifecycleLock(
            base,
            base,
            Effect.gen(function* () {
              order.push("start" + id);
              yield* Effect.sleep("650 millis");
              order.push("end" + id);
            }),
          ),
        ),
        { concurrency: 2 },
      ),
    );
    expect([
      ["start1", "end1", "start2", "end2"],
      ["start2", "end2", "start1", "end1"],
    ]).toContainEqual(order);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

it("lets the fiber holding a worktree lock re-enter it without deadlocking", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "f5-worktree-reentrant-"));
  try {
    const result = await Effect.runPromise(
      withWorktreeLifecycleLock(
        path.join(base, "wt"),
        Effect.gen(function* () {
          const inner = yield* withWorktreeLifecycleLock(
            path.join(base, "wt"),
            holdsWorktreeLifecycleLock(path.join(base, "wt")),
          );
          return inner;
        }),
      ).pipe(Effect.timeout("2 seconds")),
    );
    expect(result).toBe(true);
    expect(await Effect.runPromise(holdsWorktreeLifecycleLock(path.join(base, "wt")))).toBe(false);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

it("serializes two fibers on one worktree path while a third path runs freely", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "f5-worktree-serial-"));
  try {
    const order: string[] = [];
    const step = (id: string, target: string, ms: number) =>
      withWorktreeLifecycleLock(
        path.join(base, target),
        Effect.gen(function* () {
          order.push(`start:${id}`);
          yield* Effect.sleep(`${ms} millis`);
          order.push(`end:${id}`);
        }),
      );
    await Effect.runPromise(
      Effect.all([step("a", "wt", 120), step("b", "wt", 10), step("c", "other", 10)], {
        concurrency: 3,
      }),
    );
    const aEnd = order.indexOf("end:a");
    const bStart = order.indexOf("start:b");
    const aStart = order.indexOf("start:a");
    const bEnd = order.indexOf("end:b");
    expect(aEnd < bStart !== bEnd < aStart).toBe(true);
    expect(order.indexOf("end:c")).toBeLessThan(Math.max(aEnd, bEnd));
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

it("background repository locks fail fast instead of retrying", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "f5-repository-background-"));
  const common = path.join(base, "common");
  await fs.mkdir(common);
  const lockPath = repositoryLockPath(base, await fs.realpath(common));
  const otherProfile = await acquireInstanceLock(lockPath);
  try {
    const started = Date.now();
    const exit = await Effect.runPromiseExit(
      withRepositoryLifecycleLock(base, common, Effect.succeed("unexpected"), {
        mode: "background",
      }),
    );
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("RepositoryBusyError");
    expect(Date.now() - started).toBeLessThan(90);
  } finally {
    otherProfile.release();
    await fs.rm(base, { recursive: true, force: true });
  }
});
