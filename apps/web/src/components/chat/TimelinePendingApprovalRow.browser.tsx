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
        presentation: {
          defaultToNo: true,
          decisionReason: "Outside workspace",
          blockedPath: "/private/data",
          agentId: "worker-1",
        },
      }}
      actions={{ respondingRequestIds: [], onRespondToApproval: async () => {} }}
    />,
  );
  try {
    await expect.element(page.getByText("Reason: Outside workspace")).toBeVisible();
    await expect.element(page.getByText("/private/data")).toBeVisible();
    await expect.element(page.getByText("worker-1")).toBeVisible();
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

it("shows provider-only approve and cancel choices and focuses just once across remounts", async () => {
  const actions = {
    respondingRequestIds: [],
    focusedRequestIds: new Set<string>(),
    onRespondToApproval: async () => {},
  };
  const approval = {
    requestId: ApprovalRequestId.make("remounted"),
    requestKind: "command" as const,
    createdAt: new Date().toISOString(),
    presentation: { defaultToNo: true },
    approvalOptions: [
      { decision: "acceptForSession" as const, label: "Allow session" },
      { decision: "cancel" as const, label: "Cancel request" },
    ],
  };
  const view = await render(<TimelinePendingApprovalRow approval={approval} actions={actions} />);
  await expect.element(page.getByRole("button", { name: "Cancel request" })).toHaveFocus();
  await expect.element(page.getByRole("button", { name: "Allow session" })).toBeVisible();
  await view.unmount();
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  const remounted = await render(
    <TimelinePendingApprovalRow approval={approval} actions={actions} />,
  );
  try {
    expect(document.activeElement).toBe(input);
  } finally {
    await remounted.unmount();
    input.remove();
  }
});
