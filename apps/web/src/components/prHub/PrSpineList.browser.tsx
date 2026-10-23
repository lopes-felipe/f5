import "../../index.css";
import { PullRequestKey, type TrackedPullRequest } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PrSpineList } from "./PrSpineList";
const pr = (number: number, extra: Partial<TrackedPullRequest> = {}) =>
  ({
    key: PullRequestKey.makeUnsafe(`github:github.com/org/repo#${number}`),
    number,
    provider: "github",
    title: `Change ${number}`,
    state: "open",
    isDraft: false,
    repository: { nameWithOwner: "org/repo" },
    checkRollup: "success",
    notificationPending: false,
    attentionState: "ready_to_merge",
    ...extra,
  }) as TrackedPullRequest;
let screen: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await userEvent.keyboard("{/Shift}{/Control}");
  await screen?.unmount();
});
it("shows only forge-supported Shift actions and clears them with other modifiers or blur", async () => {
  const onQuickAction = vi.fn(),
    onSelect = vi.fn();
  const prs = [pr(1), pr(2, { provider: "bitbucket" }), pr(3, { provider: "unknown" })];
  screen = await render(
    <PrSpineList prs={prs} selectedKey={null} onSelect={onSelect} onQuickAction={onQuickAction} />,
  );
  expect(page.getByRole("button", { name: "Merge PR #1", exact: true }).query()).toBeNull();
  await userEvent.keyboard("{Shift>}");
  await expect
    .element(page.getByRole("button", { name: "Merge PR #1", exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Close PR #2", exact: true }))
    .toBeVisible();
  expect(page.getByRole("button", { name: "Merge PR #2", exact: true }).query()).toBeNull();
  expect(page.getByRole("button", { name: "Close PR #3", exact: true }).query()).toBeNull();
  await page.getByRole("button", { name: "Close PR #2", exact: true }).click();
  expect(onQuickAction).toHaveBeenCalledExactlyOnceWith(prs[1], "close");
  expect(onSelect).not.toHaveBeenCalled();
  await userEvent.keyboard("{Control>}");
  await expect
    .element(page.getByRole("button", { name: "Merge PR #1", exact: true }))
    .not.toBeInTheDocument();
  await userEvent.keyboard("{/Control}");
  await expect
    .element(page.getByRole("button", { name: "Merge PR #1", exact: true }))
    .toBeVisible();
  window.dispatchEvent(new Event("blur"));
  await expect
    .element(page.getByRole("button", { name: "Merge PR #1", exact: true }))
    .not.toBeInTheDocument();
});
it("opens the clicked row's action menu and narrows closed PRs to reopen", async () => {
  const onQuickAction = vi.fn(),
    onSelect = vi.fn();
  const prs = [pr(1), pr(2, { provider: "gitlab", state: "closed" })];
  screen = await render(
    <PrSpineList
      prs={prs}
      selectedKey={prs[0]!.key}
      onSelect={onSelect}
      onQuickAction={onQuickAction}
    />,
  );
  page
    .getByRole("option", { name: /Change 2/ })
    .element()
    .dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
    );
  await expect.element(page.getByRole("menuitem", { name: "Reopen…", exact: true })).toBeVisible();
  expect(page.getByRole("menuitem", { name: "Merge…", exact: true }).query()).toBeNull();
  await page.getByRole("menuitem", { name: "Reopen…", exact: true }).click();
  expect(onQuickAction).toHaveBeenCalledExactlyOnceWith(prs[1], "reopen");
  expect(onSelect).not.toHaveBeenCalled();
});
