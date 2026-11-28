import {
  CommandId,
  EventId,
  PullRequestKey,
  ThreadId,
  type OrchestrationEvent,
  type PrHubChanged,
} from "@t3tools/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  createPrHubChangeSequence,
  EMPTY_PR_HUB_CHANGE_BATCH,
  invalidatePrHubThreadLinks,
  isPrHubQueryStale,
  mergePrHubChange,
} from "./prHubInvalidation";

const key = (number: number) => PullRequestKey.makeUnsafe(`github:github.com/octo/repo#${number}`);

const event = (overrides: Partial<PrHubChanged> = {}): PrHubChanged => ({
  accountGeneration: "account",
  revision: "1",
  changedKeys: [],
  removedKeys: [],
  counts: {} as PrHubChanged["counts"],
  resyncRequired: false,
  ...overrides,
});

const batchOf = (...events: PrHubChanged[]) =>
  events.reduce(mergePrHubChange, EMPTY_PR_HUB_CHANGE_BATCH);

it("refreshes cached link-bearing queries when a thread unlinks a PR", () => {
  const queryClient = new QueryClient();
  const list = ["prHub", "list", "account"];
  const linkedThreads = ["prHub", "threadsForPr", "account", key(1)];
  const unrelated = ["prHub", "threadsForPr", "account", key(2)];
  const checks = ["prHub", "checks", "account", key(1)];
  for (const queryKey of [list, linkedThreads, unrelated, checks])
    queryClient.setQueryData(queryKey, {});
  const threadId = ThreadId.makeUnsafe("linked");
  const now = "2026-04-01T09:00:00.000Z";
  const metadata: OrchestrationEvent = {
    type: "thread.meta-updated",
    sequence: 1,
    eventId: EventId.makeUnsafe("event"),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: now,
    commandId: CommandId.makeUnsafe("command"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: { threadId, updatedAt: now },
  };
  invalidatePrHubThreadLinks(queryClient, [
    { ...metadata, payload: { ...metadata.payload, title: "Unlinked thread" } },
    { ...metadata, type: "thread.deleted", payload: { threadId, deletedAt: now } },
  ]);
  expect(queryClient.getQueryState(list)?.isInvalidated).toBe(false);
  invalidatePrHubThreadLinks(queryClient, [
    {
      ...metadata,
      payload: {
        ...metadata.payload,
        pullRequestUnlinked: {
          provider: "github",
          host: "github.com",
          repository: "octo/repo",
          number: 1,
        },
      },
    },
  ]);
  expect(queryClient.getQueryState(list)?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(linkedThreads)?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(unrelated)?.isInvalidated).toBe(false);
  expect(queryClient.getQueryState(checks)?.isInvalidated).toBe(false);
});

describe("PR Hub change batches", () => {
  it("collects changed and removed keys across a burst", () => {
    const batch = batchOf(
      event({ changedKeys: [key(1)] }),
      event({ changedKeys: [key(1), key(2)], removedKeys: [key(3)] }),
    );
    expect([...batch.keys].toSorted()).toEqual([key(1), key(2), key(3)]);
    expect(batch.resync).toBe(false);
  });

  it("remembers a resync for the whole burst", () => {
    expect(batchOf(event({ resyncRequired: true }), event({ changedKeys: [key(1)] })).resync).toBe(
      true,
    );
  });
});

describe("PR Hub change sequence", () => {
  it("asks for a resync when an event between two others never arrived", () => {
    const sequence = createPrHubChangeSequence();
    const seen = [1, 2, 4, 5].map((number) =>
      sequence.track(event({ sequence: number, changedKeys: [key(number)] })),
    );
    expect(seen.map((item) => item.resyncRequired)).toEqual([false, false, true, false]);
    // The lost event's keys are unknown, so the batch re-reads everything.
    expect(batchOf(...seen).resync).toBe(true);
  });

  it("starts over after a reconnect and leaves unnumbered events alone", () => {
    const sequence = createPrHubChangeSequence();
    expect(sequence.track(event({ sequence: 40 })).resyncRequired).toBe(false);
    sequence.reset();
    // A restarted server counts from one again.
    expect(sequence.track(event({ sequence: 1 })).resyncRequired).toBe(false);
    expect(sequence.track(event()).resyncRequired).toBe(false);
    expect(sequence.track(event({ sequence: 2 })).resyncRequired).toBe(false);
    // Without the reset, a restart reads as a gap, which errs towards re-reading.
    expect(sequence.track(event({ sequence: 1 })).resyncRequired).toBe(true);
  });
});

describe("PR Hub query staleness", () => {
  const changed = batchOf(event({ changedKeys: [key(1)], removedKeys: [key(2)] }));
  const quiet = batchOf(event());

  it("always re-reads the collection", () => {
    for (const batch of [quiet, changed]) {
      expect(isPrHubQueryStale(["prHub", "overview", "account", null], batch)).toBe(true);
      expect(isPrHubQueryStale(["prHub", "list", "account", { filter: "all" }], batch)).toBe(true);
    }
  });

  it("re-reads one pull request's data only when that pull request changed", () => {
    for (const kind of ["detail", "timeline", "files", "reviewThreads"]) {
      expect(isPrHubQueryStale(["prHub", kind, "account", key(1)], changed)).toBe(true);
      expect(isPrHubQueryStale(["prHub", kind, "account", key(2)], changed)).toBe(true);
      expect(isPrHubQueryStale(["prHub", kind, "account", key(9)], changed)).toBe(false);
      expect(isPrHubQueryStale(["prHub", kind, "account", key(1)], quiet)).toBe(false);
    }
    // Keys can sit deeper in the query key, or inside a list of keys.
    expect(isPrHubQueryStale(["prHub", "files", "account", key(1), "head", 2], changed)).toBe(true);
    expect(isPrHubQueryStale(["prHub", "advisories", "account", [key(9), key(1)]], changed)).toBe(
      true,
    );
    expect(isPrHubQueryStale(["prHub", "advisories", "account", [key(9)]], changed)).toBe(false);
  });

  it("re-reads reads keyed by URL whenever any pull request changed", () => {
    const url = "https://github.com/octo/repo/pull/9";
    expect(isPrHubQueryStale(["prHub", "peek", "account", url], changed)).toBe(true);
    expect(isPrHubQueryStale(["prHub", "linkedPanel", "account", url], changed)).toBe(true);
    expect(isPrHubQueryStale(["prHub", "peek", "account", url], quiet)).toBe(false);
  });

  it("re-reads a stack when another pull request changed, since a stack spans several", () => {
    expect(isPrHubQueryStale(["prHub", "stack", "account", key(9)], changed)).toBe(true);
    expect(isPrHubQueryStale(["prHub", "stack", "account", key(9)], quiet)).toBe(false);
  });

  it("re-reads everything on a resync and never touches other queries", () => {
    const resync = batchOf(event({ resyncRequired: true }));
    expect(isPrHubQueryStale(["prHub", "detail", "account", key(9)], resync)).toBe(true);
    expect(isPrHubQueryStale(["server", "config"], resync)).toBe(false);
    expect(isPrHubQueryStale(["git", "status", key(1)], changed)).toBe(false);
  });
});
