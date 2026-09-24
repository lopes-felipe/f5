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
  canApprove: boolean;
  approvalOptions?: ReadonlyArray<ProviderApprovalOption> | undefined;
  isResponding: boolean;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
}

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  requestKind,
  canApprove,
  approvalOptions,
  isResponding,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const approveDisabled = isResponding || !canApprove;
  if (requestKind === "mcp-elicitation") {
    const options = approvalOptions?.length
      ? approvalOptions
      : [
          { decision: "cancel" as const, label: "Cancel" },
          { decision: "decline" as const, label: "Decline" },
        ];
    return (
      <>
        {options.map((option) => (
          <Button
            key={option.decision}
            size="sm"
            variant={option.decision === "accept" ? "default" : "outline"}
            disabled={isResponding || (option.decision.startsWith("accept") && !canApprove)}
            onClick={() => void onRespondToApproval(requestId, option.decision)}
          >
            {option.label}
          </Button>
        ))}
      </>
    );
  }
  return (
    <>
      {requestKind !== "permission" ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={isResponding}
          onClick={() => void onRespondToApproval(requestId, "cancel")}
        >
          Cancel turn
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="destructive-outline"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "decline")}
      >
        Decline
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={approveDisabled}
        onClick={() => void onRespondToApproval(requestId, "acceptForSession")}
      >
        Always allow this session
      </Button>
      <Button
        size="sm"
        variant="default"
        disabled={approveDisabled}
        onClick={() => void onRespondToApproval(requestId, "accept")}
      >
        Approve once
      </Button>
    </>
  );
});
