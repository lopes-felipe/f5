/**
 * Git progress output is a byte stream where `\r` redraws a line in place.
 * Each redraw becomes its own line so callers can parse the latest state.
 */
const PARTIAL_LINE_MAX_LENGTH = 4_096;

export function makeProgressLineSplitter(onLine: (line: string) => void) {
  const decoder = new TextDecoder();
  let buffer = "";
  return (chunk: Uint8Array) => {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r\n|\r|\n/);
    buffer = lines.pop() ?? "";
    if (buffer.length > PARTIAL_LINE_MAX_LENGTH) buffer = buffer.slice(-PARTIAL_LINE_MAX_LENGTH);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length > 0) onLine(trimmed);
    }
  };
}

/** Parses `Updating files:  45% (450/1000)` from `git worktree add --progress`. */
export function parseCheckoutProgressLine(
  line: string,
): { readonly percent: number; readonly completed: number; readonly total: number } | null {
  const match = /^(?:Updating|Checking out) files:\s+(\d{1,3})%\s+\((\d+)\/(\d+)\)/.exec(line);
  if (!match) return null;
  const percent = Math.min(100, Math.max(0, Number(match[1])));
  const completed = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) return null;
  return { percent, completed, total };
}
