import type { ClientDiagnosticsCounters, ReportClientDiagnosticsInput } from "@t3tools/contracts";
import { readRpcDiagnostics } from "../rpcDiagnostics";

const zero = (): ClientDiagnosticsCounters => ({
  snapshotSyncs: 0,
  gapRecoveries: 0,
  bufferOverflows: 0,
  poisonBatches: 0,
  connectedMs: 0,
});
const names = [
  "snapshotSyncs",
  "gapRecoveries",
  "bufferOverflows",
  "poisonBatches",
  "connectedMs",
] as const;
let page:
  | { sessionId: string; reportSeq: number; counters: ClientDiagnosticsCounters; buckets: number[] }
  | undefined;

export function startClientDiagnostics(deps: {
  readonly read: () => {
    counters: ClientDiagnosticsCounters;
    applyBatchBuckets: readonly number[];
  };
  readonly report: (input: ReportClientDiagnosticsInput) => Promise<void>;
  readonly clientKind: "desktop" | "web";
  readonly connected: () => boolean;
  readonly subscribeConnection: (callback: () => void) => () => void;
  readonly onHidden: (callback: () => void) => () => void;
  readonly now: () => number;
  readonly scheduler: {
    setTimeout(callback: () => void, milliseconds: number): number;
    clearTimeout(id: number): void;
  };
}) {
  const session = (page ??= {
    sessionId: crypto.randomUUID(),
    reportSeq: 0,
    counters: zero(),
    buckets: Array<number>(9).fill(0),
  });
  let previous = {
    counters: zero(),
    applyBatchBuckets: Array<number>(9).fill(0) as readonly number[],
  };
  let lastTick = deps.now(),
    connected = deps.connected(),
    disposed = false;
  const tick = () => {
    const now = deps.now();
    if (connected)
      session.counters = {
        ...session.counters,
        connectedMs: session.counters.connectedMs + Math.max(0, now - lastTick),
      };
    lastTick = now;
    connected = deps.connected();
  };
  const unsubscribe = deps.subscribeConnection(tick);
  const report = () => {
    tick();
    const current = deps.read();
    for (const name of names)
      if (name !== "connectedMs")
        session.counters = {
          ...session.counters,
          [name]:
            session.counters[name] + Math.max(0, current.counters[name] - previous.counters[name]),
        };
    current.applyBatchBuckets.forEach((count, index) => {
      session.buckets[index]! += Math.max(0, count - previous.applyBatchBuckets[index]!);
    });
    previous = current;
    // Transport counters are already cumulative for the page, like `session`.
    const rpc = readRpcDiagnostics();
    try {
      void deps
        .report({
          sessionId: session.sessionId,
          reportSeq: ++session.reportSeq,
          clientKind: deps.clientKind,
          counters: { ...session.counters, connectedMs: Math.floor(session.counters.connectedMs) },
          applyBatchBuckets: [...session.buckets],
          rpcCounters: rpc.counters,
          rpcQueueWaitBuckets: [...rpc.queueWaitBuckets],
        })
        .catch(() => {});
    } catch {
      // Diagnostics must not prevent disposing the stream or its listeners.
    }
  };
  const unsubscribeHidden = deps.onHidden(report);
  let timer: number;
  const schedule = () => {
    timer = deps.scheduler.setTimeout(() => {
      report();
      if (!disposed) schedule();
    }, 300_000);
  };
  schedule();
  return {
    report,
    dispose() {
      if (disposed) return;
      disposed = true;
      report();
      unsubscribe();
      unsubscribeHidden();
      deps.scheduler.clearTimeout(timer);
    },
  };
}
