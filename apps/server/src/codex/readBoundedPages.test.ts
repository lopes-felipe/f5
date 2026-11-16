import { expect, it, vi } from "vitest";
import { readBoundedPages } from "./readBoundedPages.ts";
const decode = (row: unknown) => (typeof row === "number" ? row : undefined);

it("stops repeated cursors and preserves partial rows", async () => {
  const request = vi.fn(async () => ({ data: [1], nextCursor: "same" }));
  const result = await readBoundedPages({ label: "test", request, decode });
  expect(result.complete).toBe(false);
  expect(result.entries).toEqual([1, 1]);
  expect(request).toHaveBeenCalledTimes(2);
});
it("stops scheduling pages after cancellation", async () => {
  const controller = new AbortController();
  const request = vi.fn(async () => {
    controller.abort();
    return { data: [1], nextCursor: "next" };
  });
  expect(
    (await readBoundedPages({ label: "test", request, decode, signal: controller.signal }))
      .complete,
  ).toBe(false);
  expect(request).toHaveBeenCalledTimes(1);
});
it.each([{ data: [1, null], nextCursor: null }, { data: "bad", nextCursor: null }, { data: [1] }])(
  "reports malformed pages as partial",
  async (page) => {
    expect(
      (await readBoundedPages({ label: "test", request: async () => page, decode })).complete,
    ).toBe(false);
  },
);
it("enforces page and item limits", async () => {
  const request = vi.fn(async (cursor) => ({
    data: [1, 2],
    nextCursor: String(Number(cursor ?? 0) + 1),
  }));
  expect(
    (await readBoundedPages({ label: "test", request, decode, maxPages: 2 })).entries,
  ).toHaveLength(4);
  expect(
    (await readBoundedPages({ label: "test", request, decode, maxItems: 3 })).entries,
  ).toHaveLength(3);
});
