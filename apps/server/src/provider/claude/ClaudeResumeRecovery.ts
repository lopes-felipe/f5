import {
  ClaudeTranscriptRejoinCancelled,
  commitClaudeTranscriptRejoin,
  planClaudeTranscriptRejoin,
} from "../../maintenance/ClaudeTranscriptRepair.ts";
/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude Agent provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeAdapterLive
 */
import {
  beginClaudeTranscriptMaintenance,
  readClaudeTranscriptLines,
  resolveClaudeResumePoint,
} from "../claudeTranscript.ts";

import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";

import { type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { ThreadId } from "@t3tools/contracts";
import { Cause, Effect, Option } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { isUuid, readClaudeResumeState } from "../claudeResumeState.ts";

import {
  PROVIDER,
  type ClaudeSessionProbeInput,
  type ClaudeSessionStoreFs,
} from "./ClaudeTypes.ts";

export const CLAUDE_TRANSCRIPT_REJOIN_BUDGET_MS = 30_000;

/**
 * When no resume point has a complete chain because another tool moved the
 * transcript's beginning to a sibling file, rejoin it before the CLI starts.
 * Planning is interruptible and bounded by the budget; only the final file
 * replacement is not. Callers must not run this while a Claude process for
 * the session may still write the transcript. Returns the rejoined file names
 * and the recovered cursor, or undefined when nothing was changed.
 */
export function rejoinMovedClaudeTranscriptHead(input: {
  readonly threadId: string;
  readonly sessionId: string;
  readonly file: string;
  readonly entries: ReadonlyMap<string, Record<string, unknown>>;
  readonly cursor: unknown;
}) {
  const state = readClaudeResumeState(input.cursor);
  const target =
    state && !state.resumeLatest
      ? (state.resumeSessionAt ?? state.turnBoundaries?.at(-1)?.assistantUuid)
      : undefined;
  if (
    !state ||
    !target ||
    !isUuid(target) ||
    resolveClaudeResumePoint(input.entries, target, state.turnBoundaries ?? []).kind !== "none"
  )
    return Effect.succeed(undefined);
  const deadline = Date.now() + CLAUDE_TRANSCRIPT_REJOIN_BUDGET_MS;
  return Effect.acquireUseRelease(
    Effect.try({
      try: () => beginClaudeTranscriptMaintenance(input.sessionId),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: "Claude transcript repair is already in progress.",
          cause,
        }),
    }),
    () =>
      Effect.tryPromise((signal) =>
        planClaudeTranscriptRejoin({ file: input.file, target, signal, deadline }),
      ).pipe(
        Effect.flatMap((plan) =>
          plan.status !== "planned"
            ? Effect.succeed(undefined)
            : // The lock outlives the replacement, which must not stop halfway.
              Effect.uninterruptible(
                Effect.tryPromise(() => {
                  if (Date.now() > deadline) throw new ClaudeTranscriptRejoinCancelled();
                  return commitClaudeTranscriptRejoin(
                    { file: input.file, target, resumeCursor: input.cursor },
                    plan,
                  );
                }),
              ),
        ),
      ),
    (release) => Effect.sync(release),
  ).pipe(
    Effect.map((result) =>
      result ? { rejoinedFrom: result.rejoinedFrom, resumeCursor: result.resumeCursor } : undefined,
    ),
    Effect.tap((rejoined) =>
      rejoined
        ? Effect.logWarning("Rejoined Claude transcript with a moved copy of its beginning", {
            threadId: input.threadId,
            rejoined: rejoined.rejoinedFrom,
          })
        : Effect.void,
    ),
    Effect.catch((cause) =>
      Effect.logWarning("Claude transcript rejoin failed", {
        threadId: input.threadId,
        cause: String(cause),
      }).pipe(Effect.as(undefined)),
    ),
  );
}

export const nodeClaudeSessionStoreFs: ClaudeSessionStoreFs = {
  readdir: (path) => NodeFs.readdir(path),
  stat: (path) => NodeFs.stat(path),
  readLines: readClaudeTranscriptLines,
};

