import { describe, expect, it } from "vitest";

import type { Thread } from "../types";
import { bucketActivityAt, groupThreadsByActivity } from "./activityGrouping";

function makeThread(id: string, lastInteractionAt: string): Thread {
  // We only need a subset of fields to exercise the grouping logic; cast
  // through `unknown` so we don't have to synthesize an entire Thread object.
  return {
    id,
    lastInteractionAt,
  } as unknown as Thread;
}

/**
 * Construct an ISO timestamp from local-timezone components. Using `new Date`
 * with numeric args avoids the DST / UTC cliff that bites tests when they
 * assume "2026-04-22T23:00:00Z" is "yesterday" relative to noon UTC — in most
 * positive-UTC offsets it isn't.
 */
function localIso(
  year: number,
  month: number,
  day: number,
  hour = 12,
  minute = 0,
  second = 0,
): string {
  return new Date(year, month - 1, day, hour, minute, second).toISOString();
}

describe("bucketActivityAt", () => {
  // Use mid-afternoon local time so small timezone-induced shifts don't push
  // the reference "now" into a different calendar day.
  const now = new Date(2026, 3, 23, 14, 0, 0); // April is month index 3

  it("classifies timestamps earlier today as `today`", () => {
    expect(bucketActivityAt(localIso(2026, 4, 23, 6, 0), now)).toBe("today");
  });

  it("classifies yesterday correctly", () => {
    expect(bucketActivityAt(localIso(2026, 4, 22, 14, 0), now)).toBe("yesterday");
  });

  it("classifies 3 days ago as `this-week`", () => {
    expect(bucketActivityAt(localIso(2026, 4, 20, 14, 0), now)).toBe("this-week");
  });

  it("classifies 10 days ago as `earlier`", () => {
    expect(bucketActivityAt(localIso(2026, 4, 13, 14, 0), now)).toBe("earlier");
  });

  it("returns `earlier` for an invalid timestamp", () => {
    expect(bucketActivityAt("not-a-date", now)).toBe("earlier");
  });
});

describe("groupThreadsByActivity", () => {
  const now = new Date(2026, 3, 23, 14, 0, 0);

  it("groups threads and preserves input order within each bucket", () => {
    const threads = [
      makeThread("a", localIso(2026, 4, 23, 10, 0)), // today
      makeThread("b", localIso(2026, 4, 22, 10, 0)), // yesterday
      makeThread("c", localIso(2026, 4, 23, 8, 0)), // today
      makeThread("d", localIso(2026, 4, 10, 10, 0)), // earlier
    ];
    const groups = groupThreadsByActivity(threads, now);
    expect(groups.map((g) => g.bucket)).toEqual(["today", "yesterday", "earlier"]);
    expect(groups[0]!.threads.map((t) => t.id)).toEqual(["a", "c"]);
  });

  it("omits empty buckets", () => {
    const threads = [makeThread("a", localIso(2026, 4, 23, 10, 0))];
    const groups = groupThreadsByActivity(threads, now);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.bucket).toBe("today");
  });
});
