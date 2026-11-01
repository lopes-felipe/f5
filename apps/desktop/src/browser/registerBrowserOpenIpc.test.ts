import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { appMainFrameProfile } from "../appRendererCaller";
import {
  BROWSER_OPEN_ANSWER_CHANNEL,
  BROWSER_OPEN_CURRENT_CHANNEL,
  BROWSER_OPEN_SHOWN_CHANNEL,
} from "./BrowserOpenPrompt";
import { registerBrowserOpenIpc } from "./registerBrowserOpenIpc";

describe("browser open IPC", () => {
  it("scopes every channel to the authorized sender's profile", () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const ipc = {
      handle: (name: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) =>
        handlers.set(name, fn),
      removeHandler: (name: string) => handlers.delete(name),
    };
    const prompt = {
      prompt: vi.fn(),
      current: vi.fn(() => null),
      waitingChanged: vi.fn(),
      acknowledge: vi.fn(),
      answer: vi.fn(),
    };
    const authorize = vi.fn(() => "work");
    registerBrowserOpenIpc(ipc as unknown as IpcMain, { authorize, prompt });
    expect([...handlers.keys()].sort()).toEqual(
      [
        BROWSER_OPEN_ANSWER_CHANNEL,
        BROWSER_OPEN_CURRENT_CHANNEL,
        BROWSER_OPEN_SHOWN_CHANNEL,
      ].sort(),
    );
    const event = {} as IpcMainInvokeEvent;
    handlers.get(BROWSER_OPEN_CURRENT_CHANNEL)!(event);
    expect(prompt.current).toHaveBeenCalledWith("work");
    handlers.get(BROWSER_OPEN_SHOWN_CHANNEL)!(event, "request-1");
    expect(prompt.acknowledge).toHaveBeenCalledWith("work", "request-1");
    handlers.get(BROWSER_OPEN_ANSWER_CHANNEL)!(event, "request-1", "open", true);
    expect(prompt.answer).toHaveBeenCalledWith("work", "request-1", "open", true);
    authorize.mockImplementation(() => {
      throw new Error("Wrong frame");
    });
    for (const handler of handlers.values()) expect(() => handler(event)).toThrow("Wrong frame");
    expect(prompt.answer).toHaveBeenCalledOnce();
  });
});

describe("app main frame authorization", () => {
  const mainFrame = { origin: "t3://app" };
  const input = {
    registered: (id: number) => id === 1,
    profile: (id: number) => (id === 1 ? "work" : undefined),
    expectedOrigin: "t3://app",
    purpose: "Browser open answers",
  };
  const event = (overrides: { id?: number; frame?: { origin: string } | null } = {}) =>
    ({
      sender: { id: overrides.id ?? 1, mainFrame },
      senderFrame: overrides.frame === undefined ? mainFrame : overrides.frame,
    }) as unknown as IpcMainInvokeEvent;

  it("returns the profile of F5's own main frame", () => {
    expect(appMainFrameProfile(event(), input)).toBe("work");
  });
  it.each([
    ["an unregistered renderer", event({ id: 2 })],
    ["a subframe", event({ frame: { origin: "t3://app" } })],
    ["a destroyed frame", event({ frame: null })],
  ])("rejects %s", (_name, caller) => {
    expect(() => appMainFrameProfile(caller, input)).toThrow(
      "Browser open answers require an F5 app main frame.",
    );
  });
  it("rejects the main frame after it navigates to another origin", () => {
    const navigated = { origin: "https://evil.example" };
    const caller = {
      sender: { id: 1, mainFrame: navigated },
      senderFrame: navigated,
    } as unknown as IpcMainInvokeEvent;
    expect(() => appMainFrameProfile(caller, input)).toThrow("F5 app main frame");
  });
  it("rejects a registered renderer without a profile", () => {
    expect(() => appMainFrameProfile(event(), { ...input, profile: () => undefined })).toThrow(
      "does not own a profile",
    );
  });
});
