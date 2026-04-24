import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  MAX_PINNED_THREADS,
  __resetPinnedThreadsForTests,
  canPinMore,
  getPinnedThreadIds,
  isPinned,
  pinThread,
  togglePinned,
  unpinThread,
} from "./pinnedThreadsStore";

function id(value: string): ThreadId {
  return ThreadId.makeUnsafe(value);
}

describe("pinnedThreadsStore", () => {
  beforeEach(() => {
    __resetPinnedThreadsForTests();
  });

  it("starts empty", () => {
    expect(getPinnedThreadIds()).toEqual([]);
  });

  it("pins a thread", () => {
    pinThread(id("t1"));
    expect(isPinned(id("t1"))).toBe(true);
    expect(getPinnedThreadIds()).toEqual([id("t1")]);
  });

  it("prepends new pins so the freshest is first", () => {
    pinThread(id("t1"));
    pinThread(id("t2"));
    pinThread(id("t3"));
    expect(getPinnedThreadIds()).toEqual([id("t3"), id("t2"), id("t1")]);
  });

  it("pinning the same thread twice is a no-op", () => {
    pinThread(id("t1"));
    pinThread(id("t1"));
    expect(getPinnedThreadIds()).toEqual([id("t1")]);
  });

  it("unpins a thread", () => {
    pinThread(id("t1"));
    pinThread(id("t2"));
    unpinThread(id("t1"));
    expect(getPinnedThreadIds()).toEqual([id("t2")]);
    expect(isPinned(id("t1"))).toBe(false);
  });

  it("toggles pin state", () => {
    togglePinned(id("t1"));
    expect(isPinned(id("t1"))).toBe(true);
    togglePinned(id("t1"));
    expect(isPinned(id("t1"))).toBe(false);
  });

  it("enforces MAX_PINNED_THREADS", () => {
    for (let i = 0; i < MAX_PINNED_THREADS + 2; i += 1) {
      pinThread(id(`t${i}`));
    }
    const pinned = getPinnedThreadIds();
    expect(pinned.length).toBe(MAX_PINNED_THREADS);
    // The most recent pin should still be at the head.
    expect(pinned[0]).toBe(id(`t${MAX_PINNED_THREADS + 1}`));
  });

  it("canPinMore reflects the capacity limit", () => {
    const pins: ThreadId[] = [];
    for (let i = 0; i < MAX_PINNED_THREADS; i += 1) pins.push(id(`t${i}`));
    expect(canPinMore(pins)).toBe(false);
    expect(canPinMore(pins.slice(0, -1))).toBe(true);
  });
});
