import type { OrchestrationThread } from "@t3tools/contracts";
import {
  pendingApprovalActivities as pending,
  compareActivities,
} from "@t3tools/shared/pendingActivityWindow";

/** Replay approval activity in sequence order so all consumers agree on what is open. */
export function pendingApprovalActivities(thread: Pick<OrchestrationThread, "activities">) {
  return pending([...thread.activities].toSorted(compareActivities));
}
