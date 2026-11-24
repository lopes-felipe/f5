import { expect, it, vi } from "vitest";
const highlighter = vi.hoisted(() => vi.fn());
vi.mock("@pierre/diffs", () => ({ getSharedHighlighter: highlighter }));
import { getSyntaxHighlighterPromise } from "./commandHighlighting";

it("retries a rejected grammar load and retains a successful promise", async () => {
  highlighter.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({});
  const failed = getSyntaxHighlighterPromise("python");
  await expect(failed).rejects.toThrow("offline");
  const retried = getSyntaxHighlighterPromise("python");
  expect(retried).not.toBe(failed);
  await retried;
  expect(getSyntaxHighlighterPromise("python")).toBe(retried);
  expect(highlighter).toHaveBeenCalledTimes(2);
});
