import { describe, expect, it } from "vitest";
import {
  chatGptUsageLimitCode,
  CHATGPT_USAGE_LIMIT_CODE,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
} from "@t3tools/shared/usageLimit";

import {
  codexFailureMessage,
  detectCodexUsageLimit,
  formatCodexUnsupportedModelError,
  formatCodexUsageError,
  isUnsupportedCodexModelError,
  resolveCodexCompletionErrorInfo,
} from "./codexErrors.ts";

it("retains sharing details across a matching completion and drops them for a replacement failure", () => {
  const previous = {
    message: "429",
    additionalDetails: CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
    errorInfo: "other",
  };
  expect(chatGptUsageLimitCode(codexFailureMessage("429", undefined, previous)!)).toBe(
    CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
  );
  expect(codexFailureMessage("503", undefined, previous)).toBe("503");
  expect(codexFailureMessage("429", undefined, previous, "httpConnectionFailed")).toBe("429");
});

it.each([CHATGPT_USAGE_LIMIT_CODE, CHATGPT_WORKSPACE_USAGE_LIMIT_CODE])(
  "keeps %s actionable without scheduling a quota reset",
  (code) => {
    const message = '429: {"error":{"code":"' + code + '"}}';
    expect(chatGptUsageLimitCode(message)).toBe(code);
    expect(
      formatCodexUsageError(message, undefined, "2026-10-01T00:00:00Z", "usageLimitReached"),
    ).toBe(message);
    expect(
      detectCodexUsageLimit({
        message,
        errorInfo: "usageLimitReached",
        at: "2026-10-01T00:00:00Z",
      }),
    ).toBeNull();
    expect(chatGptUsageLimitCode(code + "_unrelated")).toBeNull();
  },
);

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

it("ignores stale workspace blocks while retaining fresh spend-block suppression", () => {
  const input = {
    message: "usage limit reached",
    errorInfo: "usageLimitReached",
    at: "2026-10-01T00:00:03Z",
    snapshotNotBefore: "2026-10-01T00:00:01Z",
    snapshots: [
      {
        observedAt: "2026-10-01T00:00:00Z",
        snapshot: { limitId: "workspace", rateLimitReachedType: "credits_depleted" },
      },
      {
        observedAt: "2026-10-01T00:00:02Z",
        snapshot: {
          limitId: "codex",
          primary: { usedPercent: 100, resetsAt: Date.parse("2026-10-02T00:00:00Z") / 1000 },
        },
      },
    ],
  };
  expect(detectCodexUsageLimit(input)?.resetsAt).toBe("2026-10-02T00:00:00.000Z");
  expect(detectCodexUsageLimit({ ...input, snapshotNotBefore: "2026-09-30T00:00:00Z" })).toBeNull();
});

describe("resolveCodexCompletionErrorInfo", () => {
  const message = "exceeded retry limit";
  const exhaustion = (httpStatusCode: number | null) => ({
    responseTooManyFailedAttempts: { httpStatusCode },
  });
  const previous = { message, errorInfo: exhaustion(429) };

  it("keeps the notification's evidence when the completion has no status", () => {
    expect(
      resolveCodexCompletionErrorInfo({ message, errorInfo: exhaustion(null), previous }),
    ).toBe(previous.errorInfo);
    expect(resolveCodexCompletionErrorInfo({ message, errorInfo: undefined, previous })).toBe(
      previous.errorInfo,
    );
    expect(resolveCodexCompletionErrorInfo({ message: undefined, errorInfo: null, previous })).toBe(
      previous.errorInfo,
    );
  });

  it("lets an explicit completion status or different failure win", () => {
    const explicit = exhaustion(503);
    expect(resolveCodexCompletionErrorInfo({ message, errorInfo: explicit, previous })).toBe(
      explicit,
    );
    const other = { httpConnectionFailed: {} };
    expect(resolveCodexCompletionErrorInfo({ message, errorInfo: other, previous })).toBe(other);
    expect(
      resolveCodexCompletionErrorInfo({ message: "other", errorInfo: exhaustion(null), previous }),
    ).toEqual(exhaustion(null));
    expect(
      resolveCodexCompletionErrorInfo({
        message,
        errorInfo: exhaustion(null),
        previous: undefined,
      }),
    ).toEqual(exhaustion(null));
  });
});

it("treats retry exhaustion on HTTP 429 as a usage limit, but not other statuses", () => {
  const exhausted = (httpStatusCode: number | null) => ({
    message: "exceeded retry limit, last status: 429 Too Many Requests",
    errorInfo: { responseTooManyFailedAttempts: { httpStatusCode } },
    at: "2026-10-01T00:00:03Z",
  });

  expect(detectCodexUsageLimit(exhausted(429))).toMatchObject({ evidence: "typed" });
  expect(detectCodexUsageLimit(exhausted(500))).toBeNull();
  expect(detectCodexUsageLimit(exhausted(null))).toBeNull();
  expect(
    detectCodexUsageLimit({ ...exhausted(429), errorInfo: { httpConnectionFailed: {} } }),
  ).toBeNull();
});
