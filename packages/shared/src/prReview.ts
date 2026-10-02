import type { PrHubComparisonIdentity } from "@t3tools/contracts";

/** Compare revision identity, independent of JSON property insertion order. */
export function prComparisonsEqual(
  a: PrHubComparisonIdentity | null | undefined,
  b: PrHubComparisonIdentity | null | undefined,
): boolean {
  return Boolean(
    a &&
    b &&
    a.mode === b.mode &&
    a.baseRepository === b.baseRepository &&
    a.baseRef === b.baseRef &&
    a.baseOid === b.baseOid &&
    a.headRepository === b.headRepository &&
    a.headRef === b.headRef &&
    a.headOid === b.headOid &&
    a.mergeBaseOid === b.mergeBaseOid &&
    a.reviewedHeadOid === b.reviewedHeadOid,
  );
}

export interface PrReviewAnchor {
  readonly path: string;
  readonly side: "LEFT" | "RIGHT";
  readonly line: number;
}

export interface PrReviewPosition {
  readonly kind: "added" | "deleted" | "context";
  readonly oldLine?: number;
  readonly newLine?: number;
}

export function prReplyBody(body: string, id: string): string {
  return `${body}\n\n<!-- F5 reply ${id} -->`;
}

/** Only lines actually present in a complete provider hunk are commentable. */
function prReviewPositions(
  patch: string,
): ReadonlyMap<"LEFT" | "RIGHT", ReadonlyMap<number, PrReviewPosition>> {
  const left = new Map<number, PrReviewPosition>();
  const right = new Map<number, PrReviewPosition>();
  const empty = new Map<"LEFT" | "RIGHT", ReadonlyMap<number, PrReviewPosition>>();
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  let inHunk = false;
  const patchLines = patch.split("\n");
  for (const [index, raw] of patchLines.entries()) {
    let line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    // A trailing delimiter is not a provider context line. Hunk counts must
    // still reject a truncated patch, even when it happens to end in a newline.
    if (line === "" && index === patchLines.length - 1) continue;
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      if (oldRemaining || newRemaining) return empty;
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      oldRemaining = Number(header[2] ?? 1);
      newRemaining = Number(header[4] ?? 1);
      if (![oldLine, newLine, oldRemaining, newRemaining].every(Number.isSafeInteger)) return empty;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("\\ No newline at end of file")) continue;
    if (oldRemaining === 0 && newRemaining === 0) {
      if (line === "") continue;
      return empty;
    }
    if (line === "") line = " ";
    const position: PrReviewPosition = line.startsWith(" ")
      ? { kind: "context", oldLine, newLine }
      : line.startsWith("-")
        ? { kind: "deleted", oldLine }
        : { kind: "added", newLine };
    if (line.startsWith(" ") || line.startsWith("-")) {
      if (oldRemaining <= 0 || oldLine < 1 || left.has(oldLine)) return empty;
      left.set(oldLine++, position);
      oldRemaining--;
    }
    if (line.startsWith(" ") || line.startsWith("+")) {
      if (newRemaining <= 0 || newLine < 1 || right.has(newLine)) return empty;
      right.set(newLine++, position);
      newRemaining--;
    }
    if (!/^[ +-]/.test(line) || left.size + right.size > 200_000) return empty;
  }
  if (!inHunk || oldRemaining || newRemaining) return empty;
  return new Map([
    ["LEFT", left],
    ["RIGHT", right],
  ]);
}

export function prReviewLines(patch: string): ReadonlyMap<"LEFT" | "RIGHT", ReadonlySet<number>> {
  return new Map(
    [...prReviewPositions(patch)].map(([side, positions]) => [side, new Set(positions.keys())]),
  );
}

/** Resolves native old/new coordinates only after validating the entire hunk stream. */
export function resolvePrReviewPosition(
  anchor: PrReviewAnchor,
  patch: string,
): PrReviewPosition | null {
  if (!Number.isSafeInteger(anchor.line) || anchor.line <= 0) return null;
  return prReviewPositions(patch).get(anchor.side)?.get(anchor.line) ?? null;
}

export function isPrReviewAnchorInPatch(anchor: PrReviewAnchor, patch: string): boolean {
  return resolvePrReviewPosition(anchor, patch) !== null;
}

/** Hide whole whitespace-only hunks without rewriting any provider line numbers. */
export function substantivePrPatch(patch: string): string | null {
  const lines = patch.split("\n");
  const first = lines.findIndex((line) => line.startsWith("@@ "));
  if (first < 0) return patch;
  const result = lines.slice(0, first);
  let retained = false;
  for (let start = first; start < lines.length; ) {
    let end = start + 1;
    while (end < lines.length && !lines[end]!.startsWith("@@ ")) end++;
    const hunk = lines.slice(start, end);
    const removed = hunk
      .filter((line) => line.startsWith("-"))
      .map((line) => line.slice(1).replace(/\s/g, ""));
    const added = hunk
      .filter((line) => line.startsWith("+"))
      .map((line) => line.slice(1).replace(/\s/g, ""));
    if (removed.length !== added.length || removed.some((line, index) => line !== added[index])) {
      result.push(...hunk);
      retained = true;
    }
    start = end;
  }
  return retained ? result.join("\n") : null;
}
