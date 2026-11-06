import type { WebContents } from "electron";
import type { PreviewAutomationCheckpoint } from "./automationControl";
import { previewDebugger } from "./previewDebugger";

const HOST_FOCUS = "globalThis.__f5PreviewFocus";
const INPUT_TIMEOUT_MS = 5_000;
let focusSequence = 0;

/** Preserve both DOM and native keyboard focus across sibling preview presses. */
export async function preservePreviewHostFocus<T>(
  guest: Pick<WebContents, "id" | "hostWebContents">,
  action: () => T | Promise<T>,
  canRestore: () => boolean = () => true,
  signal?: AbortSignal,
): Promise<T> {
  const host = guest.hostWebContents;
  if (!host || host.isDestroyed()) return action();
  const token = ++focusSequence;
  const restoreKey = JSON.stringify(`__f5PreviewRestore${token}`);
  try {
    await host.executeJavaScript(`(() => {
      const state = (${HOST_FOCUS} ??= { saved: null, presses: [] });
      const active = document.activeElement;
      let pressed = false;
      try {
        pressed = active?.tagName === "WEBVIEW" &&
          state.presses.some(press => press.id === active.getWebContentsId());
      } catch {}
      if (!pressed) {
        state.saved = active && active !== document.body && active.tagName !== "WEBVIEW" ? active : null;
      }
      state.presses.push({ id: ${guest.id}, token: ${token} });
    })()`);
  } catch {
    // Host reload/destruction must not prevent otherwise valid guest input.
    return action();
  }
  const invalidate = () => {
    if (!host.isDestroyed()) {
      void host
        .executeJavaScript(`(() => {
        const state = ${HOST_FOCUS};
        if (state) state.saved = null;
        globalThis[${restoreKey}]?.(true);
      })()`)
        .catch(() => undefined);
    }
  };
  signal?.addEventListener("abort", invalidate, { once: true });
  try {
    return await action();
  } finally {
    try {
      if (!host.isDestroyed()) {
        const restore = await host.executeJavaScript(`(async () => {
          const state = ${HOST_FOCUS};
          const index = state ? state.presses.findIndex(press => press.token === ${token}) : -1;
          if (index < 0) return false;
          if (!${canRestore()}) state.saved = null;
          const saved = state.saved;
          // Retain the state until this wait ends so cancellation can invalidate it.
          if (saved?.isConnected && document.activeElement === saved) {
            await new Promise(resolve => {
              const done = () => {
                clearTimeout(timer);
                document.removeEventListener("focusin", done);
                resolve();
              };
              const timer = setTimeout(done, 100);
              document.addEventListener("focusin", done);
            });
          }
          const completed = state.presses.findIndex(press => press.token === ${token});
          if (completed >= 0) state.presses.splice(completed, 1);
          if (state.presses.length === 0 && ${HOST_FOCUS} === state) delete ${HOST_FOCUS};
          const eligible = () => {
            const current = document.activeElement;
            try {
              return saved?.isConnected && state.saved === saved && (current === saved ||
                (current?.tagName === "WEBVIEW" && current.getWebContentsId() === ${guest.id}));
            } catch { return false; }
          };
          if (!eligible()) return false;
          globalThis[${restoreKey}] = (cancelled = false) => {
            delete globalThis[${restoreKey}];
            if (cancelled) state.saved = null;
            else if (eligible()) saved.focus({ preventScroll: true });
          };
          return true;
        })()`);
        if (restore && canRestore() && !signal?.aborted && !host.isDestroyed()) {
          // DOM focus alone cannot release the guest's native keyboard focus.
          host.focus();
          await host.executeJavaScript(`globalThis[${restoreKey}]?.()`);
        }
      }
    } catch {
      // Focus bookkeeping must not replace the input result or interruption error.
    } finally {
      signal?.removeEventListener("abort", invalidate);
      if (!host.isDestroyed()) {
        void host.executeJavaScript(`delete globalThis[${restoreKey}]`).catch(() => undefined);
      }
    }
  }
}

// A timed-out command remains live in Chromium. Do not overlap it with a retry.
const pendingInput = new WeakMap<WebContents, Promise<unknown>>();

function sendInput(
  guest: WebContents,
  params: Record<string, unknown>,
  checkpoint: PreviewAutomationCheckpoint,
): Promise<unknown> {
  checkpoint.check();
  const command = previewDebugger(guest).sendCommand("Input.dispatchMouseEvent", params);
  pendingInput.set(guest, command);
  const clear = () => {
    if (pendingInput.get(guest) === command) pendingInput.delete(guest);
    guest.removeListener("did-navigate", clear);
  };
  guest.once("did-navigate", clear);
  void command.then(clear, clear);
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown, value?: unknown) => {
      clearTimeout(timer);
      checkpoint.signal?.removeEventListener("abort", cancel);
      if (error) reject(error);
      else resolve(value);
    };
    const cancel = () => finish(checkpoint.signal?.reason);
    const timer = setTimeout(
      () => finish(new Error("Preview input timed out. Reload the preview before retrying.")),
      INPUT_TIMEOUT_MS,
    );
    checkpoint.signal?.addEventListener("abort", cancel, { once: true });
    if (checkpoint.signal?.aborted) cancel();
    void command.then(
      (value) => finish(undefined, value),
      (error) => finish(error),
    );
  });
}

/** CSS pixels match snapshots and getBoundingClientRect even on zoomed tabs. */
export async function clickPreviewGuest(
  guest: WebContents,
  x: number,
  y: number,
  checkpoint: PreviewAutomationCheckpoint,
): Promise<void> {
  checkpoint.check();
  if (pendingInput.has(guest))
    throw new Error("Preview input is still pending. Reload the preview before retrying.");
  const debuggee = previewDebugger(guest);
  if (!debuggee.isAttached()) debuggee.attach("1.3");
  await preservePreviewHostFocus(
    guest,
    async () => {
      await sendInput(guest, { type: "mouseMoved", x, y }, checkpoint);
      await sendInput(
        guest,
        {
          type: "mousePressed",
          x,
          y,
          button: "left",
          buttons: 1,
          clickCount: 1,
        },
        checkpoint,
      );
      await sendInput(
        guest,
        {
          type: "mouseReleased",
          x,
          y,
          button: "left",
          buttons: 0,
          clickCount: 1,
        },
        checkpoint,
      );
    },
    () => {
      try {
        checkpoint.check();
        return true;
      } catch {
        return false;
      }
    },
    checkpoint.signal,
  );
  checkpoint.check();
}
