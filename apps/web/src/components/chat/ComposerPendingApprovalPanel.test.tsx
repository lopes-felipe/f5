import { ApprovalRequestId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

describe("ComposerPendingApprovalPanel", () => {
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
