import type { WorkflowBenchmarkInput, WorkflowBenchmarkPhase } from "@t3tools/contracts";
import type { QueryClient } from "@tanstack/react-query";

type FindingSelect = Extract<WorkflowBenchmarkInput["select"], { kind: "findings" }>;

export type BenchmarkReviewTurn = NonNullable<FindingSelect["reviewTurn"]> & {
  readonly reviewer: string;
  readonly label: string;
  readonly attempt: number;
};

export interface BenchmarkFindingsView {
  readonly phase: WorkflowBenchmarkPhase;
  readonly turn?: BenchmarkReviewTurn | undefined;
  readonly filter: Omit<FindingSelect, "kind" | "phase" | "reviewTurn">;
  readonly openFinding: string | null;
}

export interface BenchmarkView {
  readonly open: boolean;
  readonly expanded: readonly WorkflowBenchmarkPhase[];
  readonly turnOffsets: Partial<Record<WorkflowBenchmarkPhase, number>>;
  readonly openSubagents: readonly string[];
  readonly findings: BenchmarkFindingsView | null;
}

type ScrollPosition = { readonly left: number; readonly top: number };

interface Bookmark {
  readonly view: BenchmarkView;
  readonly viewport: ScrollPosition;
  readonly benchmarkTop: number | undefined;
  readonly horizontal: ReadonlyMap<string, number>;
}

export const initialBenchmarkView: BenchmarkView = {
  open: false,
  expanded: [],
  turnOffsets: {},
  openSubagents: [],
  findings: null,
};

const bookmarksByClient = new WeakMap<QueryClient, Map<string, Bookmark>>();
const scrollers = (viewport: HTMLElement) =>
  viewport.querySelectorAll<HTMLElement>("[data-benchmark-scroll]");

function benchmarkTop(viewport: HTMLElement) {
  const benchmark = viewport.querySelector('[data-slot="workflow-benchmark"]');
  return benchmark
    ? benchmark.getBoundingClientRect().top - viewport.getBoundingClientRect().top
    : undefined;
}

export function readBenchmarkBookmark(client: QueryClient, runKey: string) {
  return bookmarksByClient.get(client)?.get(runKey);
}

export function saveBenchmarkBookmark(
  client: QueryClient,
  runKey: string,
  view: BenchmarkView,
  viewport: HTMLElement,
) {
  const bookmarks = bookmarksByClient.get(client) ?? new Map<string, Bookmark>();
  bookmarksByClient.set(client, bookmarks);
  bookmarks.delete(runKey);
  bookmarks.set(runKey, {
    view,
    viewport: { left: viewport.scrollLeft, top: viewport.scrollTop },
    benchmarkTop: benchmarkTop(viewport),
    horizontal: new Map(
      Array.from(scrollers(viewport), (element) => [
        element.dataset.benchmarkScroll!,
        element.scrollLeft,
      ]),
    ),
  });
  const oldest = bookmarks.keys().next().value;
  if (bookmarks.size > 24 && oldest !== undefined) bookmarks.delete(oldest);
}

export function restoreBenchmarkScroll(viewport: HTMLElement, bookmark: Bookmark) {
  const content = viewport.firstElementChild;
  if (!content) return;

  const overflowAnchor = viewport.style.getPropertyValue("overflow-anchor");
  viewport.style.setProperty("overflow-anchor", "none");
  let settled: ReturnType<typeof setTimeout> | undefined;
  const observer = new ResizeObserver(restore);
  const timeout = setTimeout(stop, 3000);

  // The content above the benchmark can change height while the page remounts.
  function restore() {
    clearTimeout(settled);
    let remaining = [...bookmark.horizontal.values()].filter((left) => left !== 0).length;
    for (const element of scrollers(viewport)) {
      const left = bookmark.horizontal.get(element.dataset.benchmarkScroll!);
      if (left !== undefined) {
        element.scrollLeft = left;
        if (left !== 0 && Math.abs(element.scrollLeft - left) < 1) remaining--;
      }
    }
    const currentTop = benchmarkTop(viewport);
    const top =
      currentTop !== undefined && bookmark.benchmarkTop !== undefined
        ? viewport.scrollTop + currentTop - bookmark.benchmarkTop
        : bookmark.viewport.top;
    viewport.scrollTo({ ...bookmark.viewport, top, behavior: "instant" });
    if (
      remaining === 0 &&
      Math.abs(viewport.scrollLeft - bookmark.viewport.left) < 1 &&
      Math.abs(viewport.scrollTop - top) < 1
    ) {
      settled = setTimeout(stop, 200);
    }
  }

  function stop() {
    observer.disconnect();
    clearTimeout(timeout);
    clearTimeout(settled);
    viewport.style.setProperty("overflow-anchor", overflowAnchor);
    viewport.removeEventListener("pointerdown", stop, true);
    viewport.removeEventListener("wheel", stop, true);
    viewport.removeEventListener("keydown", stop, true);
  }
  observer.observe(content);
  viewport.addEventListener("pointerdown", stop, true);
  viewport.addEventListener("wheel", stop, { capture: true, passive: true });
  viewport.addEventListener("keydown", stop, true);
  restore();
  return stop;
}
