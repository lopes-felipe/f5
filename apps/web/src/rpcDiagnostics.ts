import type { ClientRpcDiagnosticsCounters } from "@t3tools/contracts";

export type RpcDiagnosticCounter = keyof ClientRpcDiagnosticsCounters;

/**
 * Upper bounds (ms) of the nine queue-wait buckets, whose lower edges are 0,
 * 50, 100, 250, 500, 1k, 2.5k, 10k and 30k.
 */
export const RPC_QUEUE_WAIT_BOUNDS_MS = [50, 100, 250, 500, 1_000, 2_500, 10_000, 30_000, Infinity];

const zero = (): ClientRpcDiagnosticsCounters => ({
  rpcBusy: 0,
  rpcServerStarting: 0,
  rpcTimeouts: 0,
  rpcQueueExpired: 0,
  rpcBackgroundShed: 0,
  rpcOrphanReleased: 0,
  rpcConnectionNotReady: 0,
});

let counters = zero();
let queueWaitBuckets = Array<number>(RPC_QUEUE_WAIT_BOUNDS_MS.length).fill(0);

export function countRpcDiagnostic(name: RpcDiagnosticCounter): void {
  counters = { ...counters, [name]: counters[name] + 1 };
}

/** Records how long a request waited between creation and send. */
export function recordRpcQueueWait(waitMs: number): void {
  queueWaitBuckets[RPC_QUEUE_WAIT_BOUNDS_MS.findIndex((upper) => waitMs < upper)]!++;
}

/** Cumulative since page load, like the other client diagnostics counters. */
export function readRpcDiagnostics(): {
  readonly counters: ClientRpcDiagnosticsCounters;
  readonly queueWaitBuckets: readonly number[];
} {
  return { counters, queueWaitBuckets: [...queueWaitBuckets] };
}

export function resetRpcDiagnosticsForTests(): void {
  counters = zero();
  queueWaitBuckets = Array<number>(RPC_QUEUE_WAIT_BOUNDS_MS.length).fill(0);
}
