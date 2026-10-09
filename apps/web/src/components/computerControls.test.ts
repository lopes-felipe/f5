import { ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pauseComputerThread, stopComputerTurn } from "./computerControls";
const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), pause: vi.fn() }));
vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: { dispatchCommand: mocks.dispatch },
    preview: { automation: { setPaused: mocks.pause } },
  }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe("computer controls", () => {
  it("suspends native input before interrupting the provider turn", async () => {
    let suspend: () => void = () => {};
    const native = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          suspend = resolve;
        }),
    );
    vi.stubGlobal("window", { desktopBridge: { computerAutomation: { setPaused: native } } });
    const pending = stopComputerTurn(ThreadId.makeUnsafe("t"));
    expect(native).toHaveBeenCalledWith("t", true);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    suspend();
    await pending;
    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.turn.interrupt", threadId: "t" }),
    );
  });
  it("interrupts the turn even when the desktop stop IPC fails", async () => {
    vi.stubGlobal("window", {
      desktopBridge: {
        computerAutomation: {
          setPaused: vi.fn(async () => {
            throw new Error("Host lost");
          }),
        },
      },
    });
    await expect(stopComputerTurn(ThreadId.makeUnsafe("t"))).rejects.toThrow("Host lost");
    expect(mocks.dispatch).toHaveBeenCalledOnce();
  });
  it("mirrors pause into the shared provider control path after native acknowledgement", async () => {
    const order: string[] = [];
    vi.stubGlobal("window", {
      desktopBridge: {
        computerAutomation: {
          setPaused: vi.fn(async () => {
            order.push("native");
          }),
        },
      },
    });
    mocks.pause.mockImplementation(async () => {
      order.push("server");
    });
    await pauseComputerThread(ThreadId.makeUnsafe("t"), false);
    expect(order).toEqual(["native", "server"]);
  });
});
