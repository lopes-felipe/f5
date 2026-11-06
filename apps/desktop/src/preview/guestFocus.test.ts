import { createContext, runInContext } from "node:vm";
import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { expect, it, vi } from "vitest";
import { clickPreviewGuest, preservePreviewHostFocus } from "./guestFocus";
import { PreviewAutomationControl } from "./automationControl";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const events = new EventTarget();
  const document = {
    activeElement: {} as object,
    body: {},
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  };
  const composer = {
    isConnected: true,
    focus: vi.fn(() => {
      document.activeElement = composer;
    }),
  };
  document.activeElement = composer;
  const context = createContext({ document });
  Object.defineProperties(context, {
    setTimeout: { value: setTimeout },
    clearTimeout: { value: clearTimeout },
  });
  const host = {
    isDestroyed: () => false,
    focus: vi.fn(),
    executeJavaScript: async (script: string) => runInContext(script, context),
  };
  const preview = (id: number) => ({ tagName: "WEBVIEW", getWebContentsId: () => id });
  const guest = (id: number) =>
    Object.assign(new EventEmitter(), {
      id,
      hostWebContents: host,
      focusedFrame: null,
    }) as unknown as WebContents;
  const focusGuest = (id: number) => {
    document.activeElement = preview(id);
    events.dispatchEvent(new Event("focusin"));
  };
  return { document, composer, context, host, preview, guest, focusGuest };
}

it.each(["restore", "other-field", "removed", "failure", "reload"])(
  "preserves host focus around a pointer batch: %s",
  async (outcome) => {
    const f = fixture();
    const preview = f.preview(7);
    const other = { tagName: "INPUT" };
    const result = preservePreviewHostFocus(f.guest(7), () => {
      f.document.activeElement = outcome === "other-field" ? other : preview;
      if (outcome === "removed") f.composer.isConnected = false;
      if (outcome === "reload") runInContext("delete globalThis.__f5PreviewFocus", f.context);
      if (outcome === "failure") throw new Error("Pointer failed");
    });
    if (outcome === "failure") await expect(result).rejects.toThrow("Pointer failed");
    else await result;
    expect(f.document.activeElement).toBe(
      outcome === "other-field"
        ? other
        : outcome === "removed" || outcome === "reload"
          ? preview
          : f.composer,
    );
    expect(Object.keys(f.context)).toEqual(["document"]);
  },
);

it.each([false, true])(
  "shares saved focus across sibling presses without blocking a tab, user clicks: %s",
  async (userClicks) => {
    const f = fixture();
    const first = f.preview(7);
    const second = f.preview(8);
    const started = deferred();
    const finish = deferred();
    const stuck = preservePreviewHostFocus(f.guest(7), async () => {
      f.document.activeElement = first;
      started.resolve();
      await finish.promise;
    });
    await started.promise;
    await preservePreviewHostFocus(f.guest(8), () => {
      f.document.activeElement = userClicks ? first : second;
    });
    expect(f.document.activeElement).toBe(userClicks ? first : f.composer);
    finish.resolve();
    await stuck;
    expect(Object.keys(f.context)).toEqual(["document"]);
  },
);

it("leaves a user-focused guest alone", async () => {
  const f = fixture();
  const guest = { ...f.guest(7), focusedFrame: {} } as WebContents;
  const action = vi.fn(() => 42);
  f.document.activeElement = f.preview(7);
  expect(await preservePreviewHostFocus(guest, action)).toBe(42);
  expect(action).toHaveBeenCalledOnce();
  expect(f.composer.focus).not.toHaveBeenCalled();
});

