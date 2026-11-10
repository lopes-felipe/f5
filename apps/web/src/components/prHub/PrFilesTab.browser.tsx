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
  open: vi.fn(async () => {}),
}));
vi.mock("../../hooks/useOpenLink", () => ({ useOpenLink: () => query.open }));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useInfiniteQuery: () => query,
}));
vi.mock("../../appSettings", async (original) => ({
  ...(await original<typeof import("../../appSettings")>()),
  useAppSettings: () => ({ settings: {}, updateSettings: vi.fn() }),
}));

it.each([
  ["github", "GitHub"],
  ["gitlab", "GitLab"],
] as const)(
  "explains a failed diff for %s and uses configured link handling",
  async (provider, label) => {
    vi.clearAllMocks();
    const pr = {
      provider,
      key: "github:github.com/team/repo#7",
      url: "https://github.com/team/repo/pull/7",
    } as TrackedPullRequest;
    const screen = await render(<PrFilesTab pr={pr} active />);
    await expect
      .element(page.getByText(label + " rate limit reached", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText(query.error.message, { exact: true })).not.toBeVisible();
    await expect
      .element(page.getByRole("link", { name: "Open on " + label }))
      .toHaveAttribute("href", pr.url);
    await page.getByRole("link", { name: "Open on " + label }).click();
    expect(query.open).toHaveBeenCalledWith(pr.url, { external: false });
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    expect(query.refetch).toHaveBeenCalledOnce();
    await page.getByText("Technical details", { exact: true }).click();
    await expect.element(page.getByText(query.error.message, { exact: true })).toBeVisible();
    await screen.unmount();
  },
);
