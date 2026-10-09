import type { ThreadId } from "@t3tools/contracts";
import { readNativeApi } from "../nativeApi";
import { newCommandId } from "../lib/utils";
export async function stopComputerTurn(threadId: ThreadId): Promise<void> {
  try {
    await window.desktopBridge?.computerAutomation?.setPaused(threadId, true);
  } finally {
    await readNativeApi()?.orchestration.dispatchCommand({
      type: "thread.turn.interrupt",
      commandId: newCommandId(),
      threadId,
      createdAt: new Date().toISOString(),
    });
  }
}
export async function pauseComputerThread(threadId: ThreadId, paused: boolean): Promise<void> {
  await window.desktopBridge?.computerAutomation?.setPaused(threadId, paused);
  await readNativeApi()?.preview.automation.setPaused({ threadId, paused });
}
