import { expect, it } from "vitest";
import { readCachedStartupSnapshot } from "./startupSnapshotCache";

it("uses a validated startup basis only for the same server and within twelve hours", () => {
  const snapshot = {
    snapshotSequence: 12,
    updatedAt: "2026-11-22T17:00:00.000Z",
    projects: [],
    threads: [],
    planningWorkflows: [],
    codeReviewWorkflows: [],
    investigationWorkflows: [],
  };
  const origin = "https://f5.example";
  const now = 12 * 60 * 60 * 1000;
  const entry = { origin, savedAt: 1, backendIncarnation: "backend", snapshot };
  expect(readCachedStartupSnapshot(entry, "backend", origin, now)).toEqual(snapshot);
  expect(readCachedStartupSnapshot(entry, "backend", origin, now + 1)).toBeUndefined();
  expect(readCachedStartupSnapshot(entry, "replacement", origin, now)).toBeUndefined();
  expect(readCachedStartupSnapshot(entry, "backend", "https://other.example", now)).toBeUndefined();
  expect(
    readCachedStartupSnapshot(
      {
        ...entry,
        snapshot: { ...snapshot, snapshotSequence: -1 },
      },
      "backend",
      origin,
      now,
    ),
  ).toBeUndefined();
});
