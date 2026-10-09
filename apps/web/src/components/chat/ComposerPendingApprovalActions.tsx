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
  canApprove,
  approvalOptions,
  defaultToNo = false,
  suppressAlwaysAllowRule = false,
  isResponding,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const advertised = approvalOptions?.length
    ? approvalOptions
    : requestKind === "mcp-elicitation"
      ? [
          { decision: "cancel" as const, label: "Cancel" },
          { decision: "decline" as const, label: "Decline" },
        ]
      : requestKind === "permission"
        ? DEFAULT_OPTIONS.filter((option) => option.decision !== "cancel")
        : DEFAULT_OPTIONS;
  const options = suppressAlwaysAllowRule
    ? advertised.filter(
        (option) => option.decision !== "acceptForSession" && option.decision !== "acceptAlways",
      )
    : advertised;
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
          variant={
            approvalOptions?.length
              ? option.decision === "accept" && !defaultToNo
                ? "default"
                : "outline"
              : optionVariant(option.decision, defaultToNo)
          }
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
