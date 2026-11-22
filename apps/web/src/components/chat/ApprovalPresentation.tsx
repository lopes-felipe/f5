import type { PendingApproval } from "../../session-logic";

export function ApprovalPresentation({ approval }: { approval: PendingApproval }) {
  const presentation = approval.presentation;
  return (
    <div className="space-y-1 text-xs text-muted-foreground wrap-anywhere">
      {presentation?.title ? <p className="font-medium">{presentation.title}</p> : null}
      {presentation?.description ? <p>{presentation.description}</p> : null}
      {presentation?.decisionReason ? <p>Reason: {presentation.decisionReason}</p> : null}
      {presentation?.fullAccessOverride ? (
        <details>
          <summary className="cursor-pointer">Why am I being asked this?</summary>
          <p>
            {presentation.fullAccessOverride === "ask_rule"
              ? "Full access skips approvals, but an ask rule in Claude's own settings matches this action. Remove or narrow that rule to stop these prompts."
              : "Full access skips approvals, but Claude still enforces some provider safety checks. F5 cannot turn these off. Check the request before approving it."}
          </p>
        </details>
      ) : null}
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
