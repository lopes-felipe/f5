import type { WebContents } from "electron";

const HOST_FOCUS = "globalThis.__f5PreviewFocus";

/**
 * Agent pointer input can focus a guest's native view. Share the saved host field across
 * overlapping presses in sibling tabs, without restoring over a different user focus target.
 * Call inside the tab's automation queue so later pointer events cannot overtake capture.
 */
export async function preservePreviewHostFocus<T>(
  guest: Pick<WebContents, "id" | "hostWebContents" | "focusedFrame">,
  action: () => T | Promise<T>,
): Promise<T> {
  const host = guest.hostWebContents;
  if (!host || host.isDestroyed() || guest.focusedFrame) return action();
  await host.executeJavaScript(`(() => {
    const state = (${HOST_FOCUS} ??= { saved: null, presses: [] });
    const active = document.activeElement;
    let pressed = false;
    try {
      pressed = active?.tagName === "WEBVIEW" && state.presses.includes(active.getWebContentsId());
    } catch {}
    if (!pressed) {
      state.saved = active && active !== document.body && active.tagName !== "WEBVIEW" ? active : null;
    }
    state.presses.push(${guest.id});
  })()`);
  try {
    return await action();
  } finally {
    if (!host.isDestroyed()) {
      await host.executeJavaScript(`(() => {
        const state = ${HOST_FOCUS};
        const index = state ? state.presses.indexOf(${guest.id}) : -1;
        if (index < 0) return;
        state.presses.splice(index, 1);
        if (state.presses.length === 0) delete ${HOST_FOCUS};
        const current = document.activeElement;
        try {
          if (state.saved?.isConnected && current?.tagName === "WEBVIEW" &&
              current.getWebContentsId() === ${guest.id}) state.saved.focus({ preventScroll: true });
        } catch {}
      })()`);
    }
  }
}
