import type { PendingApproval } from "../../session-logic";

export function ApprovalPresentation({ approval }: { approval: PendingApproval }) {
  const presentation = approval.presentation;
  return (
    <div className="space-y-1 text-xs text-muted-foreground wrap-anywhere">
      {presentation?.title ? <p className="font-medium">{presentation.title}</p> : null}
      {presentation?.description ? <p>{presentation.description}</p> : null}
      {presentation?.decisionReason ? <p>Reason: {presentation.decisionReason}</p> : null}
      {presentation?.blockedPath ? (
        <p>
          Path: <code>{presentation.blockedPath}</code>
        </p>
      ) : null}
      {presentation?.agentId ? (
        <p>
          Requested by sub-agent <code>{presentation.agentId}</code>
        </p>
      ) : null}
    </div>
  );
}
