import { expect, it } from "vitest";
import { createTimelineScrollAnchors, readTimelineScrollAnchor } from "./timelineScrollAnchors";
it("keeps the 50 most recently used thread anchors", () => {
  const cache = createTimelineScrollAnchors();
  const anchor = { rowId: "message", top: -20, scroll: 400, atEnd: false };
  for (let i = 0; i < 50; i++) cache.set(String(i), { ...anchor, scroll: i });
  expect(cache.get("0")?.scroll).toBe(0);
  cache.set("50", anchor);
  expect(cache.get("1")).toBeUndefined();
  expect(cache.get("0")?.scroll).toBe(0);
  expect(cache.get("50")).toEqual(anchor);
});

it("selects the first visible row by geometry rather than recycled DOM order", () => {
  const row = (id: string, top: number, bottom: number) => ({
    dataset: { timelineRowId: id },
    getBoundingClientRect: () => ({ top, bottom, height: bottom - top }),
  });
  const node = {
    scrollTop: 200,
    scrollHeight: 2000,
    clientHeight: 400,
    getBoundingClientRect: () => ({ top: 100, bottom: 500 }),
    querySelectorAll: () => [
      row("below", 900, 1000),
      row("second", 200, 260),
      row("above", 20, 80),
      row("hidden", 110, 110),
      row("first", 90, 150),
    ],
  } as unknown as HTMLElement;
  expect(readTimelineScrollAnchor(node)).toEqual({
    rowId: "first",
    top: -10,
    scroll: 200,
    atEnd: false,
  });
});
