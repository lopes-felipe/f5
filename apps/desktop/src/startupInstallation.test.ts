import { expect, it, vi } from "vitest";
import { createBootstrapGate, offerApplicationsMove } from "./startupInstallation";
it("continues startup when Move to Applications throws", async () => {
  const report = vi.fn();
  expect(
    await offerApplicationsMove({
      prompt: async () => true,
      move: () => {
        throw new Error("disk full");
      },
      report,
    }),
  ).toBe(false);
  expect(report).toHaveBeenCalledTimes(1);
});
it("does not reopen profiles before bootstrap has started and completed", async () => {
  const gate = createBootstrapGate();
  let finish!: () => void;
  const opened = vi.fn();
  const reopen = gate.wait().then(opened);
  await Promise.resolve();
  expect(opened).not.toHaveBeenCalled();
  gate.start(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await Promise.resolve();
  expect(opened).not.toHaveBeenCalled();
  finish();
  await reopen;
  expect(opened).toHaveBeenCalledTimes(1);
});
