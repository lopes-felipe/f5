import { expect, it, vi } from "vitest";
import { threadFindRanges, watchThreadFindHighlights } from "./threadFindHighlights";

function mountTimeline(html: string) {
  const container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = "height: 200px; width: 300px; overflow: auto";
  container.innerHTML = html;
  return { container, [Symbol.dispose]: () => container.remove() };
}

const painted = () => [...(CSS.highlights.get("f5-thread-find") ?? [])] as Range[];
const active = () =>
  [...(CSS.highlights.get("f5-thread-find-active") ?? [])][0] as Range | undefined;
const paintedIn = (element: Element) =>
  painted().filter((range) => element.contains(range.startContainer));

it("matches across inline spans without joining separate blocks or hidden controls", () => {
  const root = document.createElement("div");
  root.innerHTML =
    '<h2 class="sr-only">Needle</h2><p>Hello <strong>bold</strong> world</p><p>Other</p><button>Needle</button><pre><span>const </span><span>value</span> = 1</pre>';
  expect(threadFindRanges(root, "bold world").ranges.map((range) => range.toString())).toEqual([
    "bold world",
  ]);
  expect(threadFindRanges(root, "worldOther").ranges).toHaveLength(0);
  expect(threadFindRanges(root, "Needle").ranges).toHaveLength(0);
  expect(threadFindRanges(root, "const value").selected?.toString()).toBe("const value");
});
it("preserves occurrence order and offsets during Unicode case folding", () => {
  const root = document.createElement("div");
  root.textContent = "İ ΟΣ " + "needle ".repeat(3000);
  const result = threadFindRanges(root, "needle", 2999);
  expect(result.ranges).toHaveLength(3000);
  expect(result.selected?.toString()).toBe("needle");
  expect(result.selected?.startOffset).toBe(5 + 2999 * 7);
  expect(threadFindRanges(root, "σ").selected?.toString()).toBe("Σ");
});
it("paints a stand-in but reports only the requested occurrence when it renders", async () => {
  using timeline = mountTimeline(
    '<div data-timeline-row-id="row" data-thread-find-text><p>needle one</p></div>',
  );
  const onSelectedRange = vi.fn();
  const highlight = watchThreadFindHighlights(timeline.container, "needle", () => ({
    entryId: "row",
    occurrence: 1,
    requestId: 1,
    onSelectedRange,
  }));
  try {
    await vi.waitFor(() => expect(active()?.startContainer.textContent).toBe("needle one"));
    expect(onSelectedRange).not.toHaveBeenCalled();
    const second = document.createElement("p");
    second.textContent = "needle two";
    timeline.container.firstElementChild!.append(second);
    await vi.waitFor(() => expect(active()?.startContainer.textContent).toBe("needle two"));
    expect(onSelectedRange).toHaveBeenCalledExactlyOnceWith(1, active());
  } finally {
    highlight.clear();
  }
});

it("paints a bounded window of a large message and keeps a distant active match", async () => {
  const count = 200_000;
  using timeline = mountTimeline('<div data-timeline-row-id="row" data-thread-find-text></div>');
  const { container } = timeline;
  container.firstElementChild!.textContent = "e x ".repeat(count);
  const onSelectedRange = vi.fn();
  const highlight = watchThreadFindHighlights(container, "e", () => ({
    entryId: "row",
    occurrence: count - 1,
    requestId: 1,
    onSelectedRange,
  }));
  try {
    await vi.waitFor(() => expect(active()?.startOffset).toBe((count - 1) * 4));
    const lastPainted = () => Math.max(...painted().map((range) => range.startOffset));
    expect(painted().length).toBeGreaterThan(0);
    expect(painted().length).toBeLessThan(5_000);
    expect(lastPainted()).toBeLessThan(count);
    expect(container.scrollTop).toBe(0);

    container.scrollTop = container.scrollHeight;
    await vi.waitFor(() => expect(lastPainted()).toBe((count - 2) * 4));
    expect(painted().length).toBeLessThan(5_000);
    expect(painted().some((range) => range.startOffset === 0)).toBe(false);
    expect(active()?.startOffset).toBe((count - 1) * 4);
    expect(onSelectedRange).toHaveBeenCalledExactlyOnceWith(1, active());
  } finally {
    highlight.clear();
  }
});

