import {
  type ApprovalRequestId,
  type ProviderApprovalOption,
  type ProviderApprovalDecision,
} from "@t3tools/contracts";
import { memo, useRef } from "react";
import { type PendingApproval } from "../../session-logic";
import { resolveApprovalOptions } from "@t3tools/shared/approvalOptions";
export { canApproveRequest, resolveApprovalOptions } from "@t3tools/shared/approvalOptions";
import { Button } from "../ui/button";

interface ComposerPendingApprovalActionsProps {
  inline?: boolean;
  focusedRequestIds?: Set<string> | undefined;
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
  inline = false,
  focusedRequestIds,
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
  const localFocusedIds = useRef(new Set<string>());
  const focusedIds = focusedRequestIds ?? localFocusedIds.current;
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
  const primaryAccept = options.some((option) => option.decision === "accept")
    ? "accept"
    : options.find((option) => option.decision.startsWith("accept"))?.decision;
  const visible = (decision: ProviderApprovalDecision) =>
    decision === "accept" ||
    decision === "decline" ||
    decision === primaryAccept ||
    decision === focusDecision;
  return (
    <>
      {(inline ? options.filter((option) => visible(option.decision)) : options).map((option) => (
        <Button
          key={option.decision}
          size={inline ? "xs" : "sm"}
          variant={approvalOptionVariant({
            decision: option.decision,
            providerOptions: Boolean(approvalOptions?.length),
            defaultToNo,
          })}
          // The provider asked for Decline to be the focused choice.
          ref={(button) => {
            if (!button || option.decision !== focusDecision) return;
            if (focusedIds.has(requestId)) return;
            focusedIds.add(requestId);
            button.focus({ preventScroll: true });
          }}
          disabled={isResponding || (option.decision.startsWith("accept") && !canApprove)}
          onClick={() => void onRespondToApproval(requestId, option.decision)}
        >
          {option.label}
        </Button>
      ))}
      {inline && options.some((option) => !visible(option.decision)) ? (
        <details>
          <summary className="cursor-pointer">More</summary>
          <div className="mt-1 flex flex-wrap gap-2">
            {options
              .filter((option) => !visible(option.decision))
              .map((option) => (
                <Button
                  key={option.decision}
                  size="xs"
                  variant="outline"
                  disabled={isResponding || (option.decision.startsWith("accept") && !canApprove)}
                  onClick={() => void onRespondToApproval(requestId, option.decision)}
                >
                  {option.label}
                </Button>
              ))}
          </div>
        </details>
      ) : null}
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
