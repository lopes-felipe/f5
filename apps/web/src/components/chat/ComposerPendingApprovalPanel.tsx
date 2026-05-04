import { memo } from "react";
import { type PendingApproval } from "../../session-logic";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
}

function approvalSummary(requestKind: PendingApproval["requestKind"]): string {
  switch (requestKind) {
    case "command":
      return "Command approval requested";
    case "file-read":
      return "File-read approval requested";
    case "file-change":
      return "File-change approval requested";
    case "permission":
      return "Permission approval requested";
    default: {
      const exhaustive: never = requestKind;
      return exhaustive;
    }
  }
}

function formatRequestedPermissions(permissions: Record<string, unknown> | undefined): string {
  if (!permissions) {
    return "No permission profile supplied.";
  }
  return JSON.stringify(permissions, null, 2);
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
}: ComposerPendingApprovalPanelProps) {
  const summary = approvalSummary(approval.requestKind);

  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="uppercase text-sm tracking-[0.2em]">PENDING APPROVAL</span>
        <span className="text-sm font-medium">{summary}</span>
        {pendingCount > 1 ? (
          <span className="text-xs text-muted-foreground">1/{pendingCount}</span>
        ) : null}
      </div>
      {approval.requestKind === "permission" ? (
        <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/70 bg-muted/40 p-3 font-mono text-xs leading-relaxed text-foreground">
          {formatRequestedPermissions(approval.requestedPermissions)}
        </pre>
      ) : null}
    </div>
  );
});
