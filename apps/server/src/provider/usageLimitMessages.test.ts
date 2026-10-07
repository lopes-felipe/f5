import type { UsageAccount } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  claudeLimitState,
  usageLimitMessage,
  usageLimitFromWindows,
  resolveAccountUsageLimit,
} from "./usageLimitMessages.ts";
import {
  formatCodexUsageError,
  mergeCodexLimitSnapshot,
  detectCodexUsageLimit,
  parseCodexTryAgainAt,
} from "./codexErrors.ts";

describe("provider usage-limit messages", () => {
  const reset = Date.parse("2026-09-29T12:00:00Z") / 1000;
  it("names Claude's rejected window and reset", () => {
    const state = claudeLimitState({
      status: "rejected",
      rateLimitType: "five_hour",
      resetsAt: reset,
    });
    expect(state.blocked).toBe(true);
    expect(state.message).toContain("5-hour");
    expect(state.message).toContain("2026-09-29T12:00:00.000Z");
  });
  it.each(["allowed", "allowed_warning"])("does not block %s overage", (overageStatus) => {
    expect(claudeLimitState({ status: "rejected", overageStatus }).blocked).toBe(false);
  });
  it("clears a rejection when the same window becomes allowed", () => {
    expect(claudeLimitState({ status: "allowed", rateLimitType: "five_hour" })).toMatchObject({
      blocked: false,
      window: "five_hour",
    });
  });
  it.each([null, NaN, Infinity, -1, 1e30])("omits an invalid reset (%s)", (reset) => {
    expect(usageLimitMessage("Claude", undefined, reset)).not.toContain("Resets at");
  });
  it("keeps the main Codex allowance when Spark emits a separate update", () => {
    const original = { primary: { usedPercent: 100, resetsAt: reset, windowDurationMins: 300 } };
    expect(
      mergeCodexLimitSnapshot(undefined, { limitId: "codex_other", primary: { usedPercent: 1 } }),
    ).toMatchObject({ limitId: "codex_other", primary: { usedPercent: 1 } });
    const merged = mergeCodexLimitSnapshot(original, {
      secondary: { usedPercent: 0 },
    });
    expect(merged?.primary).toEqual(original.primary);
    expect(
      formatCodexUsageError("out of credits", merged, "2026-09-28T00:00:00Z", "usageLimitReached"),
    ).toContain("5-hour usage limit");
  });
  it("names the longer blocking Codex window and leaves unrelated errors intact", () => {
    expect(
      formatCodexUsageError(
        "usage limit reached",
        {
          primary: { usedPercent: 100, resetsAt: reset, windowDurationMins: 300 },
          secondary: { usedPercent: 100, resetsAt: reset + 86400, windowDurationMins: 10080 },
        },
        "2026-09-28T00:00:00Z",
        "usageLimitReached",
      ),
    ).toContain("weekly");
    expect(formatCodexUsageError("connection reset", undefined, "2026-09-28T00:00:00Z")).toBe(
      "connection reset",
    );
  });
  it("recognizes typed Codex usage failures without matching English text", () => {
    expect(
      formatCodexUsageError(
        "Account unavailable",
        undefined,
        "2026-09-28T00:00:00Z",
        "usageLimitReached",
      ),
    ).toContain("Codex usage limit reached");
  });
});

it.each(["rate limit reached for tokens per minute (TPM)", "usage limit warning; retrying"])(
  "preserves an untyped Codex diagnostic: %s",
  (message) => {
    expect(formatCodexUsageError(message, undefined, "2026-09-28T00:00:00Z")).toBe(message);
  },
);
it("retains the original diagnostic when adding a typed usage hint", () => {
  expect(
    formatCodexUsageError(
      "Detailed provider message",
      undefined,
      "2026-09-28T00:00:00Z",
      "usageLimitReached",
    ),
  ).toMatch(/^Detailed provider message /);
});

it.each([
  [450, "450-minute"],
  [4320, "3-day"],
  [10080, "weekly"],
  [300, "5-hour"],
])("keeps the exact duration for a %s minute window", (minutes, label) => {
  expect(
    formatCodexUsageError(
      "Limit",
      { primary: { usedPercent: 100, resetsAt: 1790683200, windowDurationMins: Number(minutes) } },
      "2026-09-28T00:00:00Z",
      "usageLimitReached",
    ),
  ).toContain(label);
});
it.each([NaN, Infinity, 0, -1])("omits invalid window duration %s", (minutes) => {
  const message = formatCodexUsageError(
    "Limit",
    { primary: { usedPercent: 100, resetsAt: 1790683200, windowDurationMins: minutes } },
    "2026-09-28T00:00:00Z",
    "usageLimitReached",
  );
  expect(message).toContain("Codex usage limit");
  expect(message).not.toMatch(/NaN|Infinity|minute|hour/);
});

it.each(["disk is full", "connection reset", "TPM exceeded; retrying"])(
  "does not mislabel %s with stale limit state",
  (message) => {
    expect(
      formatCodexUsageError(
        message,
        { primary: { usedPercent: 100, resetsAt: 1790683200, windowDurationMins: 300 } },
        "2026-09-28T00:00:00Z",
      ),
    ).toBe(message);
  },
);

