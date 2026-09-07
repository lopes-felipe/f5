import "../../index.css";

import type { TrackedPullRequest } from "@t3tools/contracts";
import { PullRequestKey } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { PrFocusView } from "./PrFocusView";
import { TooltipProvider } from "../ui/tooltip";

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => {
    throw new Error("native API is not exercised by focus navigation tests");
  },
}));

function makePr(number: number, title: string): TrackedPullRequest {
  return {
    key: PullRequestKey.makeUnsafe(`github:github.com/octo/repo#${number}`),
    provider: "github",
    nodeId: `PR_${number}`,
    number,
    title,
    url: `https://github.com/octo/repo/pull/${number}`,
    repository: { owner: "octo", repo: "repo", nameWithOwner: "octo/repo" },
    host: "github.com",
    author: "me",
    isDraft: false,
    state: "open",
    roles: ["author"],
    attentionState: "ci_failing",
    attentionBucket: "needs_you",
    primaryReason: "CI failing",
    nextAction: "Fix CI",
    checkRollup: "failure",
    reviewDecision: "review_required",
    mergeable: "mergeable",
    mergeStateStatus: "CLEAN",
    viewerHasReviewed: false,
    viewerReviewRequested: false,
    reviewRequestReviewers: [],
    reviewRequestsCount: 0,
    commentsCount: 0,
    unresolvedThreadCount: 0,
    actionableUnresolvedThreadCount: 0,
    waitingSince: null,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    headRefOid: null,
    baseRefName: "main",
    headRefName: "feature",
    labels: [],
    assignees: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    snoozedUntil: null,
    ignoredAt: null,
    notificationPending: false,
    attentionFingerprint: `fp-${number}`,
  };
}

const PRS = [makePr(1, "Alpha PR"), makePr(2, "Bravo PR"), makePr(3, "Charlie PR")];

let active: Awaited<ReturnType<typeof render>> | undefined;

afterEach(async () => {
  await active?.unmount();
  active = undefined;
});

async function renderFocus(
  focusedPrKey: string | null = null,
  prs = PRS,
  refreshIncomplete = false,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  active = await render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delay={0}>
        <PrFocusView
          prs={prs}
          refreshIncomplete={refreshIncomplete}
          advisoriesByKey={new Map()}
          analyzingKeys={new Set()}
          onAnalyzeAdvisory={() => {}}
          focusedPrKey={focusedPrKey}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function cardHeading(title: string) {
  return page.getByRole("heading", { level: 2, name: title });
}

describe("PrFocusView navigation", () => {
  it("opens the in-app files view from the Review action", async () => {
    await renderFocus(null, [
      {
        ...makePr(11, "Review me"),
        roles: ["review_requested"],
        attentionState: "review_requested",
        viewerReviewRequested: true,
      },
    ]);
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await expect
      .element(page.getByRole("tab", { name: "Files (0)" }))
      .toHaveAttribute("aria-selected", "true");
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });

  it("steps through the queue with n/p", async () => {
    await renderFocus();
    await expect.element(cardHeading("Alpha PR")).toBeInTheDocument();

    await userEvent.keyboard("{n}");
    await expect.element(cardHeading("Bravo PR")).toBeInTheDocument();

    await userEvent.keyboard("{p}");
    await expect.element(cardHeading("Alpha PR")).toBeInTheDocument();
  });

  it("does not trap the cursor on the deep-linked PR", async () => {
    await renderFocus("github.com/octo/repo#2");
    await expect.element(cardHeading("Bravo PR")).toBeInTheDocument();

    // Regression: n/p must move off the deep-link rather than snapping back.
    await userEvent.keyboard("{n}");
    await expect.element(cardHeading("Charlie PR")).toBeInTheDocument();

    await userEvent.keyboard("{p}");
    await expect.element(cardHeading("Bravo PR")).toBeInTheDocument();
  });
});

it("distinguishes incomplete refreshes from a healthy empty queue", async () => {
  await renderFocus(null, [], true);
  await expect.element(page.getByText("No results available", { exact: true })).toBeVisible();
  await expect
    .element(page.getByText("The latest refresh was incomplete. Pull requests may be missing."))
    .toBeVisible();
  await active?.unmount();
  active = undefined;
  await renderFocus(null, []);
  await expect
    .element(page.getByText("Nothing in this queue needs you right now.", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByText("No results available", { exact: true }))
    .not.toBeInTheDocument();
});
