import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import type { OrchestrationEvent, OrchestrationReadModel } from "@t3tools/contracts";
import { Effect, Exit, Queue, Scope, Stream } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { it as effectIt } from "@effect/vitest";
import { TestClock } from "effect/testing";
import { removeScratchThreadFolder } from "../project/scratchFolderCleanup.ts";

import { startScratchFolderCleanupReactor } from "./scratchFolderCleanupReactor.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) FS.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = FS.realpathSync(FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-scratch-cleanup-")));
  roots.push(root);
  const folder = (name: string) => {
    const path = Path.join(root, name);
    FS.mkdirSync(path);
    FS.writeFileSync(Path.join(path, "notes.md"), "work");
    return path;
  };
  const thread = (id: string, scratchPath: string, deletedAt: string | null) => ({
    id,
    projectId: "scratch",
    scratchPath,
    deletedAt,
  });
  return { root, folder, thread };
}

async function run(
  readModel: unknown,
  deletedThreadIds: ReadonlyArray<string>,
  settled: () => boolean,
  remove = vi.fn(async (folder: string) => FS.rmSync(folder, { recursive: true, force: true })),
) {
  const events = await Effect.runPromise(Queue.unbounded<OrchestrationEvent>());
  const engine = {
    getReadModel: () => Effect.succeed(readModel as OrchestrationReadModel),
    streamDomainEvents: Stream.fromQueue(events),
  } as unknown as OrchestrationEngineShape;
  const scope = await Effect.runPromise(Scope.make("sequential"));
  await Effect.runPromise(
    startScratchFolderCleanupReactor(engine, remove).pipe(Scope.provide(scope)),
  );
  for (const threadId of deletedThreadIds)
    await Effect.runPromise(
      Queue.offer(events, {
        type: "thread.deleted",
        payload: { threadId },
      } as unknown as OrchestrationEvent),
    );
  await vi.waitFor(() => expect(settled()).toBe(true));
  await Effect.runPromise(Scope.close(scope, Exit.void));
  return remove;
}

it("removes a deleted thread's own scratch folder", async () => {
  const { root, folder, thread } = fixture();
  const mine = folder("2026-10-23-fix-the-build-abcd1234");
  const kept = folder("2026-10-23-other-work-ef567890");
  await run(
    {
      projects: [{ id: "scratch", kind: "scratch", workspaceRoot: root }],
      threads: [thread("gone", mine, "2026-10-23T10:00:00.000Z"), thread("live", kept, null)],
    },
    ["gone"],
    () => !FS.existsSync(mine),
  );
  expect(FS.existsSync(kept)).toBe(true);
});

it("recovers a deletion missed while the server was down", async () => {
  const { root, folder, thread } = fixture();
  const mine = folder("missed-12345678");
  await run(
    {
      projects: [{ id: "scratch", kind: "scratch", workspaceRoot: root }],
      threads: [thread("gone", mine, "2026-10-23T10:00:00Z")],
    },
    [],
    () => !FS.existsSync(mine),
  );
});

it("refuses symlinks, keeps archived folders, and permits authorized archived purges", async () => {
  const { root, folder, thread } = fixture();
  const mine = folder("archive-12345678");
  const link = Path.join(root, "linked-12345678");
  FS.symlinkSync(mine, link, "dir");
  const model = {
    projects: [{ id: "scratch", kind: "scratch", workspaceRoot: root }],
    threads: [
      { ...thread("archive", mine, null), archivedAt: "2026-10-23T10:00:00Z" },
      thread("link", link, "2026-10-23T10:00:00Z"),
    ],
  } as unknown as OrchestrationReadModel;
  expect(
    await removeScratchThreadFolder({ readModel: model, threadId: "link" as never }),
  ).toMatchObject({ kind: "refused" });
  expect(
    await removeScratchThreadFolder({ readModel: model, threadId: "archive" as never }),
  ).toMatchObject({ kind: "refused" });
  expect(FS.existsSync(mine)).toBe(true);
  expect(
    await removeScratchThreadFolder({
      readModel: model,
      threadId: "archive" as never,
      allowArchived: true,
    }),
  ).toEqual({ kind: "removed" });
  expect(
    await removeScratchThreadFolder({
      readModel: model,
      threadId: "archive" as never,
      allowArchived: true,
    }),
  ).toEqual({ kind: "missing" });
});

const advanceUntil = (ready: () => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 1_000 && !ready(); i++) {
      yield* TestClock.adjust("100 millis");
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
    }
    expect(ready()).toBe(true);
  });

