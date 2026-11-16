import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { Deferred, Effect } from "effect";
import { afterEach, expect, test, vi } from "vitest";
import type { StorageUsageReport } from "@t3tools/contracts";
import { makeUsageScanCoordinator } from "./usageScanCoordinator.ts";
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
const roots: string[] = [];
async function fixture() {
  const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-scan-coordinator-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((path) => FS.rm(path, { recursive: true, force: true })));
});
test("joins a scan until persistence finishes before admitting a new scan", async () => {
  const stateDir = await fixture();
  const writeFile = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"))
    .writeFile;
  let releaseWrite!: () => void;
  let notifyWrite!: () => void;
  const writing = new Promise<void>((resolve) => {
    notifyWrite = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  vi.mocked(FS.writeFile).mockImplementationOnce(async (...args) => {
    notifyWrite();
    await release;
    return writeFile(...args);
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const releaseFirstScan = yield* Deferred.make<void>();
        let calls = 0;
        const coordinator = yield* makeUsageScanCoordinator({
          stateDir,
          scan: () =>
            Effect.gen(function* () {
              if (++calls > 1) {
                yield* Deferred.succeed(entered, undefined);
                return yield* Effect.never;
              }
              yield* Deferred.await(releaseFirstScan);
              return report();
            }),
        });
        yield* coordinator.request();
        const first = (yield* coordinator.snapshot).running!;
        yield* Deferred.succeed(releaseFirstScan, undefined);
        yield* Effect.promise(() => writing);
        yield* coordinator.request(true);
        expect(calls).toBe(1);
        expect((yield* coordinator.snapshot).running).toBe(first);
        releaseWrite();
        yield* Deferred.await(first);
        // Finalizers run after completing the first scan's Deferred.
        yield* Effect.yieldNow;
        expect((yield* coordinator.snapshot).running).toBeNull();
        yield* coordinator.request(true);
        yield* Deferred.await(entered);
        expect(calls).toBe(2);
      }),
    ),
  );
});
const report = (): StorageUsageReport => ({
  scanId: crypto.randomUUID(),
  scannedAt: new Date().toISOString(),
  stateDir: "/fixture",
  totalUsedBytes: 0,
  reclaimableBytes: 0,
  databaseBytes: 0,
  worktreesBytes: 0,
  logsBytes: 0,
  attachmentsBytes: 0,
  legacyBytes: 0,
  providerHomesBytes: 0,
  otherBytes: 0,
  providerHomes: [],
  warningsTruncated: false,
  threadCount: 0,
  archivedThreadCount: 0,
  deletedThreadCount: 0,
  providerLogSegmentCount: 0,
  envOverrideActive: false,
  categories: [],
  warnings: [],
});
test("persists bounded target previews while retaining the full current scan", async () => {
  const stateDir = await fixture();
  const full: StorageUsageReport = {
    ...report(),
    categories: [
      {
        id: "orphanAttachments",
        section: "attachments",
        title: "Attachments",
        description: "Orphan attachments",
        bytes: 1000,
        reclaimableBytes: 1000,
        measurement: "complete",
        eligibleThreadCount: 0,
        defaultSelected: false,
        impact: "low",
        availability: "ready",
        targetCount: 1000,
        warnings: [],
        targets: Array.from({ length: 1000 }, (_, id) => ({
          id: String(id),
          label: String(id),
          bytes: id,
          safeToDelete: true,
        })),
      },
    ],
  };
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* makeUsageScanCoordinator({
          stateDir,
          scan: () => Effect.succeed(full),
        });
        yield* coordinator.request();
        const running = (yield* coordinator.snapshot).running!;
        yield* Deferred.await(running);
        expect((yield* coordinator.snapshot).latest?.report.categories[0]?.targets).toHaveLength(
          1000,
        );
        const persisted = JSON.parse(
          yield* Effect.promise(() =>
            FS.readFile(Path.join(stateDir, "storage-usage.json"), "utf8"),
          ),
        ) as StorageUsageReport;
        expect(persisted.categories[0]?.targets).toHaveLength(500);
        expect(persisted.categories[0]?.targetCount).toBe(1000);
        expect(persisted.categories[0]?.targets[0]?.bytes).toBe(999);
      }),
    ),
  );
});
test("concurrent requests join one scan and do not wait for completion", async () => {
  const stateDir = await fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>(),
          release = yield* Deferred.make<void>();
        let calls = 0;
        const coordinator = yield* makeUsageScanCoordinator({
          stateDir,
          scan: () =>
            Effect.gen(function* () {
              calls++;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return report();
            }),
        });
        yield* coordinator.request();
        yield* coordinator.request(true);
        yield* Deferred.await(entered);
        expect(calls).toBe(1);
        expect((yield* coordinator.snapshot).scan.state).toBe("scanning");
        yield* Deferred.succeed(release, undefined);
        expect((yield* coordinator.awaitLatest)?.generation).toBe(0);
      }),
    ),
  );
});
test("mutations during a scan rerun; three discarded generations remain non-actionable", async () => {
  const stateDir = await fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        let mutate: Effect.Effect<void> = Effect.void,
          calls = 0;
        const coordinator = yield* makeUsageScanCoordinator({
          stateDir,
          scan: () =>
            Effect.gen(function* () {
              calls++;
              yield* mutate;
              return report();
            }),
        });
        mutate = coordinator.noteMutated;
        yield* coordinator.request();
        yield* coordinator.awaitLatest;
        const state = yield* coordinator.snapshot;
        expect(calls).toBe(3);
        expect(state.latest?.generation).not.toBe(state.generation);
        expect(state.running).toBeNull();
      }),
    ),
  );
});
test("failures retain the latest report; cooldown suppresses retry unless forced", async () => {
  const stateDir = await fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        let fail = false,
          calls = 0;
        const coordinator = yield* makeUsageScanCoordinator({
          stateDir,
          scan: () =>
            Effect.suspend(() => {
              calls++;
              return fail ? Effect.fail(new Error("permission denied")) : Effect.succeed(report());
            }),
        });
        yield* coordinator.request();
        const first = yield* coordinator.awaitLatest;
        fail = true;
        yield* coordinator.request(true);
        yield* coordinator.awaitLatest;
        const failed = yield* coordinator.snapshot;
        expect(failed.latest).toEqual(first);
        expect(failed.scan.state).toBe("failed");
        yield* coordinator.request();
        expect(calls).toBe(2);
        yield* coordinator.request(true);
        yield* coordinator.awaitLatest;
        expect(calls).toBe(3);
      }),
    ),
  );
});
test("persisted reports load immediately with no cleanup authority", async () => {
  const stateDir = await fixture(),
    persisted = report();
  await FS.writeFile(Path.join(stateDir, "storage-usage.json"), JSON.stringify(persisted));
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const coordinator = yield* makeUsageScanCoordinator({ stateDir, scan: () => Effect.never });
        const state = yield* coordinator.snapshot;
        expect(state.latest?.report).toEqual(persisted);
        expect(state.latest?.generation).toBe(-1);
        expect(state.generation).toBe(0);
      }),
    ),
  );
});
test("closing the layer scope aborts the underlying walk", async () => {
  const stateDir = await fixture();
  let signal: AbortSignal | undefined;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const coordinator = yield* makeUsageScanCoordinator({
          stateDir,
          scan: (next) => {
            signal = next;
            return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
          },
        });
        yield* coordinator.request();
        yield* Deferred.await(entered);
      }),
    ),
  );
  expect(signal?.aborted).toBe(true);
});

