import { NATIVE_OPERATION_WS_METHODS, WS_METHODS, type DiskSpaceStatus } from "@t3tools/contracts";

export const emptyDiskSpaceStatus: DiskSpaceStatus = {
  level: "ok",
  checkedAt: "2026-01-01T00:00:00.000Z",
  lowThresholdBytes: 0,
  criticalThresholdBytes: 0,
  volumes: [],
  reclaimable: [],
};

/** Empty background services for full-app browser fixtures that don't exercise them. */
export function resolveEmptyAppRpc(body: { _tag: string; threadId?: string }): unknown {
  if (body._tag === NATIVE_OPERATION_WS_METHODS.list) return [];
  // `null` means the provider history is complete; `{}` would show the recovery banner.
  if (body._tag === NATIVE_OPERATION_WS_METHODS.historyRecovery) return null;
  if (body._tag === WS_METHODS.storageGetDiskSpace) return emptyDiskSpaceStatus;
  if (body._tag === WS_METHODS.nextTurnQueueSummary) return { threads: [] };
  // Not read-only, so it waits for synchronization and is then sent.
  if (body._tag === WS_METHODS.scheduledTasksList) return { tasks: [], revision: 0 };
  if (body._tag === WS_METHODS.nextTurnQueueList) {
    return {
      threadId: body.threadId,
      items: [],
      revision: 0,
      paused: false,
      blockedKind: null,
      reasonCode: null,
      reasonDetail: null,
      maxItems: 20,
      quarantinedCount: 0,
    };
  }
  return undefined;
}
