import path from "node:path";
import { WS_METHODS } from "@t3tools/contracts";
import { Effect, Exit, Option } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";

import { storageRoutes } from "./storageRoutes.ts";

const fakeWs = {} as WebSocket;

describe("storageRoutes", () => {
  it("fails storage.getDiskSpace cleanly when monitor is unavailable", async () => {
    const routes = storageRoutes({
      stateDir: "/tmp/f5-test",
      path,
      sql: {} as SqlClient.SqlClient,
      diskSpaceMonitor: Option.none(),
      runtime: Effect.die("unused"),
    });

    const exit = await Effect.runPromiseExit(
      routes[WS_METHODS.storageGetDiskSpace](
        { _tag: WS_METHODS.storageGetDiskSpace, force: true },
        fakeWs,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("merges storage cleanup and default-branch auto-pull dry-run targets", async () => {
    const cleanupTarget = { kind: "worktree" } as never;
    const pullTarget = { kind: "pull" } as never;
    const noteStorageChanged = vi.fn(() => Effect.void);
    const scheduleCompaction = vi.fn(() => Effect.succeed({ scheduled: true } as never));

    const routes = storageRoutes({
      stateDir: "/tmp/f5-test",
      path,
      sql: {} as SqlClient.SqlClient,
      diskSpaceMonitor: Option.some({
        getStatus: () => Effect.succeed({ ok: true } as never),
        noteStorageChanged: Effect.suspend(noteStorageChanged),
      } as never),
      runtime: Effect.succeed({
        storageMaintenance: { scheduleCompaction } as never,
        storageCleanupWorker: {
          dryRun: Effect.succeed({ targets: [cleanupTarget], totalBytes: 10 } as never),
        } as never,
        defaultBranchAutoPull: {
          dryRun: Effect.succeed([pullTarget] as never),
        } as never,
      }),
    });

    const dryRun = await Effect.runPromise(
      routes[WS_METHODS.storageAutomationDryRun](
        { _tag: WS_METHODS.storageAutomationDryRun },
        fakeWs,
      ),
    );
    expect(dryRun).toEqual({ targets: [cleanupTarget, pullTarget], totalBytes: 10 });

    await Effect.runPromise(
      routes[WS_METHODS.storageScheduleCompaction](
        { _tag: WS_METHODS.storageScheduleCompaction, when: "nextRestart" } as never,
        fakeWs,
      ),
    );
    expect(scheduleCompaction).toHaveBeenCalledWith("nextRestart");
    expect(noteStorageChanged).toHaveBeenCalledTimes(1);
  });
});