it("combines all windows conservatively", () => {
  const first = { id: "five_hour", label: "5-hour", resetsAt: "2026-10-02T01:00:00Z" };
  expect(
    usageLimitFromWindows([first, { ...first, id: "seven_day", resetsAt: "2026-10-04T01:00:00Z" }])
      .resetsAt,
  ).toBe("2026-10-04T01:00:00Z");
  expect(
    usageLimitFromWindows([first, { ...first, id: "unknown", resetsAt: null }]).resetsAt,
  ).toBeNull();
  expect(claudeLimitState({ rateLimitType: "overage", status: "rejected" }).resettable).toBe(false);
});
it.each(["usageLimitReached", { usageLimitReached: {} }, { usageLimitExceeded: {} }])(
  "detects typed Codex failure %j",
  (errorInfo) => {
    expect(
      detectCodexUsageLimit({ message: "blocked", errorInfo, at: "2026-10-01T00:00:00Z" }),
    ).toMatchObject({ evidence: "typed", resetsAt: null });
  },
);
it.each([
  "HTTP 429",
  "rate_limit_error",
  "TPM exceeded",
  "usage limit warning; retrying",
  "authentication usage limit reached",
])("excludes %s", (message) => {
  expect(detectCodexUsageLimit({ message, at: "2026-10-01T00:00:00Z" })).toBeNull();
});
it("excludes workspace spend and credit blocks", () => {
  for (const rateLimitReachedType of ["credits_depleted", "usage_limit_reached"]) {
    expect(
      detectCodexUsageLimit({
        message: "usage limit reached",
        errorInfo: "usageLimitReached",
        snapshots: [{ rateLimitReachedType }],
        at: "2026-10-01T00:00:00Z",
      }),
    ).toBeNull();
  }
});
it("rejects past and distant textual reset dates", () => {
  expect(
    parseCodexTryAgainAt("try again at Oct 5th, 2026 10:23 AM", "2026-10-01T00:00:00Z"),
  ).not.toBeNull();
  expect(
    parseCodexTryAgainAt("try again at Sep 5th, 2026 10:23 AM", "2026-10-01T00:00:00Z"),
  ).toBeNull();
  expect(
    parseCodexTryAgainAt("try again at Nov 5th, 2026 10:23 AM", "2026-10-01T00:00:00Z"),
  ).toBeNull();
});
it("merges partial window fields", () => {
  expect(
    mergeCodexLimitSnapshot(
      { primary: { usedPercent: 100, resetsAt: 42, windowDurationMins: 300 } },
      { primary: { usedPercent: 99 } },
    )?.primary,
  ).toEqual({ usedPercent: 99, resetsAt: 42, windowDurationMins: 300 });
});

it.each([
  [
    "America/Los_Angeles",
    "Oct 5th, 2026 10:23 AM",
    "2026-10-01T00:00:00Z",
    "2026-10-05T17:23:00.000Z",
  ],
  ["Europe/Helsinki", "Oct 5th, 2026 10:23 AM", "2026-10-01T00:00:00Z", "2026-10-05T07:23:00.000Z"],
  [
    "America/Los_Angeles",
    "Nov 1st, 2026 1:30 AM",
    "2026-10-31T00:00:00Z",
    "2026-11-01T08:30:00.000Z",
  ],
  ["Europe/Helsinki", "Oct 25th, 2026 3:30 AM", "2026-10-24T00:00:00Z", "2026-10-25T00:30:00.000Z"],
])("parses Codex local dates in %s including DST boundaries", (zone, date, at, expected) => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = zone;
    expect(parseCodexTryAgainAt(`try again at ${date}.`, at)).toBe(expected);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

it("requires a successful fresh account section before resolving unknown resets", () => {
  const limit = usageLimitFromWindows([{ id: "five_hour", label: "5-hour", resetsAt: null }]);
  const account: UsageAccount = {
    key: "claude:test",
    provider: "claudeAgent",
    providerInstanceId: null,
    displayName: "Claude",
    enabled: true,
    refreshState: "idle",
    sections: [
      {
        kind: "claude-usage",
        outcome: "available",
        lastAttemptAt: "2026-10-01T00:00:01Z",
        errorCode: null,
        snapshot: {
          fetchedAt: "2026-10-01T00:00:01Z",
          data: {
            subscriptionLabel: "Max",
            limitsAvailable: true,
            extraUsage: null,
            windows: [
              {
                key: "five_hour",
                label: "5-hour",
                utilization: 100,
                resetsAt: "2026-10-01T03:00:00Z",
              },
              {
                key: "seven_day",
                label: "Weekly",
                utilization: 100,
                resetsAt: "2026-10-05T03:00:00Z",
              },
            ],
          },
        },
      },
    ],
  };
  expect(resolveAccountUsageLimit(limit, account, "2026-10-01T00:00:00Z").resetsAt).toBe(
    "2026-10-05T03:00:00Z",
  );
  expect(resolveAccountUsageLimit(limit, account, "2026-10-01T00:00:02Z").resetsAt).toBeNull();
  const unavailable: UsageAccount = {
    ...account,
    sections: account.sections.map((section) => ({ ...section, outcome: "unavailable" })),
  };
  expect(resolveAccountUsageLimit(limit, unavailable, "2026-10-01T00:00:00Z").resetsAt).toBeNull();
});
