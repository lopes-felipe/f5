import { describe, expect, it } from "vitest";

import {
  BRANCH_LIST_VIRTUALIZATION_THRESHOLD,
  shouldScrollHighlightedBranchIntoView,
  shouldVirtualizeBranchListForCount,
} from "./BranchToolbar.logic";

describe("shouldVirtualizeBranchListForCount", () => {
  it("renders through the plain ComboboxList path when the branch list is small", () => {
    // A handful of branches fits comfortably into the ScrollArea-backed list;
    // mounting LegendList for 3 items wastes more than it saves.
    expect(shouldVirtualizeBranchListForCount(3)).toBe(false);
    expect(shouldVirtualizeBranchListForCount(0)).toBe(false);
  });

  it("keeps the non-virtualized path at exactly the threshold", () => {
    expect(shouldVirtualizeBranchListForCount(BRANCH_LIST_VIRTUALIZATION_THRESHOLD)).toBe(false);
  });

  it("switches to LegendList once the filtered list exceeds the threshold", () => {
    expect(shouldVirtualizeBranchListForCount(BRANCH_LIST_VIRTUALIZATION_THRESHOLD + 1)).toBe(true);
    expect(shouldVirtualizeBranchListForCount(500)).toBe(true);
  });
});

describe("shouldScrollHighlightedBranchIntoView", () => {
  it("only scrolls highlighted items into view when the popup is open", () => {
    expect(
      shouldScrollHighlightedBranchIntoView({
        isMenuOpen: false,
        highlightedIndex: 4,
        highlightReason: "keyboard",
      }),
    ).toBe(false);
  });

  it("ignores the synthetic highlight reset when the menu closes (index -1)", () => {
    expect(
      shouldScrollHighlightedBranchIntoView({
        isMenuOpen: true,
        highlightedIndex: -1,
        highlightReason: "keyboard",
      }),
    ).toBe(false);
  });

  it("suppresses scroll for pointer highlights so mouse-over doesn't jump the list", () => {
    // Upstream migration explicitly dropped unconditional hover-scroll; this
    // guards against re-introducing the "list jumps when the cursor passes
    // over an off-screen row" regression.
    for (const reason of ["pointer", "mouse", "touch", "none", ""]) {
      expect(
        shouldScrollHighlightedBranchIntoView({
          isMenuOpen: true,
          highlightedIndex: 2,
          highlightReason: reason,
        }),
      ).toBe(false);
    }
  });

  it("scrolls the highlighted item into view for keyboard navigation", () => {
    expect(
      shouldScrollHighlightedBranchIntoView({
        isMenuOpen: true,
        highlightedIndex: 0,
        highlightReason: "keyboard",
      }),
    ).toBe(true);
    expect(
      shouldScrollHighlightedBranchIntoView({
        isMenuOpen: true,
        highlightedIndex: 25,
        highlightReason: "keyboard",
      }),
    ).toBe(true);
  });
});
