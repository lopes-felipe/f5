import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserOpenAuthority } from "./BrowserOpenAuthority";
import {
  BROWSER_OPEN_REQUESTED_CHANNEL,
  BROWSER_OPEN_SETTLED_CHANNEL,
  createInAppBrowserOpenPrompt,
  createNativeBrowserOpenPrompt,
} from "./BrowserOpenPrompt";

afterEach(() => vi.useRealTimers());

/** Models Electron: `show()` focuses the window, `showInactive()` does not. */
function owner(state: { focused?: boolean; visible?: boolean; minimized?: boolean } = {}) {
  const window = { focused: true, visible: true, minimized: false, ...state };
  const contents = Object.assign(new EventEmitter(), {
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
    isLoading: vi.fn(() => false),
  });
  return {
    isDestroyed: () => false,
    isFocused: () => window.focused,
    isVisible: () => window.visible,
    isMinimized: () => window.minimized,
    show: vi.fn(() => Object.assign(window, { visible: true, focused: true })),
    showInactive: vi.fn(() => Object.assign(window, { visible: true })),
    focus: vi.fn(() => Object.assign(window, { focused: true })),
    webContents: contents,
  };
}

function prompt(controller = new AbortController(), waiting = () => 1) {
  return {
    requestId: "request-1",
    profileId: "work",
    host: "example.com",
    url: "https://example.com/login",
    expiresAtMs: 123_000,
    waiting,
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
  function setup(state: Parameters<typeof owner>[0] & { closed?: boolean } = {}) {
    const window = owner(state);
    let open = !state.closed;
    const dismiss = vi.fn();
    const effects = {
      window: vi.fn(
        (_profile: string) => (open ? window : undefined) as unknown as BrowserWindow | undefined,
      ),
      openProfile: vi.fn(async (_profile: string) => {
        open = true;
      }),
      profileName: (_profile: string) => "Work",
      attention: vi.fn((_profile: string, _host: string) => dismiss),
      native: vi.fn(async () => 2),
    };
    const controller = new AbortController();
    const inApp = createInAppBrowserOpenPrompt(effects);
    const request = prompt(controller);
    const result = inApp.prompt(request);
    return { owner: window, effects, dismiss, controller, inApp, request, result };
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

  it("leaves a focused window alone and asks for nothing more", async () => {
    const h = setup();
    await shown(h);
    expect(h.owner.show).not.toHaveBeenCalled();
    expect(h.owner.showInactive).not.toHaveBeenCalled();
    expect(h.owner.focus).not.toHaveBeenCalled();
    expect(h.effects.attention).not.toHaveBeenCalled();
    h.inApp.answer("work", "request-1", "cancel", false);
    await h.result;
  });

  it.each([
    ["a hidden window", { focused: false, visible: false }, 1],
    ["a background window", { focused: false }, 0],
    ["a minimized window", { focused: false, visible: false, minimized: true }, 0],
  ])("shows %s without focusing it and draws attention", async (_name, state, inactive) => {
    const h = setup(state);
    await shown(h);
    expect(h.owner.isFocused()).toBe(false);
    expect(h.owner.show).not.toHaveBeenCalled();
    expect(h.owner.focus).not.toHaveBeenCalled();
    expect(h.owner.showInactive).toHaveBeenCalledTimes(inactive);
    expect(h.effects.attention).toHaveBeenCalledExactlyOnceWith("work", "example.com");
    expect(h.dismiss).not.toHaveBeenCalled();
    h.inApp.answer("work", "request-1", "open", true);
    expect(await h.result).toBe(0);
    expect(h.dismiss).toHaveBeenCalledOnce();
  });

  it("reads the focus state before reopening a closed profile window", async () => {
    const h = setup({ closed: true, focused: true });
    await shown(h);
    expect(h.effects.openProfile).toHaveBeenCalledWith("work");
    expect(h.effects.attention).toHaveBeenCalledOnce();
    h.controller.abort();
    expect(await h.result).toBe(3);
    expect(h.dismiss).toHaveBeenCalledOnce();
  });

  it("shows no card when the request is aborted while its window opens", async () => {
    const window = owner();
    let open = false;
    const controller = new AbortController();
    const attention = vi.fn(() => () => {});
    const inApp = createInAppBrowserOpenPrompt({
      window: () => (open ? (window as unknown as BrowserWindow) : undefined),
      openProfile: async () => {
        open = true;
        controller.abort();
      },
      profileName: () => "Work",
      attention,
      native: async () => 0,
    });
    expect(await inApp.prompt(prompt(controller))).toBe(3);
    expect(window.webContents.send).not.toHaveBeenCalled();
    expect(inApp.current("work")).toBeNull();
    expect(attention).not.toHaveBeenCalled();
  });

  it("frees the profile queue when a request expires while its window opens", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const window = owner();
    let open = false;
    const inApp = createInAppBrowserOpenPrompt({
      window: () => (open ? (window as unknown as BrowserWindow) : undefined),
      openProfile: () =>
        new Promise<void>((resolve) => {
          release = () => {
            open = true;
            resolve();
          };
        }),
      profileName: () => "Work",
      attention: () => () => {},
      native: async () => 3,
    });
    const authority = new BrowserOpenAuthority({
      prompt: inApp.prompt,
      waitingChanged: inApp.waitingChanged,
      open: async () => {},
      copy: () => {},
    });
    const stuck = authority.request("work", "https://example.com/one");
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(await stuck).toBe("denied");
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(window.webContents.send).not.toHaveBeenCalled();
    const next = authority.request("work", "https://example.com/two");
    await vi.waitFor(() => expect(inApp.current("work")?.url).toBe("https://example.com/two"));
    inApp.answer("work", inApp.current("work")!.requestId, "open", true);
    expect(await next).toBe("opened");
  });

  it("counts requests queued while the window was opening", async () => {
    let waiting = 0;
    let open = false;
    const window = owner();
    const inApp = createInAppBrowserOpenPrompt({
      window: () => (open ? (window as unknown as BrowserWindow) : undefined),
      openProfile: async () => {
        waiting = 2;
        open = true;
      },
      profileName: () => "Work",
      attention: () => () => {},
      native: async () => 3,
    });
    const controller = new AbortController();
    const result = inApp.prompt(prompt(controller, () => waiting));
    await vi.waitFor(() => expect(inApp.current("work")?.waiting).toBe(2));
    controller.abort();
    expect(await result).toBe(3);
  });

  it("treats closing the window as Cancel without reopening it", async () => {
    const h = setup();
    await shown(h);
    h.owner.webContents.emit("destroyed");
    expect(await h.result).toBe(3);
    expect(h.effects.native).not.toHaveBeenCalled();
    expect(h.effects.openProfile).not.toHaveBeenCalled();
  });

  it("gives a window that is still loading longer to show the card", async () => {
    vi.useFakeTimers();
    const h = setup({ closed: true });
    await vi.waitFor(() => expect(h.inApp.current("work")).not.toBeNull());
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.effects.native).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await h.result).toBe(2);
    expect(h.effects.native).toHaveBeenCalledOnce();
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
      attention: vi.fn(() => () => {}),
      native: vi.fn(async () => 0),
    };
    const inApp = createInAppBrowserOpenPrompt(effects);
    expect(await inApp.prompt(prompt())).toBe(3);
    expect(effects.openProfile).toHaveBeenCalledWith("work");
    expect(effects.native).not.toHaveBeenCalled();
  });
});