export function isMissingPathError(cause: unknown): boolean {
  const code = (cause as { readonly code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

// Only saved user or assistant messages make a conversation resumable.
// System records and other metadata can exist before the first prompt is saved.
export const CLAUDE_CONVERSATION_ENTRY_TYPES: ReadonlySet<string> = new Set(["user", "assistant"]);

/**
 * Scans a transcript until it finds a conversation entry. An unparseable line
 * (for example a partly written tail) makes a no-match result "unknown"
 * instead of "absent".
 */
async function classifyClaudeTranscript(
  lines: AsyncIterable<string>,
): Promise<"present" | "absent" | "unknown"> {
  let sawUnparseableLine = false;
  for await (const line of lines) {
    if (line.trim() === "") {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      sawUnparseableLine = true;
      continue;
    }
    const type = (entry as { readonly type?: unknown } | null)?.type;
    if (typeof type === "string" && CLAUDE_CONVERSATION_ENTRY_TYPES.has(type)) {
      return "present";
    }
  }
  return sawUnparseableLine ? "unknown" : "absent";
}

/**
 * Checks whether a resumable Claude transcript exists before resuming it.
 *
 * Reads `<claudeConfigDir>/projects/<any project>/<sessionId>.jsonl` directly
 * instead of the SDK's `getSessionMessages`, which only looks under the f5
 * server's own `CLAUDE_CONFIG_DIR`/`~/.claude` and therefore reported sessions
 * written by an isolated CLI as absent. Scanning every project dir avoids
 * depending on the CLI's cwd-to-dirname encoding, which truncates and hashes
 * long paths and can be overridden by `CLAUDE_CODE_PROJECT_DIR_NAME`.
 *
 * A transcript counts as present only if it holds a user or assistant entry.
 * Only returns "absent" when the store was fully readable and no transcript
 * had one. Anything it cannot see yields
 * "unknown" so a valid resume cursor is never discarded on a guess.
 */
export function probeClaudeSessionAvailability(
  input: ClaudeSessionProbeInput,
  fs: ClaudeSessionStoreFs = nodeClaudeSessionStoreFs,
  timeoutMs = 1_500,
): Effect.Effect<"present" | "absent" | "unknown"> {
  return Effect.tryPromise(async (signal) => {
    const projectsDir = NodePath.join(input.claudeConfigDir, "projects");
    // A missing or unreadable store rejects here and maps to "unknown".
    const projectEntries = await fs.readdir(projectsDir);
    const transcriptName = `${input.sessionId}.jsonl`;
    const candidates = await Promise.all(
      projectEntries.map(async (entry) => {
        const transcriptPath = NodePath.join(projectsDir, entry, transcriptName);
        try {
          const stats = await fs.stat(transcriptPath);
          return stats.isFile() && stats.size > 0 ? transcriptPath : undefined;
        } catch (cause) {
          if (isMissingPathError(cause)) {
            return undefined;
          }
          throw cause;
        }
      }),
    );
    let result: "absent" | "unknown" = "absent";
    for (const transcriptPath of candidates) {
      if (transcriptPath === undefined) {
        continue;
      }
      const verdict = await classifyClaudeTranscript(fs.readLines(transcriptPath, signal));
      if (verdict === "present") {
        return "present" as const;
      }
      if (verdict === "unknown") {
        result = "unknown";
      }
    }
    return result;
  }).pipe(
    Effect.timeoutOption(timeoutMs),
    Effect.map(Option.getOrElse(() => "unknown" as const)),
    Effect.orElseSucceed(() => "unknown" as const),
  );
}

export function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

export function toError(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(toMessage(cause, fallback));
}

export function normalizeClaudeStreamMessages(cause: Cause.Cause<Error>): ReadonlyArray<string> {
  const errors = Cause.prettyErrors(cause)
    .map((error) => error.message.trim())
    .filter((message) => message.length > 0);
  if (errors.length > 0) {
    return errors;
  }

  const squashed = toMessage(Cause.squash(cause), "").trim();
  return squashed.length > 0 ? [squashed] : [];
}

export function isClaudeInterruptedMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("all fibers interrupted without error") ||
    normalized.includes("request was aborted") ||
    normalized.includes("interrupted by user")
  );
}

export function isClaudeInterruptedCause(cause: Cause.Cause<Error>): boolean {
  return (
    Cause.hasInterruptsOnly(cause) ||
    normalizeClaudeStreamMessages(cause).some(isClaudeInterruptedMessage)
  );
}

export const CLAUDE_MISSING_SESSION_PATTERNS = [
  "no conversation found",
  "conversation not found",
  "session not found",
  "no such session",
  "could not find session",
] as const;

// Narrow fallback for the CLI's own sign-in wording. Typed signals (the
// assistant `authentication_failed` error, HTTP 401) are checked first.
export const CLAUDE_AUTH_FAILURE_PATTERN =
  /oauth (?:session|token) (?:has )?expired|oauth token (?:could not|cannot) be refreshed|please run \/login|run \/login to/i;

/**
 * True when the error text names a rejected configured API key. Signing in
 * through the browser can't fix that: the key in provider settings has to change.
 */
export function isClaudeApiKeyFailureText(text: string | null | undefined): boolean {
  return !!text && /\b(?:invalid|incorrect|revoked) (?:x-)?api[ -]?key\b|x-api-key/i.test(text);
}

/** True when a Claude failure means the account must sign in again (not billing or limits). */
export function isClaudeAuthFailureText(text: string | null | undefined): boolean {
  if (!text) return false;
  if (/billing|account.on.hold|usage.?limit|rate.?limit/i.test(text)) return false;
  if (isClaudeApiKeyFailureText(text)) return false;
  return CLAUDE_AUTH_FAILURE_PATTERN.test(text);
}

export function isClaudeMissingConversationError(
  text: string,
  attemptedSessionId: string,
): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes(attemptedSessionId.toLowerCase()) &&
    CLAUDE_MISSING_SESSION_PATTERNS.some((pattern) => normalized.includes(pattern))
  );
}

