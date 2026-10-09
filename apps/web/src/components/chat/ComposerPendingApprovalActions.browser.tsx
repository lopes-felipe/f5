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

it("honors native permission choices and displays persistence warnings", async () => {
  const requestId = ApprovalRequestId.make("native-permission");
  const respond = vi.fn(async () => {});
  const screen = await render(
    <ComposerPendingApprovalActions
      requestId={requestId}
      requestKind="command"
      canApprove
      isResponding={false}
      approvalOptions={[
        { decision: "accept", label: "Allow once" },
        { decision: "cancel", label: "Cancel" },
        {
          decision: "acceptForSession",
          label: "Allow for this thread",
          warning: "This allows future shell commands.",
        },
      ]}
      onRespondToApproval={respond}
    />,
  );
  try {
    await expect
      .element(page.getByText("Allow for this thread: This allows future shell commands."))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Always allow this session" }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Allow once", exact: true }).click();
    expect(respond).toHaveBeenCalledExactlyOnceWith(requestId, "accept");
  } finally {
    await screen.unmount();
  }
});

it("focuses Decline and hides persistent choices when the provider asks", async () => {
  const requestId = ApprovalRequestId.make("claude-guarded");
  const respond = vi.fn(async () => {});
  const screen = await render(
    <ComposerPendingApprovalActions
      requestId={requestId}
      requestKind="command"
      canApprove
      isResponding={false}
      defaultToNo
      suppressAlwaysAllowRule
      onRespondToApproval={respond}
    />,
  );
  try {
    await expect.element(page.getByRole("button", { name: "Decline" })).toHaveFocus();
    await expect
      .element(page.getByRole("button", { name: "Always allow this session" }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Approve once" }).click();
    expect(respond).toHaveBeenCalledExactlyOnceWith(requestId, "accept");
  } finally {
    await screen.unmount();
  }
});
