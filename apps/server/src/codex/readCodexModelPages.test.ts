import { describe, expect, it, vi } from "vitest";
import { readCodexModelPages } from "./readCodexModelPages";

describe("readCodexModelPages", () => {
  it("includes hidden rows and reads every page", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ model: "one", hidden: true }], nextCursor: "two" })
      .mockResolvedValueOnce({ data: [{ model: "two" }], nextCursor: null });
    const result = await readCodexModelPages(request);
    expect(result.complete).toBe(true);
    expect(result.entries).toHaveLength(2);
    expect(request.mock.calls).toEqual([
      [{ includeHidden: true }],
      [{ includeHidden: true, cursor: "two" }],
    ]);
  });
  it.each([
    [{ data: [], nextCursor: "same" }, 10],
    [{ data: [], nextCursor: "next" }, 1],
    [{ data: "bad", nextCursor: null }, 10],
    [{ data: [null], nextCursor: null }, 10],
  ])("marks anomalous paging partial", async (response, maxPages) => {
    const result = await readCodexModelPages(async () => response, { maxPages });
    expect(result.complete).toBe(false);
    expect(result.anomaly).toBeTruthy();
  });
  it("retries older CLIs without includeHidden without claiming completeness", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("unsupported"), { code: -32602 }))
      .mockResolvedValueOnce({ data: [{ model: "old" }], nextCursor: null });
    expect((await readCodexModelPages(request)).complete).toBe(false);
    expect(request.mock.calls[1]).toEqual([{}]);
  });
});

it.each([{}, { model: 123 }, { model: " " }])(
  "keeps mixed malformed catalogs partial: %j",
  async (bad) => {
    const result = await readCodexModelPages(async () => ({
      data: [{ model: "valid" }, bad],
      nextCursor: null,
    }));
    expect(result.complete).toBe(false);
    expect(result.entries).toEqual([{ model: "valid" }]);
  },
);
it("keeps earlier pages when a later request fails", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      data: [{ model: "fresh", supportedReasoningEfforts: [] }],
      nextCursor: "next",
    })
    .mockRejectedValueOnce(new Error("offline"));
  const result = await readCodexModelPages(request);
  expect(result.complete).toBe(false);
  expect(result.entries).toHaveLength(1);
  expect(result.anomaly).toContain("request failed");
});
it("does not retry timeouts as compatibility errors", async () => {
  const request = vi.fn().mockRejectedValue(new Error("timeout"));
  await expect(readCodexModelPages(request)).rejects.toThrow("timeout");
  expect(request).toHaveBeenCalledTimes(1);
});

it.each([undefined, ""])(
  "does not infer completeness from an absent or empty cursor: %j",
  async (nextCursor) => {
    const result = await readCodexModelPages(async () => ({
      data: [{ model: "visible" }],
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    }));
    expect(result.complete).toBe(false);
    expect(result.entries).toHaveLength(1);
    expect(result.anomaly).toContain("cursor");
  },
);
