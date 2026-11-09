import "../../index.css";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { TrackedPullRequest } from "@t3tools/contracts";
import { PrFilesTab } from "./PrFilesTab";

const query = vi.hoisted(() => ({
  isPending: false,
  isError: true,
  error: new Error("RPC http://localhost:1234: GitHub API rate limit exceeded"),
  refetch: vi.fn(),
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useInfiniteQuery: () => query,
}));
vi.mock("../../appSettings", async (original) => ({
  ...(await original<typeof import("../../appSettings")>()),
  useAppSettings: () => ({ settings: {}, updateSettings: vi.fn() }),
}));

it("explains a failed diff, keeps technical details collapsed, and allows retry and GitHub access", async () => {
  const pr = {
    key: "github:github.com/team/repo#7",
    url: "https://github.com/team/repo/pull/7",
  } as TrackedPullRequest;
  const screen = await render(<PrFilesTab pr={pr} active />);
  await expect.element(page.getByText("GitHub rate limit reached", { exact: true })).toBeVisible();
  await expect.element(page.getByText(query.error.message, { exact: true })).not.toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Open on GitHub" }))
    .toHaveAttribute("href", pr.url);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  expect(query.refetch).toHaveBeenCalledOnce();
  await page.getByText("Technical details", { exact: true }).click();
  await expect.element(page.getByText(query.error.message, { exact: true })).toBeVisible();
  await screen.unmount();
});
