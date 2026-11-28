import type { ProviderApprovalOption } from "@t3tools/contracts";
import type { PendingApproval } from "./pendingApprovals";

const DEFAULT_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "cancel", label: "Cancel turn" },
  { decision: "decline", label: "Decline" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "accept", label: "Approve once" },
];

/**
 * The choices an approval offers, in button order: the provider's own when it sent any,
 * else the defaults for the request kind. Shared with Home, which answers approvals too.
 */
export function resolveApprovalOptions(input: {
  readonly requestKind: PendingApproval["requestKind"];
  readonly requestedPermissions?: PendingApproval["requestedPermissions"];
  readonly approvalOptions?: ReadonlyArray<ProviderApprovalOption> | undefined;
  readonly suppressAlwaysAllowRule?: boolean | undefined;
}): ReadonlyArray<ProviderApprovalOption> {
  const advertised = input.approvalOptions?.length
    ? input.approvalOptions
    : input.requestKind === "mcp-elicitation"
      ? [
          { decision: "cancel" as const, label: "Cancel" },
          { decision: "decline" as const, label: "Decline" },
        ]
      : input.requestKind === "permission" || input.requestedPermissions
        ? DEFAULT_OPTIONS.filter((option) => option.decision !== "cancel")
        : DEFAULT_OPTIONS;
  return input.suppressAlwaysAllowRule
    ? advertised.filter(
        (option) => option.decision !== "acceptForSession" && option.decision !== "acceptAlways",
      )
    : advertised;
}

/** A permission request without a permission profile has nothing to grant. */
export function canApproveRequest(
  approval: Pick<PendingApproval, "requestKind" | "requestedPermissions">,
): boolean {
  return approval.requestKind !== "permission" || approval.requestedPermissions !== undefined;
}
