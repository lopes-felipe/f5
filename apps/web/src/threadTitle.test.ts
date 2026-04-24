import { describe, expect, it } from "vitest";

import { buildPlanImplementationThreadTitle } from "./proposedPlan";
import { normalizeGeneratedThreadTitle } from "./threadTitle";

describe("normalizeGeneratedThreadTitle", () => {
  it("preserves the full generated implementation title", () => {
    expect(
      normalizeGeneratedThreadTitle(
        buildPlanImplementationThreadTitle(
          "# Refactor the thread sidebar resizing behavior without truncating the generated title",
        ),
      ),
    ).toBe(
      "Implement Refactor the thread sidebar resizing behavior without truncating the generated title",
    );
  });
});
