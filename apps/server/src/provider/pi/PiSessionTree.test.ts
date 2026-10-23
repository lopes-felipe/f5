import { expect, it } from "vitest";
import {
  capturePiTurnTreeBoundary,
  parsePiSessionTree,
  piActiveBranch,
  piRollbackEntry,
} from "./PiSessionTree.ts";

const entry = (id: string, parentId: string | null, role = "user") => ({
  id,
  parentId,
  type: "message",
  message: { role },
});
const data = {
  leafId: "a2",
  entries: [
    entry("discarded", "u1"),
    entry("a2", "u2", "assistant"),
    entry("u1", null),
    entry("u2", "a1"),
    entry("a1", "u1", "assistant"),
  ],
};
it("walks active ancestry instead of append order or abandoned branches", () => {
  const tree = parsePiSessionTree(data)!;
  expect(piActiveBranch(tree)?.map((entry) => entry.id)).toEqual(["u1", "a1", "u2", "a2"]);
  expect(capturePiTurnTreeBoundary(tree, "a1")).toEqual({ turnStartEntryId: "u2", leafId: "a2" });
  expect(piRollbackEntry(tree, ["u2"])).toBe("u2");
  expect(piRollbackEntry(tree, ["discarded"])).toBeNull();
  expect(piRollbackEntry(tree, ["u2", "u1"])).toBeNull();
});
it("proves surviving user entries only for an in-session rewind", () => {
  const tree = parsePiSessionTree({ ...data, leafId: "a1" })!;
  expect(capturePiTurnTreeBoundary(tree, "a2")).toEqual({
    turnStartEntryId: null,
    leafId: "a1",
    retainedUserEntryIds: ["u1"],
  });
  expect(capturePiTurnTreeBoundary(tree, "other-session-leaf")).toBeNull();
});
it.each([
  { leafId: "missing", entries: [entry("u1", null)] },
  { leafId: "u1", entries: [entry("u1", "missing")] },
  { leafId: "u1", entries: [entry("u1", "u2"), entry("u2", "u1")] },
])("rejects missing or cyclic ancestry without inventing a rollback boundary", (data) => {
  const tree = parsePiSessionTree(data)!;
  expect(piActiveBranch(tree)).toBeNull();
  expect(capturePiTurnTreeBoundary(tree, null)).toBeNull();
  expect(piRollbackEntry(tree, ["u1"])).toBeNull();
});
it.each([
  { leafId: null, entries: [entry("duplicate", null), entry("duplicate", null)] },
  { leafId: 12, entries: [] },
  { leafId: " ", entries: [] },
  { leafId: null, entries: [entry(" padded", null)] },
  { leafId: null, entries: [entry("x".repeat(1025), null)] },
  { leafId: null, entries: [entry("valid", "\0")] },
  { leafId: null, entries: [{ id: "missing-parent" }] },
])("rejects ambiguous native listings", (data) => expect(parsePiSessionTree(data)).toBeNull());

it("captures an assistant-only continuation boundary without inventing a native user entry", () => {
  const tree = parsePiSessionTree({
    leafId: "wake",
    entries: [entry("u1", null), entry("a1", "u1", "assistant"), entry("wake", "a1", "assistant")],
  })!;
  expect(capturePiTurnTreeBoundary(tree, "a1")).toEqual({
    turnStartEntryId: null,
    leafId: "wake",
    continuationStartEntryId: "wake",
  });
});
