import { expect, it, vi } from "vitest";
import { createWindowWithOptionalControl } from "./optionalAppControl";
it("opens the window even when optional CLI control cannot start", async () => {
  const window = {};
  const error = new Error("Unsafe socket directory");
  const report = vi.fn();
  const ready = vi.fn();
  const start = vi.fn(async () => {
    throw error;
  });
  expect(
    createWindowWithOptionalControl({
      createWindow: () => window,
      startControl: start,
      onReady: ready,
      onError: report,
    }),
  ).toBe(window);
  await vi.waitFor(() => expect(report).toHaveBeenCalledWith(error));
  expect(ready).not.toHaveBeenCalled();
});
