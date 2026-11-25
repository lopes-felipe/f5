import { describe, expect, it } from "vitest";

import {
  clampBytes,
  isEventsLogRotation,
  pathContainsOrEquals,
  pathsOverlap,
  providerLogSegmentFromName,
  sumNonOverlappingPathUsages,
} from "./retentionPolicy.ts";

describe("retentionPolicy", () => {
  it("normalizes path containment, overlap checks, and non-overlapping byte totals", () => {
    expect(clampBytes(-50)).toBe(0);
    expect(clampBytes(128.7)).toBe(128);
    expect(pathContainsOrEquals("/var/f5", "/var/f5/worktrees/a")).toBe(true);
    expect(pathContainsOrEquals("/var/f5", "/var/f5-other")).toBe(false);
    expect(pathsOverlap("/var/f5/a", "/var/f5/a/b")).toBe(true);
    expect(pathsOverlap("/var/f5/a", "/var/f5/b")).toBe(false);

    expect(
      sumNonOverlappingPathUsages([
        { path: "/var/f5/root", bytes: 1000 },
        { path: "/var/f5/root/sub", bytes: 400 },
        { path: "/var/f5/other", bytes: 250 },
      ]),
    ).toBe(1250);
  });

  it("identifies provider log segments and rotated event log files", () => {
    expect(providerLogSegmentFromName("codex-session.log")).toBe("codex-session");
    expect(providerLogSegmentFromName("codex-session.log.2")).toBe("codex-session");
    expect(providerLogSegmentFromName("events.log")).toBeNull();
    expect(providerLogSegmentFromName("readme.txt")).toBeNull();
    expect(
      isEventsLogRotation({
        path: "/logs/events.log.1",
        name: "events.log.1",
        bytes: 100,
        mtimeMs: 0,
      }),
    ).toBe(true);
    expect(
      isEventsLogRotation({
        path: "/logs/events.log",
        name: "events.log",
        bytes: 100,
        mtimeMs: 0,
      }),
    ).toBe(false);
  });
});
