import { it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { captureBoundedPage, releasePreviewCaptures } from "./capture";
it("times out and permits a later capture after the guest recovers", async () => {
  const image = { getSize: () => ({ width: 10, height: 10 }), toPNG: () => Buffer.from("png") };
  let stalled = true;
  const guest = Object.assign(new EventEmitter(), {
    capturePage: () => (stalled ? new Promise(() => {}) : Promise.resolve(image)),
    isDestroyed: () => false,
  });
  await expect(captureBoundedPage(guest as never, undefined, 10)).rejects.toThrow("timed out");
  stalled = false;
  guest.emit("did-navigate");
  expect(await captureBoundedPage(guest as never)).toBe(image);
});
it("bounds screenshot dimensions", async () => {
  const bounded = {
    getSize: () => ({ width: 2560, height: 1280 }),
    toPNG: () => Buffer.from("png"),
  };
  const image = { getSize: () => ({ width: 4000, height: 2000 }), resize: vi.fn(() => bounded) };
  const guest = Object.assign(new EventEmitter(), {
    capturePage: async () => image,
    isDestroyed: () => false,
  });
  expect(await captureBoundedPage(guest as never)).toBe(bounded);
  expect(image.resize).toHaveBeenCalledWith({ width: 2560 });
});

it("serializes captures per guest and keeps a timed-out native capture in flight", async () => {
  const image = { getSize: () => ({ width: 10, height: 10 }), toPNG: () => Buffer.from("png") };
  let release!: (result: typeof image) => void;
  const capturePage = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue(image);
  const guest = Object.assign(new EventEmitter(), { capturePage, isDestroyed: () => false });
  await expect(captureBoundedPage(guest as never, undefined, 10)).rejects.toThrow("timed out");
  await expect(captureBoundedPage(guest as never)).rejects.toThrow("Reload the preview");
  expect(capturePage).toHaveBeenCalledTimes(1);
  release(image);
  await new Promise((resolve) => setImmediate(resolve));
  expect(await captureBoundedPage(guest as never)).toBe(image);
  expect(capturePage).toHaveBeenCalledTimes(2);
});

it.each(["render-process-gone", "unresponsive"])(
  "requires a reload after %s without overlapping native captures",
  async (event) => {
    const image = { getSize: () => ({ width: 10, height: 10 }), toPNG: () => Buffer.from("png") };
    const guest = Object.assign(new EventEmitter(), {
      capturePage: vi
        .fn()
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValue(image),
      isDestroyed: () => false,
    });
    const first = expect(captureBoundedPage(guest as never)).rejects.toThrow("Reload the preview");
    const queued = expect(captureBoundedPage(guest as never)).rejects.toThrow("Reload the preview");
    await Promise.resolve();
    guest.emit(event);
    await Promise.all([first, queued]);
    await expect(captureBoundedPage(guest as never)).rejects.toThrow("Reload the preview");
    expect(guest.capturePage).toHaveBeenCalledTimes(1);
    guest.emit("did-navigate");
    expect(await captureBoundedPage(guest as never)).toBe(image);
  },
);

it("drops queued captures on timeout or guest release", async () => {
  const guest = Object.assign(new EventEmitter(), {
    capturePage: vi.fn(() => new Promise(() => {})),
    isDestroyed: () => false,
  });
  const active = captureBoundedPage(guest as never);
  const rejected = expect(active).rejects.toThrow("changed");
  await expect(captureBoundedPage(guest as never, undefined, 10)).rejects.toThrow("timed out");
  guest.emit("destroyed");
  await rejected;
  expect(guest.capturePage).toHaveBeenCalledTimes(1);
});

it("never sends a queued capture after the preview connection is released", async () => {
  const image = { getSize: () => ({ width: 10, height: 10 }), toPNG: () => Buffer.from("png") };
  let finish!: (result: typeof image) => void;
  const guest = Object.assign(new EventEmitter(), {
    capturePage: vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ),
    isDestroyed: () => false,
  });
  const first = expect(captureBoundedPage(guest as never)).rejects.toThrow("connection closed");
  const second = expect(captureBoundedPage(guest as never)).rejects.toThrow("connection closed");
  await Promise.resolve();
  releasePreviewCaptures(guest as never);
  await Promise.all([first, second]);
  finish(image);
  await Promise.resolve();
  expect(guest.capturePage).toHaveBeenCalledTimes(1);
});
