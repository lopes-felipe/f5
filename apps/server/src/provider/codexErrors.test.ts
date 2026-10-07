import { describe, expect, it } from "vitest";

import {
  detectCodexUsageLimit,
  formatCodexUnsupportedModelError,
  isUnsupportedCodexModelError,
} from "./codexErrors.ts";

describe("Codex unsupported model errors", () => {
  it.each([
    "The 'gpt-6-astra' model is not supported for this account.",
    "unknown model: gpt-6-astra",
    "requested model not found",
  ])("matches %s", (message) => {
    expect(isUnsupportedCodexModelError(message)).toBe(true);
  });

  it("appends a generic recovery hint without replacing the provider diagnostic", () => {
    const message = "unknown model: gpt-6-astra";
    const formatted = formatCodexUnsupportedModelError(message);

    expect(formatted).toContain(message);
    expect(formatted).toContain("Choose another model");
  });

  it("leaves unrelated errors unchanged", () => {
    expect(formatCodexUnsupportedModelError("permission denied")).toBe("permission denied");
    expect(formatCodexUnsupportedModelError("The model cache directory does not exist")).toBe(
      "The model cache directory does not exist",
    );
  });
});

it("accepts an exhausted provider update from the current turn, but excludes previous-turn caches", () => {
  const input = {
    message: "usage limit reached",
    errorInfo: "usageLimitReached",
    at: "2026-10-01T00:00:03Z",
    snapshotNotBefore: "2026-10-01T00:00:01Z",
    snapshots: [
      {
        observedAt: "2026-10-01T00:00:02Z",
        snapshot: {
          primary: { usedPercent: 100, resetsAt: Date.parse("2026-10-02T00:00:00Z") / 1000 },
        },
      },
    ],
  };
  expect(detectCodexUsageLimit(input)?.resetsAt).toBe("2026-10-02T00:00:00.000Z");
  expect(
    detectCodexUsageLimit({ ...input, snapshotNotBefore: "2026-10-01T00:00:02.500Z" })?.resetsAt,
  ).toBeNull();
  const { snapshotNotBefore: _, ...withoutCurrentTurn } = input;
  expect(detectCodexUsageLimit(withoutCurrentTurn)?.resetsAt).toBeNull();
});
