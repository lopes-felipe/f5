import { expect, it } from "vitest";
import { parseReleaseIntent, resolveStableHistory } from "./release/release-intent.ts";
import { pendingStableRequests } from "./release/release-candidate.ts";
const a = "a".repeat(40),
  b = "b".repeat(40),
  c = "c".repeat(40),
  d = "d".repeat(40);
const id = (n: number) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const first = { version: "0.1.2", requestId: id(1) };
const second = { version: "0.1.3", requestId: id(2) };
const snapshot = (sourceSha: string, intent: unknown) => ({
  sourceSha,
  text: JSON.stringify(intent),
});
const withdrawal = (targets: string[], n = 3) => ({
  action: "withdraw",
  requestId: id(n),
  withdraws: targets,
  reason: "Explicitly abandon blocked request",
});
it("checks the combined merge result of two concurrent preparations", () => {
  const history = resolveStableHistory([snapshot(a, first), snapshot(b, second)]);
  expect(() => pendingStableRequests(history, new Map())).toThrow("Another stable");
  const repaired = resolveStableHistory([
    snapshot(a, first),
    snapshot(b, second),
    snapshot(c, withdrawal([second.requestId])),
  ]);
  expect(pendingStableRequests(repaired, new Map())).toEqual([{ ...first, sourceSha: a }]);
});
it("a reverted intent never repins its UUID to the revert commit", () => {
  const history = resolveStableHistory([
    snapshot(a, first),
    snapshot(b, { ...first, requestId: id(2), supersedes: id(1) }),
    snapshot(c, first),
  ]);
  expect(history[0]!.sourceSha).toBe(a);
  expect(history).toHaveLength(2);
  expect(pendingStableRequests(history, new Map())[0]!.sourceSha).toBe(b);
});
it.each([undefined, "{invalid json"])(
  "allows explicit repair of a deleted or malformed history entry",
  (text) => {
    const broken = [snapshot(a, first), { sourceSha: b, text }];
    expect(() => resolveStableHistory(broken)).toThrow("Invalid release intent");
    expect(resolveStableHistory([...broken, snapshot(c, withdrawal([b]))])).toEqual([
      { ...first, sourceSha: a },
    ]);
  },
);
it("withdraws a complete recovery lineage without reviving its original request", () => {
  const history = resolveStableHistory([
    snapshot(a, first),
    snapshot(b, { ...first, requestId: id(2), supersedes: id(1) }),
    snapshot(c, withdrawal([id(2)])),
  ]);
  expect(history).toEqual([]);
  expect(pendingStableRequests(history, new Map())).toEqual([]);
});
it("explicitly withdraws a wrong-version recovery and its blocked lineage", () => {
  const broken = [snapshot(a, first), snapshot(b, { ...second, supersedes: id(1) })];
  expect(() => pendingStableRequests(resolveStableHistory(broken), new Map())).toThrow(
    "same unpublished",
  );
  expect(resolveStableHistory([...broken, snapshot(c, withdrawal([id(2)]))])).toEqual([]);
});
it("does not silently accept an unknown withdrawal target, but can repair that edit", () => {
  const broken = [snapshot(a, first), snapshot(b, withdrawal([id(99)]))];
  expect(() => resolveStableHistory(broken)).toThrow("prior intent history");
  expect(resolveStableHistory([...broken, snapshot(c, withdrawal([b], 4))])).toEqual([
    { ...first, sourceSha: a },
  ]);
});
it("allows a fresh preparation after explicit withdrawal, preserving the new pin", () => {
  const history = resolveStableHistory([
    snapshot(a, first),
    snapshot(b, withdrawal([id(1)])),
    snapshot(c, { ...first, requestId: id(4) }),
    snapshot(d, first),
  ]);
  expect(pendingStableRequests(history, new Map())).toEqual([
    { ...first, requestId: id(4), sourceSha: c },
  ]);
});
it("rejects a reused UUID with changed content until explicitly withdrawn", () => {
  expect(() =>
    resolveStableHistory([snapshot(a, first), snapshot(b, { ...first, version: "0.1.9" })]),
  ).toThrow("reused");
  expect(() => parseReleaseIntent(withdrawal([]))).toThrow("Withdrawal");
});
