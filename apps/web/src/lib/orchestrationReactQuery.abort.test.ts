import { expect, it, vi } from "vitest";
import { raceWithAbort } from "./orchestrationReactQuery";

it.each(["success", "failure", "abort"] as const)(
  "removes the consumer abort listener after %s",
  async (outcome) => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    let resolve!: (value: number) => void;
    let reject!: (error: Error) => void;
    const request = new Promise<number>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const first = raceWithAbort(request, controller.signal);
    const otherConsumer = raceWithAbort(request, new AbortController().signal);
    if (outcome === "abort") {
      const failed = expect(first).rejects.toMatchObject({ name: "AbortError" });
      controller.abort();
      await failed;
      resolve(42);
      expect(await otherConsumer).toBe(42);
    } else if (outcome === "failure") {
      const firstFailure = expect(first).rejects.toThrow("RPC failed");
      const otherFailure = expect(otherConsumer).rejects.toThrow("RPC failed");
      reject(new Error("RPC failed"));
      await Promise.all([firstFailure, otherFailure]);
    } else {
      resolve(42);
      expect(await first).toBe(42);
      expect(await otherConsumer).toBe(42);
    }
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]![1]);
  },
);

it("observes an abandoned RPC when the consumer is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const add = vi.spyOn(controller.signal, "addEventListener");
  const request = Promise.reject(new Error("abandoned RPC failed"));
  await expect(raceWithAbort(request, controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(add).not.toHaveBeenCalled();
  // Vitest also rejects the run if the abandoned RPC leaks an unhandled rejection.
});
