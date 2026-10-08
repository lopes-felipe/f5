import type { DiskSpaceReclaimableItem } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../config.ts";
import { makeDiskSpaceMonitor } from "./DiskSpaceMonitor.ts";
import type { VolumeStat } from "./diskSpace.ts";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** A monitor on one fake volume whose free space and clock the test controls. */
function harness() {
  const disk = { freeBytes: 50 * GB, readable: true, stalled: false, probes: 0 };
  const clock = { nowMs: Date.parse("2026-10-08T00:00:00.000Z") };
  const readStat = async (): Promise<VolumeStat> => {
    disk.probes += 1;
    if (disk.stalled) return new Promise(() => {});
    if (!disk.readable) throw new Error("EIO");
    return { device: 1, freeBytes: disk.freeBytes, totalBytes: 500 * GB };
  };
  const layer = ServerConfig.layerTest(process.cwd(), { prefix: "f5-disk-space-monitor-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  );
  const run = <A, E>(
    body: (
      monitor: Effect.Success<ReturnType<typeof makeDiskSpaceMonitor>>,
    ) => Effect.Effect<A, E, import("effect").Scope.Scope>,
  ) =>
    Effect.runPromise(
      makeDiskSpaceMonitor({ readStat, probeTimeoutMs: 20, now: () => clock.nowMs }).pipe(
        Effect.flatMap(body),
        Effect.scoped,
        Effect.provide(layer),
      ),
    );
  return { disk, clock, run };
}

describe("DiskSpaceMonitor", () => {
  it("holds turns only below the critical threshold, and rechecks a stale status", async () => {
    const { disk, clock, run } = harness();
    await run((monitor) =>
      Effect.gen(function* () {
        const ok = yield* monitor.getStatus();
        expect(ok.level).toBe("ok");
        expect(ok.volumes[0]?.roles).toEqual(["userdata"]);
        expect(yield* monitor.turnStartHold).toBeNull();

        disk.freeBytes = 5 * GB;
        // Within the reuse window the earlier check still answers.
        expect((yield* monitor.getStatus()).level).toBe("ok");
        expect((yield* monitor.getStatus({ force: true })).level).toBe("low");
        expect(yield* monitor.turnStartHold).toBeNull();

        disk.freeBytes = 1 * GB;
        clock.nowMs += 10_000;
        const hold = yield* monitor.turnStartHold;
        expect(hold).toContain("New turns are held");

        // An unreadable disk never blocks turns.
        disk.readable = false;
        clock.nowMs += 10_000;
        const unreadable = yield* monitor.getStatus();
        expect(unreadable.volumes).toEqual([]);
        expect(yield* monitor.turnStartHold).toBeNull();
      }),
    );
  });

  it("does not wait on a volume that stops answering, or probe it again while stalled", async () => {
    const { disk, clock, run } = harness();
    await run((monitor) =>
      Effect.gen(function* () {
        disk.stalled = true;
        // Probes are per watched path (userdata and worktrees here).
        expect(yield* monitor.turnStartHold).toBeNull();
        const stalledProbes = disk.probes;
        clock.nowMs += 10_000;
        expect((yield* monitor.getStatus()).volumes).toEqual([]);
        expect(disk.probes).toBe(stalledProbes);
      }),
    );
  });

  it("drops a reclaimable estimate that finishes after space recovered", async () => {
    const { disk, run } = harness();
    disk.freeBytes = 1 * GB;
    let finishEstimate: () => void = () => {};
    let estimates = 0;
    await run((monitor) =>
      Effect.gen(function* () {
        yield* monitor.start({
          estimateReclaimable: Effect.callback<ReadonlyArray<DiskSpaceReclaimableItem>>(
            (resume) => {
              estimates += 1;
              finishEstimate = () =>
                resume(
                  Effect.succeed([
                    { categoryId: "codexMarketplaceStaging", title: "Stale", bytes: GB },
                  ]),
                );
            },
          ),
        });
        while (estimates === 0) yield* Effect.sleep("5 millis");
        disk.freeBytes = 50 * GB;
        expect((yield* monitor.getStatus({ force: true })).level).toBe("ok");
        finishEstimate();
        yield* Effect.sleep("5 millis");
        disk.freeBytes = 1 * GB;
        expect((yield* monitor.getStatus({ force: true })).reclaimable).toEqual([]);
      }),
    );
  });

  it("pushes level changes but not small drift in free space", async () => {
    const { disk, run } = harness();
    await run((monitor) =>
      Effect.gen(function* () {
        const collected = yield* monitor.changes.pipe(
          Stream.take(3),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* monitor.getStatus({ force: true });
        // Small drift, even across a round number, is not pushed.
        disk.freeBytes -= 10 * MB;
        yield* monitor.getStatus({ force: true });
        disk.freeBytes -= 200 * MB;
        yield* monitor.getStatus({ force: true });
        disk.freeBytes = 5 * GB;
        yield* monitor.getStatus({ force: true });
        disk.freeBytes = 50 * GB;
        yield* monitor.getStatus({ force: true });
        const statuses = yield* Fiber.join(collected);
        expect(statuses.map((status) => status.level)).toEqual(["ok", "low", "ok"]);
      }),
    );
  });

  it("attaches the largest reclaimable items while space is short", async () => {
    const { disk, run } = harness();
    disk.freeBytes = 1 * GB;
    let estimates = 0;
    await run((monitor) =>
      Effect.gen(function* () {
        const withItems = yield* monitor.changes.pipe(
          Stream.filter((status) => status.reclaimable.length > 0),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* monitor.start({
          estimateReclaimable: Effect.sync(() => {
            estimates += 1;
            return Array.from({ length: 7 }, (_, index) => ({
              categoryId: "codexMarketplaceStaging" as const,
              title: `Item ${index}`,
              bytes: (7 - index) * GB,
            }));
          }),
        });
        const [status] = yield* Fiber.join(withItems);
        expect(status?.level).toBe("critical");
        expect(status?.reclaimable.map((item) => item.title)).toEqual([
          "Item 0",
          "Item 1",
          "Item 2",
          "Item 3",
          "Item 4",
        ]);
        expect(estimates).toBe(1);
        // A later check keeps the list instead of dropping it.
        expect((yield* monitor.getStatus({ force: true })).reclaimable).toHaveLength(5);

        // A cleanup makes the list stale: it goes until the next scan.
        disk.freeBytes = 3 * GB;
        yield* monitor.noteStorageChanged;
        const cleaned = yield* monitor.getStatus();
        expect(cleaned.level).toBe("low");
        expect(cleaned.reclaimable).toEqual([]);

        disk.freeBytes = 50 * GB;
        expect((yield* monitor.getStatus({ force: true })).reclaimable).toEqual([]);
      }),
    );
  });
});
