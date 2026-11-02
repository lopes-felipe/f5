import { useAgentComputerActivityStore } from "../agentComputerActivityStore";
import { useAgentBrowserActivityStore } from "../agentBrowserActivityStore";
import type { ThreadId } from "@t3tools/contracts";
import { readNativeApi } from "../nativeApi";
import { newCommandId } from "../lib/utils";
export function computerStopShortcutLabel(host?: {
  hostPlatform?: "darwin" | "win32" | undefined;
  stopShortcut?: string | undefined;
}): string {
  return (
    host?.stopShortcut ??
    (host?.hostPlatform === "win32"
      ? "Ctrl+Alt+Shift+F12"
      : host?.hostPlatform === "darwin"
        ? "⌃⌘Esc"
        : "Stop in F5")
  );
}
export async function stopComputerTurn(threadId: ThreadId): Promise<void> {
  useAgentComputerActivityStore.getState().markStopUnconfirmed(threadId);
  const outcomes = await Promise.allSettled([
    pauseComputerThread(threadId, true),
    Promise.resolve().then(() => {
      const api = readNativeApi();
      if (!api) throw new Error("The host is disconnected.");
      return api.orchestration.dispatchCommand({
        type: "thread.turn.interrupt",
        commandId: newCommandId(),
        threadId,
        createdAt: new Date().toISOString(),
      });
    }),
  ]);
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : [],
  );
  if (failures.length)
    throw new AggregateError(failures, "Stop unconfirmed. Check the app and retry Stop.");
  useAgentComputerActivityStore.getState().confirmStopIfReleased(threadId);
}
export async function pauseComputerThread(threadId: ThreadId, paused: boolean): Promise<void> {
  const bridge = window.desktopBridge?.computerAutomation;
  if (!paused && !bridge) throw new Error("Resume on the computer running F5.");
  useAgentComputerActivityStore.getState().invalidate(threadId);
  const outcomes = await Promise.allSettled([
    (() => {
      try {
        return Promise.resolve(bridge?.setPaused(threadId, paused));
      } catch (error) {
        return Promise.reject(error);
      }
    })(),
    Promise.resolve().then(() => {
      if (!paused) return;
      const api = readNativeApi();
      if (!api) throw new Error("The host is disconnected.");
      return api.preview.automation.setPaused({ threadId, paused });
    }),
  ]);
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Computer control could not be updated.");
  // Main sends the authoritative resume notification only after its checks succeed.
}

/** Preview resume shares the pause latch; computer-bound threads need local approval. */
export async function pausePreviewThread(threadId: ThreadId, paused: boolean): Promise<void> {
  if (paused) useAgentBrowserActivityStore.getState().setPaused(threadId, true);
  // Preload consumes the trusted click synchronously. Starting this after the
  // WebSocket reply can expire the gesture before main sees the resume request.
  const bridge = window.desktopBridge?.computerAutomation;
  const localResume =
    !paused && bridge
      ? bridge.setPaused(threadId, false).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        )
      : undefined;
  try {
    await readNativeApi()?.preview.automation.setPaused({ threadId, paused });
  } catch (error) {
    if (!localResume) throw error;
    const result = await localResume;
    if (!result.ok) throw result.error;
    return; // The authoritative main echo updates both stores.
  }
  if (!paused) useAgentBrowserActivityStore.getState().setPaused(threadId, false);
}
