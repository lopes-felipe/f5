import { afterEach, expect, it, vi } from "vitest";
import { startClientDiagnostics } from "./clientDiagnostics";
import type { ClientDiagnosticsCounters, ReportClientDiagnosticsInput } from "@t3tools/contracts";
afterEach(() => vi.useRealTimers());
it("reports cumulative page counters on hide and across controller replacement without retaining listeners", async () => {
  vi.useFakeTimers();
  const reports: ReportClientDiagnosticsInput[] = [];
  const connectionListeners = new Set<() => void>(),
    hiddenListeners = new Set<() => void>();
  let connected = true;
  let counters: ClientDiagnosticsCounters = {
    snapshotSyncs: 2,
    gapRecoveries: 1,
    bufferOverflows: 0,
    poisonBatches: 0,
    connectedMs: 0,
  };
  const deps = {
    read: () => ({ counters, applyBatchBuckets: [2, 0, 0, 0, 0, 0, 0, 0, 0] }),
    report: async (report: ReportClientDiagnosticsInput) => {
      reports.push(report);
    },
    clientKind: "web" as const,
    connected: () => connected,
    subscribeConnection: (callback: () => void) => {
      connectionListeners.add(callback);
      return () => {
        connectionListeners.delete(callback);
      };
    },
    onHidden: (callback: () => void) => {
      hiddenListeners.add(callback);
      return () => {
        hiddenListeners.delete(callback);
      };
    },
    now: Date.now,
    scheduler: {
      setTimeout: (callback: () => void, milliseconds: number) =>
        setTimeout(callback, milliseconds) as unknown as number,
      clearTimeout,
    },
  };
  const first = startClientDiagnostics(deps);
  await vi.advanceTimersByTimeAsync(100);
  for (const callback of hiddenListeners) callback();
  const initial = reports.at(-1)!;
  expect(initial.counters.snapshotSyncs).toBe(2);
  expect(initial.counters.connectedMs).toBe(100);
  connected = false;
  for (const callback of connectionListeners) callback();
  await vi.advanceTimersByTimeAsync(100);
  first.dispose();
  expect(reports.at(-1)!.counters.connectedMs).toBe(100);
  counters = { ...counters, snapshotSyncs: 3, gapRecoveries: 0 };
  const second = startClientDiagnostics(deps);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(reports.at(-1)!.sessionId).toBe(initial.sessionId);
  expect(reports.at(-1)!.reportSeq).toBeGreaterThan(initial.reportSeq);
  expect(reports.at(-1)!.counters.snapshotSyncs).toBe(5);
  expect(reports.at(-1)!.counters.gapRecoveries).toBe(1);
  second.dispose();
  second.dispose();
  expect(vi.getTimerCount()).toBe(0);
  expect(connectionListeners.size).toBe(0);
  expect(hiddenListeners.size).toBe(0);
});
