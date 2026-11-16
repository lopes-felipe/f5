import type { ProviderKind } from "@t3tools/contracts";

import { readResumeCursorThreadId } from "../codexAppServerManager.ts";
import { readClaudeResumeState } from "./claudeResumeState.ts";
import { isOpenCodeHistoryContinuation, parseOpenCodeResume } from "./openCodeResume.ts";

function readCursorString(cursor: unknown, key: string): string | undefined {
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
  const value = (cursor as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * The provider-native conversation a resume cursor points at, read with each
 * provider's own parser. Undefined when the cursor proves no native session.
 */
export function nativeSessionIdentity(provider: ProviderKind, cursor: unknown): string | undefined {
  switch (provider) {
    case "claudeAgent":
      // The cursor's `threadId` is F5's id, not Claude's session.
      return readClaudeResumeState(cursor)?.resume;
    case "codex":
      return readResumeCursorThreadId(cursor);
    case "opencode":
      return parseOpenCodeResume(cursor)?.sessionId;
    case "muse":
      return readCursorString(cursor, "mspSessionId");
    case "pi":
      return readCursorString(cursor, "sessionFile");
    case "cursor":
    case "grok":
    case "antigravity":
    case "acp":
      return readCursorString(cursor, "sessionId");
  }
}

/**
 * True only when `current` provably continues the native conversation of
 * `previous`. Two unknown identities are never the same session, and a Claude
 * session resumed at a different boundary has lost the turns after it.
 */
export function isSameNativeSession(
  provider: ProviderKind,
  previous: unknown,
  current: unknown,
): boolean {
  if (provider === "opencode" && isOpenCodeHistoryContinuation(previous, current)) return true;
  const before = nativeSessionIdentity(provider, previous);
  const after = nativeSessionIdentity(provider, current);
  if (before === undefined || after === undefined || before !== after) return false;
  if (provider === "claudeAgent") {
    const beforeBoundary = readClaudeResumeState(previous)?.resumeSessionAt;
    const afterBoundary = readClaudeResumeState(current)?.resumeSessionAt;
    if (beforeBoundary !== undefined && afterBoundary !== undefined)
      return beforeBoundary === afterBoundary;
  }
  return true;
}