it.each([false, true])(
  "waits for delayed renderer input and respects same-guest takeover: %s",
  async (takeover) => {
    const f = fixture();
    const control = new PreviewAutomationControl();
    const preview = f.preview(7);
    const pressed = deferred();
    const finish = deferred();
    const commands: string[] = [];
    const debuggee = {
      isAttached: () => false,
      attach: vi.fn(),
      sendCommand: vi.fn(async (_method: string, params: { type: string }) => {
        commands.push(params.type);
        if (params.type === "mousePressed") {
          pressed.resolve();
          await finish.promise;
          f.document.activeElement = preview;
        }
      }),
    };
    const guest = Object.assign(f.guest(7), { debugger: debuggee });
    const result = control.run("tab", (checkpoint) => clickPreviewGuest(guest, 10, 20, checkpoint));
    // Attach a rejection handler before takeover rejects the running action.
    const settled = Promise.allSettled([result]);
    await pressed.promise;
    expect(f.document.activeElement).toBe(f.composer);
    expect(f.composer.focus).not.toHaveBeenCalled();
    expect(commands).toEqual(["mouseMoved", "mousePressed"]);
    if (takeover) control.cancel("tab");
    finish.resolve();
    const [outcome] = await settled;
    expect(outcome!.status).toBe(takeover ? "rejected" : "fulfilled");
    expect(f.document.activeElement).toBe(takeover ? preview : f.composer);
    expect(commands).toEqual(
      takeover ? ["mouseMoved", "mousePressed"] : ["mouseMoved", "mousePressed", "mouseReleased"],
    );
    if (!takeover)
      expect(debuggee.sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: 10,
        y: 20,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
    if (!takeover)
      expect(debuggee.sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: 10,
        y: 20,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
    expect(debuggee.attach).toHaveBeenCalledWith("1.3");
    expect(Object.keys(f.context)).toEqual(["document"]);
  },
);

it("restores native keyboard focus on repeated clicks even with a remembered guest focusedFrame", async () => {
  const f = fixture();
  const guest = Object.assign(f.guest(7), { focusedFrame: {} }) as WebContents;
  f.host.focus.mockImplementation(() => {
    f.document.activeElement = f.preview(7);
  });
  for (let index = 0; index < 2; index++) {
    await preservePreviewHostFocus(guest, () => f.focusGuest(7));
    expect(f.document.activeElement).toBe(f.composer);
  }
  expect(f.host.focus).toHaveBeenCalledTimes(2);
});

it("waits for a host focus notification arriving after input acknowledgement", async () => {
  const f = fixture();
  await preservePreviewHostFocus(f.guest(7), () => {
    setTimeout(() => f.focusGuest(7), 0);
  });
  expect(f.host.focus).toHaveBeenCalledOnce();
  expect(f.document.activeElement).toBe(f.composer);
});

it.each([false, true])(
  "keeps the action result when restore fails, action fails: %s",
  async (fails) => {
    const f = fixture();
    const execute = f.host.executeJavaScript;
    let calls = 0;
    f.host.executeJavaScript = async (script) => {
      if (++calls === 2) throw new Error("Host reloaded");
      return execute(script);
    };
    const failure = new Error("Input failed");
    const result = preservePreviewHostFocus(f.guest(7), () => {
      if (fails) throw failure;
      return 42;
    });
    if (fails) await expect(result).rejects.toBe(failure);
    else expect(await result).toBe(42);
  },
);

it("runs the action without restoration when capture fails", async () => {
  const f = fixture();
  f.host.executeJavaScript = vi.fn(async () => {
    throw new Error("Host reloaded");
  });
  const action = vi.fn(() => 42);
  expect(await preservePreviewHostFocus(f.guest(7), action)).toBe(42);
  expect(action).toHaveBeenCalledOnce();
  expect(f.host.executeJavaScript).toHaveBeenCalledOnce();
  expect(f.host.focus).not.toHaveBeenCalled();
});

it("observes takeover during the asynchronous host restore hop", async () => {
  const f = fixture();
  const cancellation = new AbortController();
  const waiting = deferred();
  const proceed = deferred();
  const execute = f.host.executeJavaScript;
  f.host.executeJavaScript = async (script) => {
    if (script.startsWith("(async")) {
      waiting.resolve();
      await proceed.promise;
    }
    return execute(script);
  };
  const result = preservePreviewHostFocus(
    f.guest(7),
    () => f.focusGuest(7),
    () => true,
    cancellation.signal,
  );
  await waiting.promise;
  cancellation.abort();
  proceed.resolve();
  await result;
  expect(f.host.focus).not.toHaveBeenCalled();
  expect(f.composer.focus).not.toHaveBeenCalled();
  expect(f.context.__f5PreviewFocus).toBeUndefined();
});

it.each(["timeout", "takeover"])(
  "releases a stalled click queue on %s without sending late input",
  async (reason) => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const pending = deferred();
      const pressed = deferred();
      const control = new PreviewAutomationControl();
      const sendCommand = vi.fn(async (_method: string, params: { type: string }) => {
        if (params.type === "mousePressed") {
          f.focusGuest(7);
          pressed.resolve();
          await pending.promise;
        }
      });
      const guest = Object.assign(f.guest(7), {
        debugger: { isAttached: () => true, sendCommand },
      }) as unknown as WebContents;
      const result = control.run("tab", (checkpoint) =>
        clickPreviewGuest(guest, 10, 20, checkpoint),
      );
      const rejected = expect(result).rejects.toThrow(
        reason === "timeout" ? "timed out" : "user took control",
      );
      await pressed.promise;
      if (reason === "timeout") await vi.advanceTimersByTimeAsync(5001);
      else control.cancel("tab");
      await rejected;
      expect(f.context.__f5PreviewFocus).toBeUndefined();
      await expect(
        control.run("tab", (checkpoint) => clickPreviewGuest(guest, 10, 20, checkpoint)),
      ).rejects.toThrow("still pending");
      pending.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(sendCommand.mock.calls.map(([, params]) => params.type)).toEqual([
        "mouseMoved",
        "mousePressed",
      ]);
    } finally {
      vi.useRealTimers();
    }
  },
);
