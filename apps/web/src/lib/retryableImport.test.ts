import { expect, it, vi } from "vitest";
import { retryableImport } from "./retryableImport";

it("shares lazy imports and retries after a rejection", async () => {
  const chunk = { ready: true };
  const importChunk = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(chunk);
  const load = retryableImport(importChunk);
  const first = load();
  expect(load()).toBe(first);
  await expect(first).rejects.toThrow("offline");
  const second = load();
  expect(second).not.toBe(first);
  await expect(second).resolves.toBe(chunk);
  expect(load()).toBe(second);
  expect(importChunk).toHaveBeenCalledTimes(2);
});
