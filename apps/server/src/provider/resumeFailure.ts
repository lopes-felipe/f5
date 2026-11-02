/**
 * Classifies provider errors caused by a saved conversation that cannot be
 * resumed. Retrying the same send fails the same way until the transcript or
 * resume point is repaired, so callers must not treat these as transient.
 */

// The Claude CLI reports a `--resume-session-at` target that was never
// persisted to the session JSONL as `No message found with message.uuid of: <uuid>`.
const MISSING_RESUME_POINT_PATTERN = /no message found with message\.uuid/i;

const MISSING_CONVERSATION_PATTERNS = [
  "no conversation found",
  "conversation not found",
  "could not resume the requested conversation",
  "could not load the saved conversation",
  // Pi: the resumed process reported a different or no session file.
  "did not confirm the expected persisted session file",
  "resume metadata is invalid",
  // Claude: the cursor names a session whose resume boundary was never persisted.
  "no persisted claude resume boundary",
] as const;

export function isClaudeMissingResumePointError(text: string): boolean {
  return MISSING_RESUME_POINT_PATTERN.test(text);
}

export function isProviderResumeFailureText(text: string | null | undefined): boolean {
  if (!text) return false;
  if (isClaudeMissingResumePointError(text)) return true;
  const normalized = text.toLowerCase();
  return MISSING_CONVERSATION_PATTERNS.some((pattern) => normalized.includes(pattern));
}
