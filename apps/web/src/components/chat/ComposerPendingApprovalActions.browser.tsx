import "../../index.css";
import { ApprovalRequestId } from "@t3tools/contracts";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

it("names the app and sends the user's advertised persistent approval", async () => {
  const requestId = ApprovalRequestId.make("mcp-browser");
  const respond = vi.fn(async () => {});
  const screen = await render(
    <>
      <ComposerPendingApprovalPanel
        approval={{
          requestId,
          requestKind: "mcp-elicitation",
          createdAt: new Date().toISOString(),
          appName: "Calendar",
          detail: "Allow ChatGPT to use Calendar?",
        }}
        pendingCount={1}
      />
      <ComposerPendingApprovalActions
        requestId={requestId}
        requestKind="mcp-elicitation"
        canApprove
        isResponding={false}
        approvalOptions={[
          { decision: "decline", label: "Decline" },
          { decision: "acceptAlways", label: "Always allow" },
        ]}
        onRespondToApproval={respond}
      />
    </>,
  );
  try {
    await expect.element(page.getByText("Calendar", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Approve once" }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Always allow", exact: true }).click();
    expect(respond).toHaveBeenCalledExactlyOnceWith(requestId, "acceptAlways");
  } finally {
    await screen.unmount();
  }
});