it("paints both table cells when their text runs overlap vertically", async () => {
  const text = "e x ".repeat(5_000);
  using timeline = mountTimeline(
    '<div data-timeline-row-id="row" data-thread-find-text><table style="width: 100%"><tr>' +
      '<td style="vertical-align: top">' +
      text +
      "</td>" +
      '<td style="vertical-align: top">' +
      text +
      "</td>" +
      "</tr></table></div>",
  );
  const { container } = timeline;
  const cells = [...container.querySelectorAll("td")];
  const highlight = watchThreadFindHighlights(container, "e", () => null);
  try {
    const lastPaintedIn = (cell: Element) =>
      Math.max(...paintedIn(cell).map((range) => range.startOffset));
    await vi.waitFor(() => {
      for (const cell of cells) expect(paintedIn(cell).length).toBeGreaterThan(0);
    });
    const offsets = cells.map(lastPaintedIn);
    container.scrollTop = 1_000;
    await vi.waitFor(() => {
      for (const [index, cell] of cells.entries())
        expect(lastPaintedIn(cell)).toBeGreaterThan(offsets[index]!);
    });
    expect(painted().length).toBeLessThan(5_000);
  } finally {
    highlight.clear();
  }
});

it("refreshes mounted rows when text streams, hidden content opens, and the viewport moves", async () => {
  using timeline = mountTimeline(
    '<div data-timeline-row-id="near" data-thread-find-text><p>e</p>' +
      "<div hidden>" +
      "e x ".repeat(10_000) +
      "</div></div>" +
      '<div style="height: 5000px"></div>' +
      '<div data-timeline-row-id="far" data-thread-find-text>e e</div>',
  );
  const { container } = timeline;
  const [near, far] = [...container.querySelectorAll<HTMLElement>("[data-thread-find-text]")];
  const hidden = near!.querySelector<HTMLElement>("[hidden]")!;
  using measure = vi.spyOn(Range.prototype, "getBoundingClientRect");
  const highlight = watchThreadFindHighlights(container, "e", () => ({
    entryId: "far",
    occurrence: 1,
  }));
  try {
    await vi.waitFor(() => expect(painted().length).toBe(1));
    expect(measure.mock.calls.length).toBeLessThan(100);
    expect(far!.contains(active()?.startContainer ?? null)).toBe(true);
    near!.querySelector("p")!.append(" e");
    await vi.waitFor(() => expect(paintedIn(near!).length).toBe(2));
    hidden.hidden = false;
    await vi.waitFor(() => expect(paintedIn(hidden).length).toBeGreaterThan(0));
    container.scrollTop = container.scrollHeight;
    await vi.waitFor(() =>
      expect([paintedIn(near!).length, paintedIn(far!).length]).toEqual([0, 1]),
    );
    far!.remove();
    await vi.waitFor(() => expect([painted().length, active()]).toEqual([0, undefined]));
  } finally {
    highlight.clear();
  }
});

it("keeps a newer highlight owner when an older timeline releases its highlights", async () => {
  using timeline = mountTimeline(
    '<div data-timeline-row-id="row" data-thread-find-text>one two</div>',
  );
  const select = () => ({ entryId: "row", occurrence: 0 });
  const old = watchThreadFindHighlights(timeline.container, "one", select);
  const current = watchThreadFindHighlights(timeline.container, "two", select);
  try {
    await vi.waitFor(() => expect(active()?.toString()).toBe("two"));
    old.clear();
    expect(active()?.toString()).toBe("two");
  } finally {
    old.clear();
    current.clear();
  }
  expect(CSS.highlights.has("f5-thread-find-active")).toBe(false);
});
