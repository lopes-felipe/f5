import { createContext, runInContext } from "node:vm";
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
  const document = { activeElement: {} as object, body: {} };
  const composer = {
    isConnected: true,
    focus: vi.fn(() => {
      document.activeElement = composer;
    }),
  };
  document.activeElement = composer;
  const context = createContext({ document });
  const host = {
    isDestroyed: () => false,
    executeJavaScript: async (script: string) => runInContext(script, context),
  };
  const preview = (id: number) => ({ tagName: "WEBVIEW", getWebContentsId: () => id });
  const guest = (id: number) =>
    ({ id, hostWebContents: host, focusedFrame: null }) as unknown as WebContents;
  return { document, composer, context, host, preview, guest };
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
    const guest = { ...f.guest(7), debugger: debuggee } as unknown as WebContents;
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
    expect(commands).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(debuggee.sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 10,
      y: 20,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
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
