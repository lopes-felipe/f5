import type {
  ForgeCapabilities,
  SourceControlProviderKind,
  TrackedPullRequest,
} from "@t3tools/contracts";
import { forgeCapabilitiesFor } from "@t3tools/shared/forgeCapabilities";
export type PrQuickAction = "merge" | "close" | "ready" | "reopen";
export interface PrQuickActionRequest {
  readonly kind: PrQuickAction;
  readonly id: string;
}
export const PR_QUICK_ACTION_LABELS: Record<PrQuickAction, string> = {
  merge: "Merge",
  close: "Close",
  ready: "Mark ready",
  reopen: "Reopen",
};
/** No detail reads on list render: explicit action requests load and recheck the live PR. */
export function prQuickActions(input: {
  provider: SourceControlProviderKind;
  state?: TrackedPullRequest["state"] | undefined;
  isDraft?: boolean | undefined;
  repositoryArchived?: boolean | undefined;
  forgeCapabilities?: ForgeCapabilities | undefined;
}): PrQuickAction[] {
  if (input.repositoryArchived || input.state === "merged") return [];
  const caps = input.forgeCapabilities ?? forgeCapabilitiesFor(input.provider);
  if (!caps) return [];
  const actions: PrQuickAction[] =
    input.state === "closed"
      ? ["reopen"]
      : input.isDraft
        ? ["ready", "close"]
        : input.state === "open"
          ? ["merge", "close"]
          : ["merge", "ready", "close", "reopen"];
  return actions.filter((action) => caps.actions.includes(action));
}
