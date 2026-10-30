import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_OPEN_REQUESTED_CHANNEL,
  BROWSER_OPEN_SETTLED_CHANNEL,
  createInAppBrowserOpenPrompt,
  createNativeBrowserOpenPrompt,
} from "./BrowserOpenPrompt";

afterEach(() => vi.useRealTimers());

function owner(focused = true) {
  const contents = Object.assign(new EventEmitter(), {
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
  });
  return {
    isDestroyed: () => false,
    isFocused: () => focused,
    show: vi.fn(),
    focus: vi.fn(),
    webContents: contents,
  };
}

function prompt(controller = new AbortController()) {
  return {
    requestId: "request-1",
    profileId: "work",
    host: "example.com",
    url: "https://example.com/login",
    expiresAtMs: 123_000,
    waiting: 1,
    signal: controller.signal,
  };
}

describe("native prompt", () => {
  function setup() {
    const window = owner();
    const effects = {
      window: vi.fn((_profile: string) => window as unknown as BrowserWindow | undefined),
      openProfile: vi.fn(async (_profile: string) => {}),
      profileName: (_profile: string) => "Work",
      show: vi.fn(async (_owner: BrowserWindow, _options: Electron.MessageBoxOptions) => ({
        response: 2,
      })),
    };
    const controller = new AbortController();
    return {
      owner: window,
      effects,
      controller,
      request: prompt(controller),
      prompt: createNativeBrowserOpenPrompt(effects),
    };
  }

  it("focuses only the owning profile and passes the native dialog controls", async () => {
    const h = setup();
    h.request.url += "a".repeat(400);
    expect(await h.prompt(h.request)).toBe(2);
    expect(h.effects.window).toHaveBeenCalledWith("work");
    expect(h.owner.show).toHaveBeenCalledOnce();
    expect(h.owner.focus).toHaveBeenCalledOnce();
    expect(h.effects.openProfile).not.toHaveBeenCalled();
    const [shownOwner, options] = h.effects.show.mock.calls[0]!;
    expect(shownOwner).toBe(h.owner);
    expect(options).toMatchObject({
      message: "example.com",
      signal: h.controller.signal,
      cancelId: 3,
      buttons: ["Open", "Allow example.com until F5 quits", "Copy link", "Cancel"],
    });
    expect(options.detail).toContain('profile "Work"');
    expect(options.detail).toContain(h.request.url.slice(0, 299) + "…");
    expect(options.detail).not.toContain(h.request.url);
  });

  it("reopens the requesting profile instead of borrowing another profile's window", async () => {
    const h = setup();
    h.effects.window.mockReturnValueOnce(undefined);
    expect(await h.prompt(h.request)).toBe(2);
    expect(h.effects.openProfile).toHaveBeenCalledWith("work");
    expect(h.effects.show.mock.calls[0]![0]).toBe(h.owner);
  });

  it("denies when reopening fails to provide an owner", async () => {
    const h = setup();
    h.effects.window.mockReturnValue(undefined);
    expect(await h.prompt(h.request)).toBe(3);
    expect(h.effects.show).not.toHaveBeenCalled();
  });

  it("does not show a late dialog when a request expires while its window reopens", async () => {
    const h = setup();
    h.effects.window.mockReturnValueOnce(undefined);
    h.effects.openProfile.mockImplementation(async () => {
      h.controller.abort();
    });
    expect(await h.prompt(h.request)).toBe(3);
    expect(h.effects.show).not.toHaveBeenCalled();
  });
});

