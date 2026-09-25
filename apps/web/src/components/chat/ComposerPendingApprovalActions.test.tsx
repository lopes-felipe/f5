import { ApprovalRequestId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

it("shows only advertised MCP app approval choices", () => {
  const markup = renderToStaticMarkup(
    <ComposerPendingApprovalActions
      requestId={ApprovalRequestId.make("mcp")}
      requestKind="mcp-elicitation"
      canApprove
      isResponding={false}
      approvalOptions={[
        { decision: "decline", label: "Decline" },
        { decision: "accept", label: "Approve once" },
      ]}
      onRespondToApproval={async () => {}}
    />,
  );
  expect(markup).toContain("Approve once");
  expect(markup).toContain("Decline");
  expect(markup).not.toContain("Always allow");
});

it("offers no approval when a persisted MCP request has no option metadata", () => {
  const markup = renderToStaticMarkup(
    <ComposerPendingApprovalActions
      requestId={ApprovalRequestId.make("mcp")}
      requestKind="mcp-elicitation"
      canApprove
      isResponding={false}
      onRespondToApproval={async () => {}}
    />,
  );
  expect(markup).toContain("Cancel");
  expect(markup).toContain("Decline");
  expect(markup).not.toContain("Approve");
});
