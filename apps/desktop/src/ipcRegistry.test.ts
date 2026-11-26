import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { appMainFrameProfile } from "./appRendererCaller";
import { createAppIpcRegistrar, type DesktopIpcMainLike } from "./ipcRegistry";

function makeFakeIpcMain() {
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, ...args: ReadonlyArray<unknown>) => unknown
  >();
  const removed: string[] = [];
  const ipcMain: DesktopIpcMainLike = {
    removeHandler(channel) {
      removed.push(channel);
      handlers.delete(channel);
    },
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
  };
  return { ipcMain, handlers, removed };
}

function makeInvokeEvent(input: {
  readonly senderId: number;
  readonly origin: string;
  readonly isMainFrame?: boolean;
}): IpcMainInvokeEvent {
  const mainFrame = { origin: input.origin };
  const senderFrame = input.isMainFrame === false ? { origin: input.origin } : mainFrame;
  return {
    sender: { id: input.senderId, mainFrame },
    senderFrame,
  } as unknown as IpcMainInvokeEvent;
}

describe("createAppIpcRegistrar", () => {
  it("replaces any prior handler and passes authorized profile context to the handler", () => {
    const { ipcMain, handlers, removed } = makeFakeIpcMain();
    const handleAppIpc = createAppIpcRegistrar({
      ipcMain,
      authorize: (event, purpose) =>
        appMainFrameProfile(event, {
          registered: (id) => id === 7,
          profile: (id) => (id === 7 ? "default-profile" : undefined),
          expectedOrigin: "t3://app",
          purpose,
        }),
    });

    const spy = vi.fn(({ profileId }: { readonly profileId: string }, url: unknown) => ({
      profileId,
      url,
    }));
    handleAppIpc("desktop:open-external", "Open external URL", spy);

    expect(removed).toEqual(["desktop:open-external"]);
    const listener = handlers.get("desktop:open-external")!;
    const result = listener(
      makeInvokeEvent({ senderId: 7, origin: "t3://app" }),
      "https://example.com",
    );
    expect(result).toEqual({ profileId: "default-profile", url: "https://example.com" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("blocks unregistered renderers, subframes, and foreign origins before running the handler", () => {
    const { ipcMain, handlers } = makeFakeIpcMain();
    const handleAppIpc = createAppIpcRegistrar({
      ipcMain,
      authorize: (event, purpose) =>
        appMainFrameProfile(event, {
          registered: (id) => id === 7,
          profile: (id) => (id === 7 ? "default-profile" : undefined),
          expectedOrigin: "t3://app",
          purpose,
        }),
    });

    const spy = vi.fn();
    handleAppIpc("desktop:download-image", "Image download", spy);
    const listener = handlers.get("desktop:download-image")!;

    expect(() => listener(makeInvokeEvent({ senderId: 99, origin: "t3://app" }))).toThrow(
      /Image download require an F5 app main frame/,
    );
    expect(() =>
      listener(makeInvokeEvent({ senderId: 7, origin: "t3://app", isMainFrame: false })),
    ).toThrow(/Image download require an F5 app main frame/);
    expect(() =>
      listener(makeInvokeEvent({ senderId: 7, origin: "https://attacker.example" })),
    ).toThrow(/Image download require an F5 app main frame/);
    expect(spy).not.toHaveBeenCalled();
  });
});
