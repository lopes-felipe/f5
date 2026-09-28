import { expect, it } from "vitest";
import { createTimelineScrollAnchors } from "./timelineScrollAnchors";
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