effectIt.effect("retries transient failures and deduplicates concurrent deletion events", () =>
  Effect.gen(function* () {
    const { root, folder, thread } = fixture();
    const mine = folder("retry-12345678");
    const model = {
      projects: [{ id: "scratch", kind: "scratch", workspaceRoot: root }],
      threads: [thread("gone", mine, "2026-10-23T10:00:00Z")],
    };
    const events = yield* Queue.unbounded<OrchestrationEvent>();
    let reads = 0;
    const engine = {
      getReadModel: () =>
        Effect.sync(() => {
          reads++;
          return model as unknown as OrchestrationReadModel;
        }),
      streamDomainEvents: Stream.fromQueue(events),
    } as unknown as OrchestrationEngineShape;
    let calls = 0;
    yield* startScratchFolderCleanupReactor(engine, async (path) => {
      calls++;
      if (calls === 1) throw new Error("EBUSY");
      FS.rmSync(path, { recursive: true, force: true });
    });
    for (let i = 0; i < 5; i++)
      yield* Queue.offer(events, {
        type: "thread.deleted",
        payload: { threadId: "gone" },
      } as unknown as OrchestrationEvent);
    yield* advanceUntil(() => !FS.existsSync(mine));
    expect(calls).toBe(2);
    expect(reads).toBeGreaterThanOrEqual(3);
  }).pipe(Effect.scoped),
);

effectIt.effect(
  "retains deleted metadata after retry exhaustion and cancels waits with the scope",
  () =>
    Effect.gen(function* () {
      const { root, folder, thread } = fixture();
      const mine = folder("exhaust-12345678");
      const model = {
        projects: [{ id: "scratch", kind: "scratch", workspaceRoot: root }],
        threads: [thread("gone", mine, "2026-10-23T10:00:00Z")],
      };
      const engine = {
        getReadModel: () => Effect.succeed(model as unknown as OrchestrationReadModel),
        streamDomainEvents: Stream.never,
      } as unknown as OrchestrationEngineShape;
      let calls = 0;
      const scope = yield* Scope.make("sequential");
      yield* startScratchFolderCleanupReactor(engine, async () => {
        calls++;
        throw new Error("EBUSY");
      }).pipe(Scope.provide(scope));
      yield* advanceUntil(() => calls === 4);
      yield* TestClock.adjust("1 minute");
      expect(calls).toBe(4);
      expect(FS.existsSync(mine)).toBe(true);
      expect(model.threads).toHaveLength(1);
      yield* Scope.close(scope, Exit.void);
      const nextScope = yield* Scope.make("sequential");
      yield* startScratchFolderCleanupReactor(engine, async () => {
        calls++;
        throw new Error("EBUSY");
      }).pipe(Scope.provide(nextScope));
      yield* advanceUntil(() => calls === 5);
      yield* Scope.close(nextScope, Exit.void);
      yield* TestClock.adjust("1 minute");
      expect(calls).toBe(5);
    }).pipe(Effect.scoped),
);

it("leaves folders it does not own as a deleted thread's own", async () => {
  const { root, folder, thread } = fixture();
  const shared = folder("2026-10-23-shared-abcd1234");
  const marker = folder("2026-10-23-marker-00000000");
  const markerHandled = () => !FS.existsSync(marker);
  const outside = FS.realpathSync(FS.mkdtempSync(Path.join(OS.tmpdir(), "f5-not-scratch-")));
  roots.push(outside);
  const remove = await run(
    {
      projects: [
        { id: "scratch", kind: "scratch", workspaceRoot: root },
        { id: "repo", kind: "project", workspaceRoot: outside },
      ],
      threads: [
        // Another live thread still works in this folder.
        thread("gone", shared, "2026-10-23T10:00:00.000Z"),
        thread("fork", shared, null),
        // The shared root itself is never a thread's folder.
        thread("root", root, "2026-10-23T10:00:00.000Z"),
        // A project thread is not a scratch thread.
        { ...thread("project", outside, "2026-10-23T10:00:00.000Z"), projectId: "repo" },
        // Still live.
        thread("live", shared, null),
        thread("marker", marker, "2026-10-23T10:00:00.000Z"),
      ],
    },
    ["gone", "root", "project", "live", "marker"],
    // Each deletion is handled in order, so a final marker deletion shows the rest are done.
    () => markerHandled(),
  );
  expect(remove.mock.calls).toEqual([[marker]]);
  expect(FS.existsSync(shared)).toBe(true);
  expect(FS.existsSync(outside)).toBe(true);
});
