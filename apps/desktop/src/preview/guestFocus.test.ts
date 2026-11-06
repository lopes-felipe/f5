import { createContext, runInContext } from "node:vm";
import type { WebContents } from "electron";
import { expect, it, vi } from "vitest";
import { preservePreviewHostFocus } from "./guestFocus";

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
      if (outcome === "reload") delete f.context.__f5PreviewFocus;
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