describe("in-app prompt", () => {
  function setup(focused = true) {
    const window = owner(focused);
    const effects = {
      window: vi.fn((_profile: string) => window as unknown as BrowserWindow | undefined),
      openProfile: vi.fn(async (_profile: string) => {}),
      profileName: (_profile: string) => "Work",
      attention: vi.fn((_profile: string, _host: string) => {}),
      native: vi.fn(async () => 2),
    };
    const controller = new AbortController();
    const inApp = createInAppBrowserOpenPrompt(effects);
    const request = prompt(controller);
    const result = inApp.prompt(request);
    return { owner: window, effects, controller, inApp, request, result };
  }
  const shown = async (h: ReturnType<typeof setup>) => {
    await vi.waitFor(() => expect(h.inApp.current("work")).not.toBeNull());
    h.inApp.acknowledge("work", "request-1");
  };

  it.each([
    ["open", 0],
    ["allow-host", 1],
    ["copy", 2],
    ["cancel", 3],
  ] as const)("pushes the card and maps %s to button %i", async (choice, button) => {
    const h = setup();
    await shown(h);
    const card = {
      requestId: "request-1",
      host: "example.com",
      url: "https://example.com/login",
      profileName: "Work",
      expiresAtMs: 123_000,
      waiting: 1,
    };
    expect(h.owner.webContents.send).toHaveBeenCalledWith(BROWSER_OPEN_REQUESTED_CHANNEL, card);
    expect(h.inApp.current("work")).toEqual(card);
    expect(h.inApp.current("personal")).toBeNull();
    h.inApp.answer("work", "request-1", choice, true);
    expect(await h.result).toBe(button);
    expect(h.owner.webContents.send).toHaveBeenLastCalledWith(
      BROWSER_OPEN_SETTLED_CHANNEL,
      "request-1",
    );
    expect(h.inApp.current("work")).toBeNull();
    expect(h.effects.native).not.toHaveBeenCalled();
  });

  it("re-sends the shown card when its queue count changes", async () => {
    const h = setup();
    await shown(h);
    h.inApp.waitingChanged("work", 1);
    expect(h.owner.webContents.send).toHaveBeenCalledOnce();
    h.inApp.waitingChanged("work", 3);
    expect(h.owner.webContents.send).toHaveBeenLastCalledWith(
      BROWSER_OPEN_REQUESTED_CHANNEL,
      expect.objectContaining({ requestId: "request-1", waiting: 3 }),
    );
    expect(h.inApp.current("work")?.waiting).toBe(3);
    h.inApp.waitingChanged("personal", 2);
    expect(h.owner.webContents.send).toHaveBeenCalledTimes(2);
    h.inApp.answer("work", "request-1", "cancel", false);
    expect(await h.result).toBe(3);
  });

  it("shows the window without stealing focus and signals only when unfocused", async () => {
    const focused = setup(true);
    await shown(focused);
    expect(focused.owner.show).toHaveBeenCalledOnce();
    expect(focused.owner.focus).not.toHaveBeenCalled();
    expect(focused.effects.attention).not.toHaveBeenCalled();
    const away = setup(false);
    await shown(away);
    expect(away.owner.focus).not.toHaveBeenCalled();
    expect(away.effects.attention).toHaveBeenCalledExactlyOnceWith("work", "example.com");
  });

  it.each([
    ["another profile", "personal", "request-1", "open", true],
    ["a stale request", "work", "request-0", "open", true],
    ["a missing request id", "work", undefined, "open", true],
    ["an untrusted open", "work", "request-1", "open", false],
    ["an untrusted host grant", "work", "request-1", "allow-host", undefined],
    ["an unknown choice", "work", "request-1", "always", true],
    ["an inherited key", "work", "request-1", "toString", true],
  ])("rejects %s and leaves the request pending", async (_name, profile, id, choice, trusted) => {
    const h = setup();
    await shown(h);
    expect(() => h.inApp.answer(profile, id, choice, trusted)).toThrow();
    expect(h.inApp.current("work")?.requestId).toBe("request-1");
    h.inApp.answer("work", "request-1", "cancel", false);
    expect(await h.result).toBe(3);
  });

  it("falls back to the native dialog when no card acknowledges in time", async () => {
    vi.useFakeTimers();
    const h = setup();
    await vi.waitFor(() => expect(h.inApp.current("work")).not.toBeNull());
    await vi.advanceTimersByTimeAsync(3000);
    expect(await h.result).toBe(2);
    expect(h.effects.native).toHaveBeenCalledExactlyOnceWith(h.request);
    expect(h.owner.webContents.send).toHaveBeenLastCalledWith(
      BROWSER_OPEN_SETTLED_CHANNEL,
      "request-1",
    );
    expect(() => h.inApp.answer("work", "request-1", "open", true)).toThrow();
  });

  it("keeps waiting after an acknowledgement and falls back if the renderer dies", async () => {
    vi.useFakeTimers();
    const h = setup();
    await vi.waitFor(() => expect(h.inApp.current("work")).not.toBeNull());
    h.inApp.acknowledge("work", "request-1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.effects.native).not.toHaveBeenCalled();
    h.owner.webContents.emit("render-process-gone");
    expect(await h.result).toBe(2);
    expect(h.effects.native).toHaveBeenCalledOnce();
  });

  it("settles the card and denies on abort, without a native fallback", async () => {
    const h = setup();
    await shown(h);
    h.controller.abort();
    expect(await h.result).toBe(3);
    expect(h.owner.webContents.send).toHaveBeenLastCalledWith(
      BROWSER_OPEN_SETTLED_CHANNEL,
      "request-1",
    );
    expect(h.effects.native).not.toHaveBeenCalled();
    expect(() => h.inApp.answer("work", "request-1", "open", true)).toThrow();
  });

  it("denies without a card when no owner window can be opened", async () => {
    const effects = {
      window: vi.fn(() => undefined),
      openProfile: vi.fn(async () => {}),
      profileName: () => "Work",
      attention: vi.fn(),
      native: vi.fn(async () => 0),
    };
    const inApp = createInAppBrowserOpenPrompt(effects);
    expect(await inApp.prompt(prompt())).toBe(3);
    expect(effects.openProfile).toHaveBeenCalledWith("work");
    expect(effects.native).not.toHaveBeenCalled();
  });
});
