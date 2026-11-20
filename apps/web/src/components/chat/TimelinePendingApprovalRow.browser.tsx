import { ApprovalRequestId } from "@t3tools/contracts";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { TimelinePendingApprovalRow } from "./TimelinePendingApprovalRow";

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
