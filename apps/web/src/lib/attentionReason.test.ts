import { describe, expect, it } from "vitest";

import { resolveAttentionReasonTag } from "./attentionReason";

const NOW = new Date("2026-04-23T12:00:00Z");

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

function daysAgo(days: number): string {
  return hoursAgo(days * 24);
}

describe("resolveAttentionReasonTag", () => {
  it("returns 'awaiting approval' for fresh pending-approval", () => {
    expect(resolveAttentionReasonTag("pending-approval", hoursAgo(3), NOW)).toBe(
      "awaiting approval",
    );
  });

  it("returns a 'waiting Xd' tag for stale pending-approval", () => {
    expect(resolveAttentionReasonTag("pending-approval", daysAgo(3), NOW)).toBe("waiting 3d");
  });

  it("returns 'needs reply' for fresh awaiting-input", () => {
    expect(resolveAttentionReasonTag("awaiting-input", hoursAgo(1), NOW)).toBe("needs reply");
  });

  it("returns 'waiting Xd' for stale awaiting-input", () => {
    expect(resolveAttentionReasonTag("awaiting-input", daysAgo(2), NOW)).toBe("waiting 2d");
  });

  it("returns null for fresh plan-ready (no noise when the plan is new)", () => {
    expect(resolveAttentionReasonTag("plan-ready", hoursAgo(3), NOW)).toBeNull();
  });

  it("returns 'stale 1d' for plan-ready older than a day", () => {
    expect(resolveAttentionReasonTag("plan-ready", daysAgo(1), NOW)).toBe("stale 1d");
  });

  it("returns 'stale Xd' for plan-ready much older", () => {
    expect(resolveAttentionReasonTag("plan-ready", daysAgo(5), NOW)).toBe("stale 5d");
  });

  it("returns null for non-attention statuses", () => {
    expect(resolveAttentionReasonTag("working", hoursAgo(3), NOW)).toBeNull();
    expect(resolveAttentionReasonTag("completed", hoursAgo(3), NOW)).toBeNull();
    expect(resolveAttentionReasonTag("none", hoursAgo(3), NOW)).toBeNull();
  });

  it("returns null for malformed timestamps", () => {
    expect(resolveAttentionReasonTag("plan-ready", "not-a-date", NOW)).toBeNull();
  });
});
