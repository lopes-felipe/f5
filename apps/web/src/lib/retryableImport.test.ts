import { expect, it, vi } from "vitest";
import { retryableImport } from "./retryableImport";

it("coalesces concurrent module loads and lets a later expansion recover after rejection", async () => {
  const module = { ready: true };
  const fetchModule = vi
    .fn<() => Promise<typeof module>>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(module);
  const load = retryableImport(fetchModule);
  const failed = load();
  expect(load()).toBe(failed);
  await expect(failed).rejects.toThrow("offline");
  const retry = load();
  expect(retry).not.toBe(failed);
  expect(load()).toBe(retry);
  await expect(retry).resolves.toBe(module);
  expect(load()).toBe(retry);
  expect(fetchModule).toHaveBeenCalledTimes(2);
});
