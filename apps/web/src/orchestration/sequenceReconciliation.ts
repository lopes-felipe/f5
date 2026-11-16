import type { OrchestrationGetLatestSequenceResult } from "@t3tools/contracts";
import { raceWithAbort } from "@t3tools/shared/abortSignal";

interface ReconciliationDeps {
  readonly probe: () => Promise<OrchestrationGetLatestSequenceResult>;
  readonly committedSequence: () => number;
  readonly incarnation: () => string | undefined;
  readonly recoverIncarnation: (incarnation: string) => Promise<void>;
  readonly waitForSequence: (target: number, signal: AbortSignal) => Promise<void>;
  readonly syncSnapshot: () => Promise<void>;
  readonly connected: () => boolean;
  readonly subscribeConnection: (callback: () => void) => () => void;
  readonly scheduler: {
    setTimeout(callback: () => void, milliseconds: number): number;
    clearTimeout(id: number): void;
  };
  readonly now: () => number;
}

/** One fixed target per minute; ten-minute snapshots still detect reducer divergence. */
export function startSequenceReconciliation(deps: ReconciliationDeps) {
  let disposed = false;
  let active: AbortController | undefined;
  let lastFullSync = deps.now();
  const cancel = () => active?.abort();
  const unsubscribe = deps.subscribeConnection(() => {
    if (!deps.connected()) cancel();
  });
  let timer: number;
  const run = async () => {
    if (disposed || active || !deps.connected()) return;
    const controller = new AbortController();
    active = controller;
    let deadline: number | undefined;
    try {
      const target = await raceWithAbort(deps.probe(), controller.signal);
      if (controller.signal.aborted || disposed) return;
      if (target.backendIncarnation !== deps.incarnation()) {
        await deps.recoverIncarnation(target.backendIncarnation);
        lastFullSync = deps.now();
        return;
      }
      if (deps.now() - lastFullSync >= 600_000) {
        await deps.syncSnapshot();
        lastFullSync = deps.now();
        return;
      }
      if (deps.committedSequence() >= target.latestSequence) return;
      let expired = false;
      deadline = deps.scheduler.setTimeout(() => {
        expired = true;
        controller.abort();
      }, 5_000);
      try {
        await deps.waitForSequence(target.latestSequence, controller.signal);
      } catch (error) {
        if (!expired) throw error;
        if (!disposed && deps.connected()) {
          await deps.syncSnapshot();
          lastFullSync = deps.now();
        }
      }
    } catch {
      // Disconnect/probe failure cancels this cycle; welcome or the next probe recovers.
    } finally {
      if (deadline !== undefined) deps.scheduler.clearTimeout(deadline);
      if (active === controller) active = undefined;
    }
  };
  const schedule = () => {
    timer = deps.scheduler.setTimeout(() => {
      void run().finally(() => {
        if (!disposed) schedule();
      });
    }, 60_000);
  };
  schedule();
  return {
    run,
    dispose() {
      disposed = true;
      cancel();
      unsubscribe();
      deps.scheduler.clearTimeout(timer);
    },
  };
}
