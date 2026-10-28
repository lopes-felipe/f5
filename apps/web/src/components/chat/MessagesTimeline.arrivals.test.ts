import { describe, expect, it } from "vitest";
import {
  ROW_ARRIVAL_DURATION_MS,
  advanceRowArrivals,
  classifyTimelineTailChange,
  type RowArrivalState,
  type TimelineTailSnapshot,
} from "./MessagesTimeline.logic";

const step = (
  previous: RowArrivalState | null,
  rowIds: string[],
  options: Partial<{ threadId: string; isWorking: boolean; nonce: number; now: number }> = {},
) =>
  advanceRowArrivals(previous, {
    threadId: options.threadId ?? "thread-a",
    rowIds,
    isWorking: options.isWorking ?? false,
    followNextTailNonce: options.nonce ?? 0,
    now: options.now ?? 1_000,
  });

describe("advanceRowArrivals", () => {
  it("returns the previous state for the same id list until an entry expires", () => {
    const baseline = step(null, ["a"], { isWorking: true });
    const rowIds = ["a", "b"];
    const entered = step(baseline, rowIds, { isWorking: true, now: 1_000 });
    expect(entered.entering.has("b")).toBe(true);
    expect(step(entered, rowIds, { isWorking: true, now: 1_100 })).toBe(entered);
    const expired = step(entered, rowIds, {
      isWorking: true,
      now: 1_000 + ROW_ARRIVAL_DURATION_MS + 1,
    });
    expect(expired.entering.size).toBe(0);
  });

  it("treats the first rows as a baseline that never enters", () => {
    const state = step(null, ["a", "b"], { isWorking: true });
    expect([...state.entering.keys()]).toEqual([]);
  });

  it("enters the first send of an empty thread after a follow request", () => {
    const empty = step(null, []);
    const sent = step(empty, ["user-1"], { nonce: 1 });
    expect([...sent.entering.keys()]).toEqual(["user-1"]);
  });

  it("never enters prepended history", () => {
    const baseline = step(null, ["c", "d"]);
    const prepended = step(baseline, ["a", "b", "c", "d"], { isWorking: true });
    expect([...prepended.entering.keys()]).toEqual([]);
  });

  it("keeps an idle second batch still", () => {
    const baseline = step(null, ["a"]);
    const loaded = step(baseline, ["a", "b", "c"]);
    expect([...loaded.entering.keys()]).toEqual([]);
  });

  it("enters a row appended while working, then expires it", () => {
    const baseline = step(null, ["a"]);
    const appended = step(baseline, ["a", "b"], { isWorking: true, now: 1_000 });
    expect(appended.entering.get("b")).toBe(1_000 + ROW_ARRIVAL_DURATION_MS);
    const same = step(appended, ["a", "b"], { isWorking: true, now: 1_100 });
    expect(same).toBe(appended);
    const expired = step(appended, ["a", "b"], {
      isWorking: true,
      now: 1_000 + ROW_ARRIVAL_DURATION_MS,
    });
    expect([...expired.entering.keys()]).toEqual([]);
  });

  it("resets on a thread switch", () => {
    const baseline = step(null, ["a"]);
    const appended = step(baseline, ["a", "b"], { isWorking: true });
    const switched = step(appended, ["x", "y"], { threadId: "thread-b", isWorking: true });
    expect(switched.threadId).toBe("thread-b");
    expect([...switched.entering.keys()]).toEqual([]);
  });
});

describe("classifyTimelineTailChange", () => {
  const epoch = {};
  const snapshot = (overrides: Partial<TimelineTailSnapshot>): TimelineTailSnapshot => ({
    rowId: "row",
    textEpoch: null,
    textRevision: null,
    text: "Hello",
    ...overrides,
  });

  it("reports a new tail row", () => {
    expect(classifyTimelineTailChange(snapshot({}), snapshot({ rowId: "next" }))).toBe(
      "new-messages",
    );
  });

  it("reports text growth in the same message by revision or by text", () => {
    expect(
      classifyTimelineTailChange(
        snapshot({ textEpoch: epoch, textRevision: 1 }),
        snapshot({ textEpoch: epoch, textRevision: 2 }),
      ),
    ).toBe("response-updated");
    expect(classifyTimelineTailChange(snapshot({}), snapshot({ text: "Hello there" }))).toBe(
      "response-updated",
    );
  });

  it("ignores an unchanged tail, such as an elapsed-time tick", () => {
    expect(
      classifyTimelineTailChange(
        snapshot({ textEpoch: epoch, textRevision: 3 }),
        snapshot({ textEpoch: epoch, textRevision: 3 }),
      ),
    ).toBeNull();
    expect(classifyTimelineTailChange(snapshot({}), snapshot({}))).toBeNull();
  });
});