export function messageFromClaudeStreamCause(cause: Cause.Cause<Error>, fallback: string): string {
  return normalizeClaudeStreamMessages(cause)[0] ?? fallback;
}

export function interruptionMessageFromClaudeCause(cause: Cause.Cause<Error>): string {
  const message = messageFromClaudeStreamCause(cause, "Claude runtime interrupted.");
  return isClaudeInterruptedMessage(message) ? "Claude runtime interrupted." : message;
}

export function resultErrorsText(result: SDKResultMessage): string {
  return "errors" in result && Array.isArray(result.errors)
    ? result.errors.join(" ").toLowerCase()
    : "";
}

/**
 * 5-minute/1-hour cache-write split summed over `result.modelUsage`. These are SDK
 * whole-agent-tree session figures for display; they never feed F5 token facts or cost.
 * Undefined when no model reported the split (CLIs before 2.1.317).
 */

export const CLAUDE_STARTUP_FAILURE_MESSAGES: Partial<Record<string, string>> = {
  sandbox_required_unavailable:
    "Claude requires a working sandbox here; install it or change the requirement.",
  initialize_not_first:
    "A wrapper between F5 and Claude altered startup; check custom launch arguments/executable.",
};

export function claudeStartupFailureMessage(result: SDKResultMessage): string | undefined {
  if (result.subtype !== "error_during_execution") return undefined;
  const reason = (result as { startup_failure_reason?: unknown }).startup_failure_reason;
  if (reason === "config_file_invalid") return claudeInvalidConfigFileMessage(result);
  return typeof reason === "string" ? CLAUDE_STARTUP_FAILURE_MESSAGES[reason] : undefined;
}

