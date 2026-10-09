import type { NativeOperationCommand } from "@t3tools/contracts";
type ReviewTarget = Extract<NativeOperationCommand, { kind: "review" }>["target"];

/** Bare names always mean branches; commit targets require an explicit prefix. */
export function parseNativeReviewTarget(argument: string): ReviewTarget {
  const text = argument.trim();
  if (!text) return { type: "uncommittedChanges" };
  const explicit = /^(branch|commit)(?:\s+|:)(.*)$/s.exec(text);
  if (!explicit) return { type: "baseBranch", branch: text };
  const value = explicit[2]!.trim();
  if (!value) throw new Error(`Provide a ${explicit[1]} target for review.`);
  if (explicit[1] === "branch") return { type: "baseBranch", branch: value };
  if (!/^[0-9a-f]{7,40}$/i.test(value)) throw new Error("Use a 7–40 character commit SHA.");
  return { type: "commit", sha: value };
}
