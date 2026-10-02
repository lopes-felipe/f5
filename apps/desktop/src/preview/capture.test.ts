import { it, expect, vi } from "vitest";
import { captureBoundedPage } from "./capture";
it("times out and permits a later capture after the guest recovers", async () => {
  const image = { getSize: () => ({ width: 10, height: 10 }), toPNG: () => Buffer.from("png") };
  let stalled = true;
  const guest = {
    capturePage: () => (stalled ? new Promise(() => {}) : Promise.resolve(image)),
    isDestroyed: () => false,
  };
  await expect(captureBoundedPage(guest as never, undefined, 10)).rejects.toThrow("timed out");
  stalled = false;
  expect(await captureBoundedPage(guest as never)).toBe(image);
});
it("bounds screenshot dimensions", async () => {
  const bounded = {
    getSize: () => ({ width: 2560, height: 1280 }),
    toPNG: () => Buffer.from("png"),
  };
  const image = { getSize: () => ({ width: 4000, height: 2000 }), resize: vi.fn(() => bounded) };
  const guest = { capturePage: async () => image, isDestroyed: () => false };
  expect(await captureBoundedPage(guest as never)).toBe(bounded);
  expect(image.resize).toHaveBeenCalledWith({ width: 2560 });
});
