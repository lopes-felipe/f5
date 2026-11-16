import { expect, it, vi } from "vitest";
import { startDeferredClientDiagnostics } from "./deferredClientDiagnostics";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function dependencies() {
  return {
    read: vi.fn(() => ({
      counters: {
        snapshotSyncs: 1,
        gapRecoveries: 0,
        bufferOverflows: 0,
        poisonBatches: 0,
        connectedMs: 0,
      },
      applyBatchBuckets: Array<number>(9).fill(0),
    })),
    report: vi.fn(async () => {}),
    clientKind: "web" as const,
    connected: () => true,
    subscribeConnection: vi.fn(() => () => {}),
    onHidden: vi.fn(() => () => {}),
    now: () => 0,
    scheduler: { setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() },
  };
}

it("reads accumulated router counters after loading and disposes the reporter once", async () => {
  const loaded = deferred<typeof import("./clientDiagnostics")>();
  const deps = dependencies();
  const bootstrap = startDeferredClientDiagnostics(deps, () => loaded.promise);
  expect(deps.subscribeConnection).not.toHaveBeenCalled();
  loaded.resolve(await import("./clientDiagnostics"));
  await loaded.promise;
  expect(deps.subscribeConnection).toHaveBeenCalledTimes(1);
  bootstrap.dispose();
  bootstrap.dispose();
  expect(deps.scheduler.clearTimeout).toHaveBeenCalledTimes(1);
  expect(deps.report).toHaveBeenCalledWith(
    expect.objectContaining({
      counters: expect.objectContaining({ snapshotSyncs: 1 }),
    }),
  );
});

it("starts no timers or listeners when disposed before loading finishes", async () => {
  const loaded = deferred<typeof import("./clientDiagnostics")>();
  const start = vi.fn();
  const deps = dependencies();
  const bootstrap = startDeferredClientDiagnostics(deps, () => loaded.promise);
  bootstrap.dispose();
  loaded.resolve({
    startClientDiagnostics: start,
  } as unknown as typeof import("./clientDiagnostics"));
  await loaded.promise;
  expect(start).not.toHaveBeenCalled();
  expect(deps.scheduler.setTimeout).not.toHaveBeenCalled();
  expect(deps.subscribeConnection).not.toHaveBeenCalled();
});

it("releases reporter resources when sending diagnostics throws synchronously", async () => {
  const loaded = deferred<typeof import("./clientDiagnostics")>();
  const deps = dependencies();
  deps.report.mockImplementation(() => {
    throw new Error("RPC transport unavailable");
  });
  const unsubscribe = vi.fn();
  deps.subscribeConnection.mockReturnValue(unsubscribe);
  deps.onHidden.mockReturnValue(unsubscribe);
  const bootstrap = startDeferredClientDiagnostics(deps, () => loaded.promise);
  loaded.resolve(await import("./clientDiagnostics"));
  await loaded.promise;
  expect(() => bootstrap.dispose()).not.toThrow();
  expect(unsubscribe).toHaveBeenCalledTimes(2);
  expect(deps.scheduler.clearTimeout).toHaveBeenCalledTimes(1);
});

it("isolates a reporting module failure from the synchronization controller", async () => {
  const failure = new Error("diagnostics chunk unavailable");
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const bootstrap = startDeferredClientDiagnostics(dependencies(), () => Promise.reject(failure));
    await Promise.resolve();
    await Promise.resolve();
    expect(warning).toHaveBeenCalledWith("Client diagnostics could not start", failure);
    bootstrap.dispose();
  } finally {
    warning.mockRestore();
  }
});
