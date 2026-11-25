import "../../index.css";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { PrHubChangedFile, TrackedPullRequest } from "@t3tools/contracts";
import { PrFilesTab } from "./PrFilesTab";

const query = vi.hoisted(() => ({
  isPending: false,
  isError: true,
  error: new Error("RPC http://localhost:1234: GitHub API rate limit exceeded"),
  refetch: vi.fn(),
  open: vi.fn(async () => {}),
  data: undefined as { pages: { files: PrHubChangedFile[] }[] } | undefined,
}));
vi.mock("../../hooks/useOpenLink", () => ({ useOpenLink: () => query.open }));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useInfiniteQuery: () => query,
  useQuery: () => ({}),
}));
vi.mock("../../appSettings", async (original) => {
  const actual = await original<typeof import("../../appSettings")>();
  const { useState } = await import("react");
  return {
    ...actual,
    useAppSettings: () => {
      const [settings, setSettings] = useState({
        diffCollapsedFolders: {},
        diffFileTreeOrder: "folders",
        diffFileDefaultState: "collapsed",
        diffIgnoreWhitespace: false,
        diffHideTestFiles: false,
      });
      return {
        settings,
        updateSettings: (patch: Partial<typeof settings>) =>
          setSettings((current) => ({ ...current, ...patch })),
      };
    },
  };
});

it("keeps the file tree and diffs in the same order and filters test support", async () => {
  const file = (path: string): PrHubChangedFile => ({
    path,
    changeType: "changed",
    additions: 1,
    deletions: 0,
  });
  query.isError = false;
  query.data = {
    pages: [
      { files: [file("README.md"), file("src/app.ts"), file("docs/help.md")] },
      { files: [file("src/app.test.ts"), file("src/__fixtures__/sample.json")] },
    ],
  };
  const pr = {
    provider: "github",
    key: "github:github.com/team/repo#7",
    host: "github.com",
    repository: { nameWithOwner: "team/repo" },
    url: "https://github.com/team/repo/pull/7",
    changedFiles: 5,
    additions: 5,
    deletions: 0,
  } as TrackedPullRequest;
  const screen = await render(<PrFilesTab pr={pr} active />);
  try {
    await page.getByText("Changed files (5)", { exact: true }).click();
    const diffPaths = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>("[data-pr-file-path]"),
        (entry) => entry.dataset.prFilePath,
      );
    const treePaths = () =>
      Array.from(document.querySelectorAll<HTMLElement>('[aria-label^="File "]'), (entry) =>
        entry.getAttribute("aria-label")?.slice(5),
      );
    expect(diffPaths()).toEqual([
      "docs/help.md",
      "src/__fixtures__/sample.json",
      "src/app.test.ts",
      "src/app.ts",
      "README.md",
    ]);
    expect(treePaths()).toEqual(diffPaths());
    await page.getByRole("checkbox", { name: /Hide test files/ }).click();
    expect(diffPaths()).toEqual(["docs/help.md", "src/app.ts", "README.md"]);
    expect(treePaths()).toEqual(diffPaths());
  } finally {
    await screen.unmount();
    query.isError = true;
    query.data = undefined;
  }
});

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
