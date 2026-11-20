import { ApprovalRequestId } from "@t3tools/contracts";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { TimelinePendingApprovalRow } from "./TimelinePendingApprovalRow";

it("focuses the provider's preferred decline decision when answerable", async () => {
  const view = await render(
    <TimelinePendingApprovalRow
      approval={{
        requestId: ApprovalRequestId.make("preferred-no"),
        requestKind: "command",
        createdAt: new Date().toISOString(),
        presentation: { defaultToNo: true },
      }}
      actions={{ respondingRequestIds: [], onRespondToApproval: async () => {} }}
    />,
  );
  try {
    await expect.element(page.getByRole("button", { name: "Decline", exact: true })).toHaveFocus();
  } finally {
    await view.unmount();
  }
});

it("keeps complete commands visible and sends the chosen decision", async () => {
  const requestId = ApprovalRequestId.make("approval");
  const respond = vi.fn(async () => {});
  const detail = "echo " + "a".repeat(600) + "\nprintf 'done'";
  const view = await render(
    <TimelinePendingApprovalRow
      approval={{
        requestId,
        createdAt: new Date().toISOString(),
        requestKind: "command",
        detail,
      }}
      actions={{ respondingRequestIds: [], onRespondToApproval: respond }}
    />,
  );
  try {
    expect(document.querySelector("pre")?.textContent).toBe(detail);
    await page.getByText("More", { exact: true }).click();
    await page.getByRole("button", { name: "Always allow this session" }).click();
    expect(respond).toHaveBeenCalledExactlyOnceWith(requestId, "acceptForSession");
  } finally {
    await view.unmount();
  }
});
