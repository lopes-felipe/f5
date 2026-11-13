function unifiedRange(count: number): string {
  return count > 0 ? `1,${count}` : "0,0";
}

/**
 * Builds a single unified-diff hunk that replaces `oldString` with `newString`.
 *
 * Hunk line numbers are relative (1-based) because the tool input does not carry
 * the surrounding file position; this is sufficient for inline diff rendering,
 * which only needs the changed content.
 */
export function buildReplaceHunk(oldString: string, newString: string): string {
  const oldLines = oldString.length > 0 ? oldString.split("\n") : [];
  const newLines = newString.length > 0 ? newString.split("\n") : [];
  const lines = [`@@ -${unifiedRange(oldLines.length)} +${unifiedRange(newLines.length)} @@`];
  for (const line of oldLines) {
    lines.push(`-${line}`);
  }
  for (const line of newLines) {
    lines.push(`+${line}`);
  }
  return lines.join("\n");
}
