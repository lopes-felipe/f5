import type { TrackedPullRequest } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import { buildPrAttentionNotification } from "./prHubNotifications";

function pr(number: number, attentionState: string): TrackedPullRequest {
  return {
    key: `o/r#${number}`,
    number,
    repository: { nameWithOwner: "o/r" },
    primaryReason: attentionState === "ci_failing" ? "Fix CI" : "Review",
    nextAction: "Take a look",
    attentionState,
  } as unknown as TrackedPullRequest;
}

describe("buildPrAttentionNotification", () => {
  it("opens the one pull request it names", () => {
    const input = buildPrAttentionNotification(
      { batchId: "b1", pullRequests: [pr(1, "review_requested")] },
      vi.fn(),
    );
    expect(input).toMatchObject({
      source: "pr",
      title: "Review: o/r#1",
      body: "Take a look",
      target: { kind: "prHub", prKey: "o/r#1" },
    });
    expect(input.items).toBeUndefined();
  });

  it("lists a batch as rows, with the rest counted", () => {
    const navigate = vi.fn();
    const input = buildPrAttentionNotification(
      {
        batchId: "b2",
        pullRequests: [pr(1, "review_requested"), pr(2, "ci_failing"), pr(3, "x"), pr(4, "y")],
      },
      navigate,
    );
    expect(input.title).toBe("4 pull requests need you");
    expect(input.os?.title).toBe("4 pull requests need your attention");
    expect(input.items?.map((item) => [item.label, item.trailing, item.tone])).toEqual([
      ["o/r#1", "Review", "warning"],
      ["o/r#2", "Fix CI", "destructive"],
      ["o/r#3", "Review", "warning"],
    ]);
    expect(input.items?.[1]?.target).toEqual({ kind: "prHub", prKey: "o/r#2" });
    expect(input.moreCount).toBe(1);
    input.actions?.find((action) => action.label === "Open hub")?.onClick({} as never);
    expect(navigate).toHaveBeenCalledWith();
  });
});
