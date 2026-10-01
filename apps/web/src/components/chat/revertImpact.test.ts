import { MessageId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { computeRevertImpact, describeRevertFiles, describeRevertRemoval } from "./revertImpact";

const id = (value: string) => MessageId.makeUnsafe(value);
const turn = (value: string) => TurnId.makeUnsafe(value);

const messages = [
  { id: id("u1"), turnId: null },
  { id: id("a1"), turnId: turn("t1") },
  { id: id("u2"), turnId: null },
  { id: id("a2"), turnId: turn("t2") },
  { id: id("u3"), turnId: null },
  { id: id("a3"), turnId: turn("t3") },
];

const diffs = new Map([
  [turn("t1"), { files: [{ path: "a.ts" }] }],
  [turn("t2"), { files: [{ path: "b.ts" }, { path: "c.ts" }] }],
  [turn("t3"), { files: [{ path: "c.ts" }] }],
]);

describe("computeRevertImpact", () => {
  it("counts the target and everything after it, with distinct changed files", () => {
    expect(computeRevertImpact(messages, id("u2"), diffs)).toEqual({
      removedMessageCount: 4,
      laterMessageCount: 3,
      changedFileCount: 2,
    });
  });

  it("returns null for a message that is not in the timeline", () => {
    expect(computeRevertImpact(messages, id("missing"), diffs)).toBeNull();
  });
});

describe("revert impact copy", () => {
  it("describes what is removed", () => {
    expect(describeRevertRemoval(computeRevertImpact(messages, id("a3"), diffs))).toBe(
      "Removes this message.",
    );
    expect(describeRevertRemoval(computeRevertImpact(messages, id("u3"), diffs))).toBe(
      "Removes this message and the one after it.",
    );
    expect(describeRevertRemoval(computeRevertImpact(messages, id("u2"), diffs))).toBe(
      "Removes this message and the 3 after it.",
    );
  });

  it("describes what happens to files", () => {
    const impact = computeRevertImpact(messages, id("u2"), diffs);
    expect(describeRevertFiles(impact, false)).toBe("Your files stay exactly as they are now.");
    expect(describeRevertFiles(impact, true)).toBe(
      "Restores 2 files to how they were before this message.",
    );
    expect(describeRevertFiles(null, true)).toBe(
      "Files go back to how they were before this message.",
    );
  });
});
