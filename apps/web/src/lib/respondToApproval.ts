import type { ApprovalRequestId, ProviderApprovalDecision, ThreadId } from "@t3tools/contracts";

import { readNativeApi } from "../nativeApi";
import { newCommandId } from "./utils";

/** Sends the user's decision on a provider approval; shared by the chat view and notifications. */
export async function respondToApproval(input: {
  threadId: ThreadId;
  requestId: ApprovalRequestId;
  decision: ProviderApprovalDecision;
}): Promise<void> {
  const api = readNativeApi();
  if (!api) throw new Error("F5 is not connected.");
  await api.orchestration.dispatchCommand({
    type: "thread.approval.respond",
    commandId: newCommandId(),
    threadId: input.threadId,
    requestId: input.requestId,
    decision: input.decision,
    createdAt: new Date().toISOString(),
  });
}
