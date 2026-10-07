import { describe, expect, it } from "vitest";

import {
  CLAUDE_STDERR_TAIL_MAX_CHARS,
  appendClaudeStderrTail,
  parseClaudeProcessExit,
} from "./claudeProcessExit.ts";

describe("claudeProcessExit", () => {
  it("parses the SDK's exit code and signal errors", () => {
    expect(parseClaudeProcessExit("Claude Code process exited with code 1\nstderr")).toEqual({
      exitCode: 1,
      signal: null,
    });
    expect(parseClaudeProcessExit("Claude Code process terminated by signal SIGKILL")).toEqual({
      exitCode: null,
      signal: "SIGKILL",
    });
    expect(parseClaudeProcessExit(null)).toEqual({ exitCode: null, signal: null });
  });

  it("keeps only the newest stderr", () => {
    const tail = appendClaudeStderrTail("a".repeat(CLAUDE_STDERR_TAIL_MAX_CHARS), "END");
    expect(tail).toHaveLength(CLAUDE_STDERR_TAIL_MAX_CHARS);
    expect(tail.endsWith("END")).toBe(true);
  });
});
