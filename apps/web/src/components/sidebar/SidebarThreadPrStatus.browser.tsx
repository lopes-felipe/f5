import "../../index.css";
import type { ThreadPullRequestLink } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { resolveThreadPullRequests } from "../../lib/threadPullRequests";
import { prStatusIndicator } from "./sidebarLists";
import { SidebarThreadPrStatus } from "./SidebarThreadRow";

const link = (number: number): ThreadPullRequestLink => ({
  provider: "github",
  host: "github.com",
  repository: "o/r",
  number,
  title: `Change ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
});

const indicator = (numbers: number[]) =>
  prStatusIndicator(
    resolveThreadPullRequests({
      branchPr: null,
      links: numbers.map(link),
      linkState: (url) => ({ state: url.endsWith("/1") ? "merged" : "open", title: url }),
    }),
  )!;

let active: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await active?.unmount();
  active = undefined;
});

it("opens a single PR directly, without a count", async () => {
  const onOpen = vi.fn();
  active = await render(
    <SidebarThreadPrStatus prStatus={indicator([2])} settled={false} onOpen={onOpen} />,
  );
  expect(page.getByTestId("sidebar-pr-count").query()).toBeNull();
  await page.getByRole("button").click();
  expect(onOpen).toHaveBeenCalledWith(expect.anything(), "https://github.com/o/r/pull/2");
});

it("counts several PRs and opens the chosen one from a menu", async () => {
  const onOpen = vi.fn();
  active = await render(
    <SidebarThreadPrStatus prStatus={indicator([1, 2])} settled={false} onOpen={onOpen} />,
  );
  await expect.element(page.getByTestId("sidebar-pr-count")).toHaveTextContent("2");
  await page.getByRole("button", { name: "2 pull requests" }).click();
  const items = page.getByRole("menuitem");
  await expect.element(items.first()).toHaveTextContent("#2");
  await expect.element(items.nth(1)).toHaveTextContent("#1");
  await items.nth(1).click();
  expect(onOpen).toHaveBeenCalledWith(null, "https://github.com/o/r/pull/1");
});
