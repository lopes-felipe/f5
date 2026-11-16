type Work =
  | "rowRenders"
  | "timelineDerivations"
  | "timelineContentUpdates"
  | "markdownParsedCharacters"
  | "markdownValidatedCharacters"
  | "highlightJobs"
  | "highlightBytes";
type Gauge = "highlightJobs" | "highlightBytes";
interface BrowserPerformanceSnapshot {
  work: Partial<Record<Work, number>>;
  gauges: Partial<Record<Gauge, number>>;
  rowRenders: Record<string, number>;
  resources?: Record<string, Record<string, number>>;
}
export interface BrowserPerformanceCounters extends BrowserPerformanceSnapshot {
  sample?: () => BrowserPerformanceSnapshot;
  lastHistoryAnchor?: { rowId: string | null; top: number };
  historyLoadStarted?: (anchor: { rowId: string | null; top: number }) => void;
  recordRow?: (id: string) => void;
  registerReader?: (name: "store" | "transport", read: () => Record<string, number>) => () => void;
  recordWork?: (name: Work, amount?: number) => void;
  recordGauge?: (name: Gauge, value: number) => void;
}
declare global {
  interface Window {
    /** Installed by the existing production-browser runner before app startup. */
    __f5PerformanceCounters?: BrowserPerformanceCounters;
  }
}
const counters = typeof window === "undefined" ? undefined : window.__f5PerformanceCounters;
const noop = () => {};
export const registerBrowserResourceReader = counters?.registerReader ?? (() => noop);
export const recordBrowserWork = counters?.recordWork ?? noop;
export const recordBrowserGauge = counters?.recordGauge ?? noop;
export const recordTimelineRowRender = counters?.recordRow ?? noop;
