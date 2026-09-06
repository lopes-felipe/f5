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

export function prReplyBody(body: string, id: string): string {
  return `${body}\n\n<!-- F5 reply ${id} -->`;
}

/** Only lines actually present in a complete provider hunk are commentable. */
export function prReviewLines(patch: string): ReadonlyMap<"LEFT" | "RIGHT", ReadonlySet<number>> {
  const left = new Set<number>();
  const right = new Set<number>();
  const empty = new Map<"LEFT" | "RIGHT", ReadonlySet<number>>();
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
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
    if (line.startsWith(" ") || line.startsWith("-")) {
      if (oldRemaining <= 0 || oldLine < 1) return empty;
      left.add(oldLine++);
      oldRemaining--;
    }
    if (line.startsWith(" ") || line.startsWith("+")) {
      if (newRemaining <= 0 || newLine < 1) return empty;
      right.add(newLine++);
      newRemaining--;
    }
    if (!/^[ +\-]/.test(line) || left.size + right.size > 200_000) return empty;
  }
  if (!inHunk || oldRemaining || newRemaining) return empty;
  return new Map([
    ["LEFT", left],
    ["RIGHT", right],
  ]);
}

export function isPrReviewAnchorInPatch(anchor: PrReviewAnchor, patch: string): boolean {
  return (
    Number.isSafeInteger(anchor.line) &&
    anchor.line > 0 &&
    (prReviewLines(patch).get(anchor.side)?.has(anchor.line) ?? false)
  );
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
