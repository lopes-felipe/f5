import { ApprovalRequestId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

describe("ComposerPendingApprovalPanel", () => {
  it.each(["file-read", "file-change"] as const)(
    "shows the full permission profile and labels the reason on %s cards",
    (requestKind) => {
      const markup = renderToStaticMarkup(
        <ComposerPendingApprovalPanel
          approval={{
            requestId: ApprovalRequestId.makeUnsafe("filesystem-permission"),
            requestKind,
            createdAt: "2026-08-14T00:00:00.000Z",
            detail: "Need access to generated output",
            requestedPermissions: {
              network: true,
              fileSystem: {
                entries: [
                  {
                    access: requestKind === "file-read" ? "read" : "write",
                    path: { type: "glob_pattern", pattern: "/w/out/**" },
                  },
                ],
              },
            },
          }}
          pendingCount={1}
        />,
      );
      expect(markup).toContain(
        requestKind === "file-read"
          ? "File-read approval requested"
          : "File-change approval requested",
      );
      expect(markup).toContain('aria-label="Permission detail"');
      expect(markup).toContain("Need access to generated output");
      expect(markup).toContain("/w/out/**");
      expect(markup).toContain("glob_pattern");
      expect(markup).toContain(requestKind === "file-read" ? "read" : "write");
      expect(markup).toContain("network");
      expect(markup).toContain("true");
    },
  );

  it("shows unknown request identity and the complete server-bounded detail", () => {
    const detail = `head-${"x".repeat(400)}-tail`;
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.makeUnsafe("approval-unknown"),
          requestKind: "unknown",
          requestType: "workspace_policy_approval",
          createdAt: "2026-08-14T00:00:00.000Z",
          detail,
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain("Unknown approval requested");
    expect(markup).toContain("workspace_policy_approval");
    expect(markup).toContain(detail);
  });
});
