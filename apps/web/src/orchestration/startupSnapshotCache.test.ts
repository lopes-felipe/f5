import { expect, it, vi } from "vitest";
import {
  readCachedStartupSnapshot,
  requestStartupSnapshot,
  startupReplayEvents,
  startupSnapshotCache,
} from "./startupSnapshotCache";

const snapshot = {
  snapshotSequence: 12,
  updatedAt: "2026-11-22T17:00:00.000Z",
  projects: [],
  threads: [],
  planningWorkflows: [],
  codeReviewWorkflows: [],
  investigationWorkflows: [],
};

it("uses a validated startup basis only for the same server and within twelve hours", () => {
  const origin = "https://f5.example";
  const now = 12 * 60 * 60 * 1000;
  const entry = {
    origin,
    savedAt: 1,
    backendIncarnation: "backend",
    snapshot,
    snapshotSequence: 12,
  };
  const cached = readCachedStartupSnapshot(entry, "backend", origin, now);
  expect(cached?.sequence).toBe(12);
  expect(cached?.decode()).toEqual(snapshot);
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
    )?.decode(),
  ).toBeUndefined();
});

it("checks the saved cursor before decoding a shell with an oversized gap", () => {
  const origin = "https://f5.example";
  const readSnapshot = vi.fn(() => snapshot);
  const entry = readCachedStartupSnapshot(
    {
      origin,
      savedAt: 1,
      backendIncarnation: "backend",
      snapshotSequence: 12,
      get snapshot() {
        return readSnapshot();
      },
    },
    "backend",
    origin,
    2,
  )!;
  const gap = {
    backendIncarnation: "backend",
    latestSequence: 200,
    snapshotRequired: true as const,
  };
  expect(startupReplayEvents(gap, "backend", entry.sequence)).toBeUndefined();
  expect(readSnapshot).not.toHaveBeenCalled();
  const current = { backendIncarnation: "backend", latestSequence: 12, events: [] };
  expect(startupReplayEvents(current, "backend", entry.sequence)).toEqual([]);
  expect(entry.decode()).toEqual(snapshot);
});

it("uses an HTTP snapshot when available and falls back when HTTP fails", async () => {
  const httpResult = { snapshot, threadTailDetails: null };
  const webSocketResult = {
    snapshot: { ...snapshot, snapshotSequence: 13 },
    threadTailDetails: null,
  };
  const webSocket = vi.fn(async () => webSocketResult);
  expect(await requestStartupSnapshot(webSocket, async () => httpResult)).toEqual(httpResult);
  expect(webSocket).not.toHaveBeenCalled();
  expect(
    await requestStartupSnapshot(webSocket, async () => {
      throw new Error("offline");
    }),
  ).toEqual(webSocketResult);
  expect(webSocket).toHaveBeenCalledOnce();
});

it("times out if the browser never opens its startup database", async () => {
  vi.stubGlobal("window", { location: { protocol: "https:", host: "f5.example" } });
  vi.stubGlobal("indexedDB", { open: () => ({}) });
  try {
    await expect(
      startupSnapshotCache.read({
        backendIncarnation: "backend",
        profileId: undefined,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  } finally {
    vi.unstubAllGlobals();
  }
});
