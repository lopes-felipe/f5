import { useAgentComputerActivityStore } from "../agentComputerActivityStore";
import { useAgentBrowserActivityStore } from "../agentBrowserActivityStore";
import { ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computerStopShortcutLabel,
  pauseComputerThread,
  pausePreviewThread,
  stopComputerTurn,
} from "./computerControls";
const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), pause: vi.fn() }));
vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: { dispatchCommand: mocks.dispatch },
    preview: { automation: { setPaused: mocks.pause } },
  }),
}));
afterEach(() => {
  useAgentComputerActivityStore.getState().resetConnection();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe("computer controls", () => {
  it("uses the host shortcut, including remote Windows hosts and legacy peers", () => {
    expect(computerStopShortcutLabel({ hostPlatform: "win32" })).toBe("Ctrl+Alt+Shift+F12");
    expect(computerStopShortcutLabel({ hostPlatform: "darwin" })).toBe("⌃⌘Esc");
    expect(computerStopShortcutLabel({ hostPlatform: "win32", stopShortcut: "Custom chord" })).toBe(
      "Custom chord",
    );
    expect(computerStopShortcutLabel()).toBe("Stop in F5");
  });
  it("confirms a successful Stop when there is no lease to release", async () => {
    vi.stubGlobal("window", {
      desktopBridge: { computerAutomation: { setPaused: vi.fn(async () => {}) } },
    });
    await stopComputerTurn(ThreadId.makeUnsafe("no-lease"));
    expect(useAgentComputerActivityStore.getState().stopUnconfirmed["no-lease"]).toBeUndefined();
  });
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
    await expect(stopComputerTurn(ThreadId.makeUnsafe("t"))).rejects.toThrow("Stop unconfirmed");
    expect(mocks.dispatch).toHaveBeenCalledOnce();
  });
  it("waits for authoritative native resume without clearing the server pause locally", async () => {
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
    expect(order).toEqual(["native"]);
    expect(mocks.pause).not.toHaveBeenCalled();
  });
  it("keeps the server pause latched when native resume fails or the client is remote", async () => {
    vi.stubGlobal("window", {
      desktopBridge: {
        computerAutomation: {
          setPaused: vi.fn(async () => {
            throw new Error("monitor unhealthy");
          }),
        },
      },
    });
    await expect(pauseComputerThread(ThreadId.makeUnsafe("t"), false)).rejects.toThrow(
      "monitor unhealthy",
    );
    expect(mocks.pause).not.toHaveBeenCalled();
    vi.stubGlobal("window", {});
    await expect(pauseComputerThread(ThreadId.makeUnsafe("t"), false)).rejects.toThrow(
      "computer running F5",
    );
    expect(mocks.pause).not.toHaveBeenCalled();
  });
  it("does not optimistically resume preview when its shared native pause is refused", async () => {
    const thread = ThreadId.makeUnsafe("paused-preview");
    const setPaused = vi.spyOn(useAgentBrowserActivityStore.getState(), "setPaused");
    mocks.pause.mockRejectedValueOnce(new Error("Resume on host"));
    vi.stubGlobal("window", {
      desktopBridge: {
        computerAutomation: {
          setPaused: vi.fn(async () => {
            throw new Error("monitor unhealthy");
          }),
        },
      },
    });
    await expect(pausePreviewThread(thread, false)).rejects.toThrow("monitor unhealthy");
    expect(setPaused).not.toHaveBeenCalled();
    setPaused.mockRestore();
  });
  it("sends trusted local resume before waiting for a slow server refusal", async () => {
    const thread = ThreadId.makeUnsafe("slow-preview");
    let refuse: (error: Error) => void = () => {};
    mocks.pause.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          refuse = reject;
        }),
    );
    const native = vi.fn(async () => {});
    vi.stubGlobal("window", { desktopBridge: { computerAutomation: { setPaused: native } } });
    const setPaused = vi.spyOn(useAgentBrowserActivityStore.getState(), "setPaused");
    const resume = pausePreviewThread(thread, false);
    expect(native).toHaveBeenCalledWith(thread, false);
    expect(setPaused).not.toHaveBeenCalled();
    refuse(new Error("Resume on host"));
    await resume;
    expect(native).toHaveBeenCalledOnce();
    expect(setPaused).not.toHaveBeenCalled();
    setPaused.mockRestore();
  });
  it("allows preview-only resume when the computer helper is unavailable", async () => {
    const thread = ThreadId.makeUnsafe("preview-only");
    mocks.pause.mockResolvedValueOnce(undefined);
    vi.stubGlobal("window", {
      desktopBridge: {
        computerAutomation: {
          setPaused: vi.fn(async () => {
            throw new Error("Not certified");
          }),
        },
      },
    });
    const setPaused = vi.spyOn(useAgentBrowserActivityStore.getState(), "setPaused");
    await pausePreviewThread(thread, false);
    expect(setPaused).toHaveBeenCalledWith(thread, false);
    setPaused.mockRestore();
  });
});
