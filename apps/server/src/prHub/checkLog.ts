/** The longest excerpt of a check log that is sent to a client. */
export const CHECK_LOG_MAX_LINES = 200;
export const CHECK_LOG_MAX_BYTES = 32 * 1024;

const MAX_LINE_LENGTH = 2_000;
/** What follows the error marker is mostly cleanup; a few lines of it are enough. */
const LINES_AFTER_ERROR = 20;
const ERROR_MARKER = "##[error]";

// CSI sequences (colors, cursor moves), OSC sequences and two-character escapes.
const ANSI =
  // oxlint-disable-next-line no-control-regex
  /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g;
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;
/** The runner's timestamp at the start of every line. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;

export interface CheckLogExcerpt {
  readonly excerpt: string;
  /** Line number, in the whole log, of the excerpt's first line. Zero for an empty log. */
  readonly startLine: number;
  readonly totalLines: number;
  /** Line number, in the whole log, of the first error marker. */
  readonly errorLine: number | null;
  readonly truncated: boolean;
}

function cleanLine(line: string): string {
  const cleaned = line.replace(ANSI, "").replace(TIMESTAMP, "").replace(CONTROL, "").trimEnd();
  return cleaned.length > MAX_LINE_LENGTH ? `${cleaned.slice(0, MAX_LINE_LENGTH)}…` : cleaned;
}

/**
 * Cuts a job log down to the part that explains the failure. The lines that say what went
 * wrong come before the first `##[error]` marker, so the excerpt ends shortly after it. A
 * log with no marker keeps its tail. When the excerpt is over the byte limit, the lines
 * farthest from the marker go first.
 */
export function excerptCheckLog(
  raw: string,
  limits: { readonly maxLines?: number; readonly maxBytes?: number } = {},
): CheckLogExcerpt {
  const maxLines = Math.max(1, limits.maxLines ?? CHECK_LOG_MAX_LINES);
  const maxBytes = Math.max(1, limits.maxBytes ?? CHECK_LOG_MAX_BYTES);
  const lines = raw.replace(/^﻿/, "").split(/\r?\n/).map(cleanLine);
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  const totalLines = lines.length;
  if (totalLines === 0)
    return { excerpt: "", startLine: 0, totalLines: 0, errorLine: null, truncated: false };

  const errorIndex = lines.findIndex((line) => line.includes(ERROR_MARKER));
  const anchor = errorIndex < 0 ? totalLines - 1 : errorIndex;
  let end = Math.min(totalLines, anchor + 1 + (errorIndex < 0 ? 0 : LINES_AFTER_ERROR));
  let start = Math.max(0, end - maxLines);
  // A marker near the top leaves room for more of what follows it.
  end = Math.min(totalLines, start + maxLines);

  const size = (index: number) => Buffer.byteLength(lines[index]!, "utf8") + 1;
  let bytes = 0;
  for (let index = start; index < end; index++) bytes += size(index);
  while (bytes > maxBytes && end - start > 1) {
    if (end - 1 - anchor >= anchor - start) bytes -= size(--end);
    else bytes -= size(start++);
  }

  return {
    excerpt: lines.slice(start, end).join("\n"),
    startLine: start + 1,
    totalLines,
    errorLine: errorIndex < 0 ? null : errorIndex + 1,
    truncated: start > 0 || end < totalLines,
  };
}
