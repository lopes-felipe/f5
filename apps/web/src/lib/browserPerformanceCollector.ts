import type { BrowserPerformanceCounters } from "./performanceCounters";

/** Serialized into Playwright before startup; never imported by the application. */
export function installBrowserPerformanceCounters() {
  const readers = new Map<string, () => Record<string, number>>();
  const rowOrder: string[] = [];
  const counters: BrowserPerformanceCounters = {
    work: {},
    gauges: {},
    rowRenders: Object.create(null),
    historyLoadStarted(anchor) {
      counters.lastHistoryAnchor = { rowId: anchor.rowId, top: anchor.top };
    },
    registerReader(name, read) {
      readers.set(name, read);
      return () => {
        if (readers.get(name) === read) readers.delete(name);
      };
    },
    recordWork(name, amount = 1) {
      counters.work[name] = (counters.work[name] ?? 0) + amount;
    },
    recordGauge(name, value) {
      counters.gauges[name] = value;
    },
    recordRow(id) {
      counters.work.rowRenders = (counters.work.rowRenders ?? 0) + 1;
      if (!Object.hasOwn(counters.rowRenders, id)) {
        if (rowOrder.length === 2048) delete counters.rowRenders[rowOrder.shift()!];
        rowOrder.push(id);
      }
      counters.rowRenders[id] = (counters.rowRenders[id] ?? 0) + 1;
    },
    sample: () => ({
      work: { ...counters.work },
      gauges: { ...counters.gauges },
      rowRenders: { ...counters.rowRenders },
      resources: Object.fromEntries([...readers].map(([name, read]) => [name, read()])),
    }),
  };
  window.__f5PerformanceCounters = counters;
}
