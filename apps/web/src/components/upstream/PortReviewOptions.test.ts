import { describe, expect, it } from "vitest";

import { portReviewDefaults, portReviewOptionsError } from "./PortReviewOptions";

type Models = Parameters<typeof portReviewDefaults>[1];
/** No picker models for any provider. */
const NO_MODELS = new Proxy({}, { get: () => [] }) as Models;

describe("portReviewDefaults", () => {
  it("keeps a saved extra reviewer whose provider is unavailable, and flags its row", () => {
    const extra = { provider: "cursor" as const, model: "composer-2" };
    const value = portReviewDefaults(
      {
        enabled: true,
        reviewerA: null,
        reviewerB: null,
        additionalReviewers: [extra],
        consolidation: null,
      },
      NO_MODELS,
      [],
    );
    expect(value.additionalReviewers).toEqual([extra]);
    expect(portReviewOptionsError({ ...value, reviewerA: extra, reviewerB: extra, consolidation: extra }, [])).toBe(
      "Reviewer A: choose an enabled provider that supports code review, or turn off code review.",
    );
    expect(
      portReviewOptionsError(
        {
          ...value,
          reviewerA: { provider: "codex", model: "gpt-5.5" },
          reviewerB: { provider: "codex", model: "gpt-5.5" },
          consolidation: { provider: "codex", model: "gpt-5.5" },
        },
        [{ enabled: true, driver: "codex", instanceId: "codex" }] as never,
      ),
    ).toBe("Reviewer C: choose an enabled provider that supports code review, or turn off code review.");
  });
});
