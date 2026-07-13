import "../../index.css";

import type { TrackedPullRequest } from "@t3tools/contracts";
import { PullRequestKey } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { PrInboxView } from "./PrInboxView";
import { TooltipProvider } from "../ui/tooltip";

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => {
    throw new Error("native API is not exercised by inbox navigation tests");
  },
}));

function makePr(number: number, title: string): TrackedPullRequest {
  return {
    key: PullRequestKey.makeUnsafe(`github.com/octo/repo#${number}`),
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

async function renderInbox(
  focusedPrKey: string | null = null,
  prs: readonly TrackedPullRequest[] = PRS,
) {
  active = await render(
    <TooltipProvider delay={0}>
      <PrInboxView
        prs={prs}
        advisoriesByKey={new Map()}
        analyzingKeys={new Set()}
        onAnalyzeAdvisory={() => {}}
        focusedPrKey={focusedPrKey}
      />
    </TooltipProvider>,
  );
}

/** The detail-pane heading uniquely identifies which PR is selected. */
function detailHeading(title: string) {
  return page.getByRole("heading", { level: 2, name: title });
}

describe("PrInboxView navigation", () => {
  it("selects the first PR and moves with j/k", async () => {
    await renderInbox();
    await expect.element(detailHeading("Alpha PR")).toBeInTheDocument();

    await userEvent.keyboard("{j}");
    await expect.element(detailHeading("Bravo PR")).toBeInTheDocument();

    await userEvent.keyboard("{k}");
    await expect.element(detailHeading("Alpha PR")).toBeInTheDocument();
  });

  it("keeps navigating after a row is clicked (guard must not swallow the spine)", async () => {
    await renderInbox();
    await page.getByRole("option", { name: /Bravo PR/ }).click();
    await expect.element(detailHeading("Bravo PR")).toBeInTheDocument();

    // Regression: the click focuses the spine option; the next key press must
    // still navigate rather than being suppressed as an "interactive target".
    await userEvent.keyboard("{j}");
    await expect.element(detailHeading("Charlie PR")).toBeInTheDocument();
  });

  it("does not trap selection on the deep-linked PR", async () => {
    await renderInbox("github.com/octo/repo#2");
    await expect.element(detailHeading("Bravo PR")).toBeInTheDocument();

    // Regression: selection must move off the deep-link and stay moved.
    await userEvent.keyboard("{j}");
    await expect.element(detailHeading("Charlie PR")).toBeInTheDocument();

    await userEvent.keyboard("{k}");
    await expect.element(detailHeading("Bravo PR")).toBeInTheDocument();
  });

  it("updates the selected row when the spine is virtualized", async () => {
    const manyPrs = Array.from({ length: 61 }, (_, index) =>
      makePr(index + 1, `Pull request ${index + 1}`),
    );
    await renderInbox(null, manyPrs);

    const first = page.getByRole("option", { name: /^Pull request 1 / });
    const second = page.getByRole("option", { name: /^Pull request 2 / });
    await expect.element(first).toHaveAttribute("aria-selected", "true");

    await second.click();

    await expect.element(detailHeading("Pull request 2")).toBeInTheDocument();
    await expect.element(second).toHaveAttribute("aria-selected", "true");
    await expect.element(first).toHaveAttribute("aria-selected", "false");
  });
});
