import { afterEach, expect, it, vi } from "vitest";
import { settleListScroll } from "./settleListScroll";

afterEach(() => vi.unstubAllGlobals());

it("corrects changing DOM measurements before accepting two stable frames", async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  const element = { scrollTop: 0, scrollHeight: 1000, clientHeight: 100 };
  const offsets: number[] = [];
  const done = settleListScroll(
    {
      getScrollableNode: () => element as HTMLElement,
      scrollToOffset: async ({ offset }) => {
        offsets.push(offset);
        element.scrollTop = offset;
        if (offsets.length === 1) element.scrollHeight = 2000;
      },
    },
    () => false,
  );
  while (frames.length) {
    frames.shift()!(0);
    await Promise.resolve();
  }
  await done;
  expect(offsets).toEqual([900, 1900]);
});

it("stops after 60 moving frames and respects cancellation and missing nodes", async () => {
  for (const mode of ["moving", "cancelled", "missing"]) {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    const element = { scrollTop: 0, scrollHeight: 1000, clientHeight: 100 };
    const scroll = vi.fn(async () => {
      element.scrollHeight++;
    });
    const done = settleListScroll(
      {
        getScrollableNode: () => (mode === "missing" ? null : (element as HTMLElement)),
        scrollToOffset: scroll,
      },
      () => mode === "cancelled",
    );
    while (frames.length) {
      frames.shift()!(0);
      await Promise.resolve();
    }
    await done;
    expect(scroll).toHaveBeenCalledTimes(mode === "moving" ? 60 : 0);
  }
});

it("stops correcting when a navigation generation takes over", async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  let generation = 1;
  const element = { scrollTop: 0, scrollHeight: 1000, clientHeight: 100 };
  const scroll = vi.fn(async () => {
    element.scrollHeight++;
  });
  const done = settleListScroll(
    {
      getScrollableNode: () => element as HTMLElement,
      scrollToOffset: scroll,
    },
    () => generation !== 1,
  );
  frames.shift()!(0);
  await Promise.resolve();
  generation++;
  element.scrollTop = 250; // The minimap/find result owns this position now.
  while (frames.length) {
    frames.shift()!(0);
    await Promise.resolve();
  }
  await done;
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(element.scrollTop).toBe(250);
});
