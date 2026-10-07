/**
 * Diagnostics for a Claude CLI session that ends. The SDK does not expose the
 * child process, so the exit code and signal come from its exit error text,
 * and the stderr tail comes from the SDK `stderr` callback.
 */

export const CLAUDE_STDERR_TAIL_MAX_CHARS = 8_192;

/** Keeps the last {@link CLAUDE_STDERR_TAIL_MAX_CHARS} characters of stderr. */
export function appendClaudeStderrTail(tail: string, chunk: string): string {
  const next = tail + chunk;
  return next.length > CLAUDE_STDERR_TAIL_MAX_CHARS
    ? next.slice(next.length - CLAUDE_STDERR_TAIL_MAX_CHARS)
    : next;
}

export interface ClaudeProcessExitInfo {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

// Matches the SDK's "Claude Code process exited with code N" and
// "Claude Code process terminated by signal SIGX" exit errors.
const EXIT_CODE_PATTERN = /process exited with code (-?\d+)/i;
const EXIT_SIGNAL_PATTERN = /terminated by signal (SIG[A-Z0-9]+)/i;

export function parseClaudeProcessExit(text: string | null | undefined): ClaudeProcessExitInfo {
  if (!text) return { exitCode: null, signal: null };
  const code = EXIT_CODE_PATTERN.exec(text)?.[1];
  const signal = EXIT_SIGNAL_PATTERN.exec(text)?.[1];
  return {
    exitCode: code === undefined ? null : Number.parseInt(code, 10),
    signal: signal ?? null,
  };
}
