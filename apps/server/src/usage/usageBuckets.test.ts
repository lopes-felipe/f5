import { assert, describe, it } from "vitest";

import { planUsageBuckets, UsageTimeZoneError, type UsageBucketPlan } from "./usageBuckets.ts";

function assertContiguous(plan: UsageBucketPlan): void {
  assert.equal(plan.buckets[0]!.startAt, plan.startedAt);
  plan.buckets.forEach((bucket, index) => {
    assert.isTrue(bucket.startAt < bucket.endAt, `${bucket.key} is non-empty`);
    const next = plan.buckets[index + 1];
    assert.equal(bucket.endAt, next ? next.startAt : plan.endedAt);
  });
}

describe("planUsageBuckets", () => {
  it("uses local midnights for fractional-offset zones", () => {
    const now = new Date("2026-08-15T12:00:00.000Z");
    const kolkata = planUsageBuckets({ range: "7d", timeZone: "Asia/Kolkata", now });
    assert.equal(kolkata.buckets.length, 7);
    assert.equal(kolkata.startedAt, "2026-08-08T18:30:00.000Z");
    assert.equal(kolkata.buckets[6]!.key, "2026-08-15");
    assert.equal(kolkata.buckets[6]!.startAt, "2026-08-14T18:30:00.000Z");
    assert.equal(kolkata.nextBucketAt, "2026-08-15T18:30:00.000Z");
    assert.equal(kolkata.endedAt, "2026-08-15T12:00:00.001Z");
    assertContiguous(kolkata);

    const kathmandu = planUsageBuckets({ range: "30d", timeZone: "Asia/Kathmandu", now });
    assert.equal(kathmandu.buckets.length, 30);
    assert.equal(kathmandu.buckets[29]!.startAt, "2026-08-14T18:15:00.000Z");
    assertContiguous(kathmandu);
  });

  it("aligns 24h buckets to local hours in fractional-offset zones", () => {
    const now = new Date("2026-08-15T12:00:00.000Z");
    const kolkata = planUsageBuckets({ range: "24h", timeZone: "Asia/Kolkata", now });
    assert.equal(kolkata.buckets.length, 24);
    // 17:30 local; the current partial hour began at 17:00 local.
    assert.equal(kolkata.buckets[23]!.startAt, "2026-08-15T11:30:00.000Z");
    assert.equal(kolkata.buckets[23]!.label, "5 PM");
    assert.equal(kolkata.buckets[0]!.startAt, "2026-08-14T12:30:00.000Z");
    assert.equal(kolkata.nextBucketAt, "2026-08-15T12:30:00.000Z");
    assertContiguous(kolkata);

    const kathmandu = planUsageBuckets({ range: "24h", timeZone: "Asia/Kathmandu", now });
    assert.equal(kathmandu.buckets[23]!.startAt, "2026-08-15T11:15:00.000Z");
    assert.equal(kathmandu.buckets[23]!.label, "5 PM");
    assert.equal(kathmandu.nextBucketAt, "2026-08-15T12:15:00.000Z");
    assertContiguous(kathmandu);
  });

  it("keeps a repeated DST hour as two labeled intervals", () => {
    const plan = planUsageBuckets({
      range: "24h",
      timeZone: "America/New_York",
      now: new Date("2026-11-01T08:30:00.000Z"),
    });
    assert.equal(plan.buckets.length, 24);
    assertContiguous(plan);
    const first = plan.buckets.find((bucket) => bucket.startAt === "2026-11-01T05:00:00.000Z")!;
    const second = plan.buckets.find((bucket) => bucket.startAt === "2026-11-01T06:00:00.000Z")!;
    assert.equal(first.endAt, second.startAt);
    assert.match(first.label, /^1:00\sAM GMT-4$/);
    assert.match(second.label, /^1:00\sAM GMT-5$/);
    assert.equal(
      plan.buckets.find((bucket) => bucket.startAt === "2026-11-01T07:00:00.000Z")!.label,
      "2 AM",
    );
  });

  it("uses real boundaries for a half-hour DST transition", () => {
    const plan = planUsageBuckets({
      range: "24h",
      timeZone: "Australia/Lord_Howe",
      now: new Date("2026-10-03T20:00:00.000Z"),
    });
    assertContiguous(plan);
    const shortened = plan.buckets.find((bucket) => bucket.startAt === "2026-10-03T15:30:00.000Z")!;
    assert.equal(shortened.endAt, "2026-10-03T16:00:00.000Z");
    assert.match(shortened.label, /^2:30\sAM GMT\+11$/);
  });

  it("includes boundary instants in exactly one bucket", () => {
    const plan = planUsageBuckets({
      range: "7d",
      timeZone: "Europe/Berlin",
      now: new Date("2026-03-31T12:00:00.000Z"),
    });
    assertContiguous(plan);
    const boundary = "2026-03-29T22:00:00.000Z";
    const containing = plan.buckets.filter(
      (bucket) => bucket.startAt <= boundary && boundary < bucket.endAt,
    );
    assert.deepStrictEqual(
      containing.map((bucket) => bucket.key),
      ["2026-03-30"],
    );
  });

  it("rejects unknown zones", () => {
    assert.throws(
      () => planUsageBuckets({ range: "7d", timeZone: "Mars/Olympus", now: new Date() }),
      UsageTimeZoneError,
    );
  });
});
