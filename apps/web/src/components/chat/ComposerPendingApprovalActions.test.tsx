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

it.each(["file-read", "file-change", "permission"] as const)(
  "keeps permission choices and destructive Decline styling for %s cards",
  (requestKind) => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("permission")}
        requestKind={requestKind}
        requestedPermissions={
          requestKind === "permission"
            ? { network: true }
            : {
                fileSystem: {
                  entries: [
                    {
                      access: requestKind === "file-read" ? "read" : "write",
                      path: { type: "glob_pattern", pattern: "/w/out/**" },
                    },
                  ],
                },
              }
        }
        canApprove
        isResponding={false}
        onRespondToApproval={async () => {}}
      />,
    );
    expect(markup).not.toContain("Cancel turn");
    expect(markup).toContain("Always allow this session");
    expect(markup).toContain("Approve once");
    expect(markup).toMatch(/<button[^>]*text-destructive-foreground[^>]*>Decline<\/button>/);
  },
);

it("keeps Cancel turn for file approvals without permission profiles", () => {
  const markup = renderToStaticMarkup(
    <ComposerPendingApprovalActions
      requestId={ApprovalRequestId.make("file")}
      requestKind="file-change"
      canApprove
      isResponding={false}
      onRespondToApproval={async () => {}}
    />,
  );
  expect(markup).toContain("Cancel turn");
});
