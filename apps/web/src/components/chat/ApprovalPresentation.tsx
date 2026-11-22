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
              ? presentation.askRuleSource === "policySettings"
                ? "An organization-managed Claude permission rule requires approval even in full access. Contact your administrator to change this rule."
                : presentation.askRuleSource === "cliArg"
                  ? "Claude was launched with an ask rule that requires approval even in full access. Review the launch configuration to change this rule."
                  : "An ask rule in Claude's permission settings requires approval even in full access. Review the matching rule and its source before changing it."
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
