import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import type { OrchestrationEvent, OrchestrationReadModel } from "@t3tools/contracts";
import { Effect, Exit, Queue, Scope, Stream } from "effect";
import { afterEach, expect, it, vi } from "vitest";

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
