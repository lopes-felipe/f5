import type {
  CommandId,
  NextTurnQueueItem,
  NextTurnQueueSnapshot,
  OrchestrationUsageLimit,
} from "@t3tools/contracts";
import { usageLimitFailureKey } from "@t3tools/shared/usageLimit";

export interface UsageLimitNoticeModel {
  readonly limitKey: string | null;
  readonly ledger: NonNullable<NextTurnQueueSnapshot["usageLimitResume"]> | null;
  readonly item: NextTurnQueueItem | undefined;
  /** The card renders nothing once its continue has been sent. */
  readonly hidden: boolean;
  /** The pending continue the card shows, which the queue panel leaves out. */
  readonly foldedItemId: CommandId | null;
}

/** One source for the card, the queue panel and ChatView to agree on the continue. */
export function resolveUsageLimitNotice(
  limit: OrchestrationUsageLimit,
  snapshot: NextTurnQueueSnapshot | null,
): UsageLimitNoticeModel {
  const limitKey = usageLimitFailureKey(limit);
  const ledger =
    snapshot?.usageLimitResume?.limitKey === limitKey ? snapshot.usageLimitResume : null;
  const item = ledger
    ? snapshot?.items.find(
        (candidate) =>
          candidate.itemId === ledger.itemId && candidate.scheduleReason === "usage_limit_reset",
      )
    : undefined;
  const delivered = limit.deliveryId !== null;
  const pending = item?.status === "queued" || item?.status === "dispatching";
  const continued = ledger?.state === "completed" || (ledger?.state === "scheduled" && !item);
  return {
    limitKey,
    ledger,
    item,
    hidden: !delivered && !pending && item?.status !== "failed" && continued,
    foldedItemId: !delivered && pending ? item.itemId : null,
  };
}
