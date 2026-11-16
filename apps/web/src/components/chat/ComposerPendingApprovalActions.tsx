import {
  type ApprovalRequestId,
  type ProviderApprovalOption,
  type ProviderApprovalDecision,
} from "@t3tools/contracts";
import { memo } from "react";
import { type PendingApproval } from "../../session-logic";
import { Button } from "../ui/button";

interface ComposerPendingApprovalActionsProps {
  requestId: ApprovalRequestId;
  requestKind: PendingApproval["requestKind"];
  requestedPermissions?: PendingApproval["requestedPermissions"];
  canApprove: boolean;
  approvalOptions?: ReadonlyArray<ProviderApprovalOption> | undefined;
  /** Open on Decline and never present an approve choice as the default. */
  defaultToNo?: boolean | undefined;
  /** Hide persistent choices; the server downgrades them to a plain accept anyway. */
  suppressAlwaysAllowRule?: boolean | undefined;
  isResponding: boolean;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
}

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

export function approvalOptionVariant(input: {
  readonly decision: ProviderApprovalDecision;
  readonly providerOptions: boolean;
  readonly defaultToNo: boolean;
}): "default" | "outline" | "ghost" | "destructive-outline" {
  if (input.providerOptions) {
    return input.decision === "accept" && !input.defaultToNo ? "default" : "outline";
  }
  return optionVariant(input.decision, input.defaultToNo);
}

function optionVariant(
  decision: ProviderApprovalDecision,
  defaultToNo: boolean,
): "default" | "outline" | "ghost" | "destructive-outline" {
  if (decision === "accept") return defaultToNo ? "outline" : "default";
  if (decision === "decline") return "destructive-outline";
  if (decision === "cancel") return "ghost";
  return "outline";
}

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  requestKind,
  requestedPermissions,
  canApprove,
  approvalOptions,
  defaultToNo = false,
  suppressAlwaysAllowRule = false,
  isResponding,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const options = resolveApprovalOptions({
    requestKind,
    requestedPermissions,
    approvalOptions,
    suppressAlwaysAllowRule,
  });
  const focusDecision: ProviderApprovalDecision | undefined = defaultToNo
    ? options.some((option) => option.decision === "decline")
      ? "decline"
      : "cancel"
    : undefined;
  return (
    <>
      {options.map((option) => (
        <Button
          key={option.decision}
          size="sm"
          variant={approvalOptionVariant({
            decision: option.decision,
            providerOptions: Boolean(approvalOptions?.length),
            defaultToNo,
          })}
          // The provider asked for Decline to be the focused choice.
          autoFocus={option.decision === focusDecision}
          disabled={isResponding || (option.decision.startsWith("accept") && !canApprove)}
          onClick={() => void onRespondToApproval(requestId, option.decision)}
        >
          {option.label}
        </Button>
      ))}
      {options
        .filter((option) => option.warning)
        .map((option) => (
          <p
            key={`warning:${option.decision}`}
            role="note"
            className="w-full text-xs text-muted-foreground"
          >
            {option.label}: {option.warning}
          </p>
        ))}
    </>
  );
});