export const DAY_MS = 24 * 60 * 60_000;
export const CLAUDE_CREDENTIAL_EXPIRY_WARNING_MS = 7 * DAY_MS;
/** The SDK: the login's real end "can be up to 3 days earlier" than the reported date. */
export const CLAUDE_CREDENTIAL_EXPIRY_EARLY_MS = 3 * DAY_MS;

/**
 * Warning for a result's `credential_expires_at` (2.1.326+): the end of the claude.ai login's
 * refresh chain, an estimate the login can beat by up to 3 days. Silent until 7 days remain
 * before the earliest end. The date is formatted in UTC so a remote server's locale and time
 * zone do not leak into it.
 */
export function claudeCredentialExpiryWarning(
  expiresAt: unknown,
  nowMs: number,
  formatDate: (date: Date) => string = (date) =>
    `${date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })} (UTC)`,
): string | undefined {
  if (typeof expiresAt !== "string") return undefined;
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) return undefined;
  const earliestMs = expiresMs - CLAUDE_CREDENTIAL_EXPIRY_EARLY_MS;
  if (earliestMs <= nowMs) return "This Claude login may end at any time; sign in again.";
  if (earliestMs - nowMs > CLAUDE_CREDENTIAL_EXPIRY_WARNING_MS) return undefined;
  return `This Claude login may end as early as ${formatDate(new Date(earliestMs))}; sign in again before then.`;
}

/**
 * `config_file_invalid` (2.1.326+): paths come from `invalid_config_file`, never from the
 * error text. The file is left unchanged and every headless start fails until it is fixed.
 */
export function claudeInvalidConfigFileMessage(result: SDKResultMessage): string | undefined {
  const file = (result as { invalid_config_file?: unknown }).invalid_config_file;
  if (typeof file !== "object" || file === null) return undefined;
  const {
    path,
    backup_path: backupPath,
    backup_searched: backupSearched,
  } = file as { path?: unknown; backup_path?: unknown; backup_searched?: unknown };
  if (typeof path !== "string" || !path.trim()) return undefined;
  // The named backup may itself not parse, so it is offered for checking, not copying blindly.
  const repair =
    typeof backupPath === "string" && backupPath.trim()
      ? `A backup is at ${backupPath}; check that it is valid JSON before restoring it.`
      : backupSearched === true
        ? "Claude found no backup, so repair the file by hand."
        : "Repair it by hand.";
  return `Claude's config file ${path} is not valid JSON, and Claude refuses to start until it is fixed. ${repair}`;
}

export function resultUserFacingError(result: SDKResultMessage): string | undefined {
  if (result.subtype === "success" || !Array.isArray(result.errors)) {
    return undefined;
  }
  return (
    claudeStartupFailureMessage(result) ??
    result.errors.find((error) => !error.startsWith("[ede_diagnostic]"))
  );
}

export function isInterruptedResult(result: SDKResultMessage): boolean {
  const terminalReason = (result as SDKResultMessage & { terminal_reason?: unknown })
    .terminal_reason;
  if (terminalReason === "aborted_tools" || terminalReason === "aborted_streaming") {
    return true;
  }
  const errors = resultErrorsText(result);
  if (errors.includes("interrupt")) {
    return true;
  }

  return (
    result.subtype === "error_during_execution" &&
    result.is_error === false &&
    (errors.includes("request was aborted") ||
      errors.includes("interrupted by user") ||
      errors.includes("aborted"))
  );
}

export const CLAUDE_CONTEXT_WINDOW_FULL_ERROR =
  "Claude stopped: the prompt exceeds the model's context window. Run /compact or start a new thread.";
export const CLAUDE_SESSION_WRITES_LOST_WARNING =
  "Claude could not save part of this conversation (disk full/quota). Resuming may miss recent messages.";

export function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("not found")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

/** The SDK's error for a control request the CLI process ended before answering. */
export const isClaudeQueryClosedError = (cause: unknown) =>
  toMessage(cause, "").startsWith("Query closed before ");

export function toRequestError(
  threadId: ThreadId,
  method: string,
  cause: unknown,
): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}