test("accounts for its own persisted file with Windows logical-byte semantics", async () => {
  const stateDir = await fixture();
  await FS.writeFile(Path.join(stateDir, "storage-usage.json"), "{}");
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directoryBytes = yield* Effect.promise(async () => (await FS.lstat(stateDir)).size);
        const coordinator = yield* makeUsageScanCoordinator({
          stateDir,
          measureBytes: (stat) => stat.size,
          scan: () =>
            Effect.succeed({
              report: {
                ...report(),
                stateDir,
                totalUsedBytes: directoryBytes + 2,
                otherBytes: directoryBytes + 2,
              },
              persistenceBytes: { file: 2, directory: directoryBytes },
            }),
        });
        yield* coordinator.request(true);
        const latest = (yield* coordinator.awaitLatest)!.report;
        const text = yield* Effect.promise(() =>
          FS.readFile(Path.join(stateDir, "storage-usage.json"), "utf8"),
        );
        const directoryAfter = yield* Effect.promise(() => FS.lstat(stateDir));
        expect(latest.totalUsedBytes).toBe(directoryAfter.size + Buffer.byteLength(text));
        expect(latest.otherBytes).toBe(latest.totalUsedBytes);
        expect(JSON.parse(text)).toEqual(latest);
      }),
    ),
  );
});
