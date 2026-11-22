import type { PendingApproval } from "../../session-logic";
import {
  ComposerPendingApprovalActions,
  canApproveRequest,
} from "./ComposerPendingApprovalActions";
import type { ComponentProps } from "react";
import { ApprovalPresentation } from "./ApprovalPresentation";

export type TimelineApprovalActions = {
  respondingRequestIds: readonly string[];
  focusedRequestIds?: Set<string>;
  onRespondToApproval: ComponentProps<typeof ComposerPendingApprovalActions>["onRespondToApproval"];
};

export function TimelinePendingApprovalRow({
  approval,
  actions,
}: {
  approval: PendingApproval;
  actions?: TimelineApprovalActions | undefined;
}) {
  return (
    <section
      className="my-2 min-w-0 rounded-lg border border-warning/40 p-3"
      aria-label="Pending approval"
    >
      <ApprovalPresentation approval={approval} />
      <pre
        tabIndex={0}
        className="max-h-60 overflow-auto whitespace-pre-wrap text-xs wrap-anywhere"
      >
        {approval.detail || "Permission requested"}
      </pre>
      {approval.appName ? (
        <p className="mt-1 text-xs text-muted-foreground">{approval.appName}</p>
      ) : null}
      {approval.requestedPermissions ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs">
          {JSON.stringify(approval.requestedPermissions, null, 2)}
        </pre>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-warning">Waiting for approval</span>
        {actions ? (
          <ComposerPendingApprovalActions
            {...approval}
            canApprove={canApproveRequest(approval)}
            isResponding={actions.respondingRequestIds.includes(approval.requestId)}
            onRespondToApproval={actions.onRespondToApproval}
            defaultToNo={approval.presentation?.defaultToNo}
            suppressAlwaysAllowRule={approval.presentation?.suppressAlwaysAllowRule}
            inline
            focusedRequestIds={actions.focusedRequestIds}
          />
        ) : null}
      </div>
    </section>
  );
}
