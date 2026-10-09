import { describe, expect, it, vi } from "vitest";
import { ComputerToolDispatcher } from "./ComputerToolDispatcher";
describe("computer transport admission", () => {
  it("joins retries under one invocation and never repeats a completed mutation", async () => {
    const dispatcher = new ComputerToolDispatcher();
    let finish: (value: string) => void = () => {};
    const call = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const first = dispatcher.dispatch("rpc:1", { text: "private" }, call);
    const retry = dispatcher.dispatch("rpc:1", { text: "private" }, call);
    await Promise.resolve();
    expect(call).toHaveBeenCalledTimes(1);
    finish("done");
    expect(await first).toBe("done");
    expect(await retry).toBe("done");
    await expect(dispatcher.dispatch("rpc:1", { text: "private" }, call)).rejects.toMatchObject({
      error: { _tag: "ReplayRejected" },
    });
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("rejects payload reuse and invalidates pending retries on pause/revoke", async () => {
    const dispatcher = new ComputerToolDispatcher();
    const call = vi.fn(async () => "done");
    const first = dispatcher.dispatch("1", { x: 2 }, call);
    await expect(dispatcher.dispatch("1", { x: 3 }, call)).rejects.toMatchObject({
      error: { _tag: "PayloadMismatch" },
    });
    dispatcher.invalidate();
    await expect(dispatcher.dispatch("1", { x: 2 }, call)).rejects.toMatchObject({
      error: { _tag: "ReplayRejected" },
    });
    await first;
  });
});
