// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite and lstat read the native session log.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type * as NodeSqlite from "node:sqlite";
import { openRuntimeSqliteDatabase } from "../../persistence/runtimeSqlite.ts";

export interface AntigravityTurnFailure {
  class: "usage_limit" | "provider_error";
  message: string;
  code?: string | null;
  retryable?: boolean;
  resetAt?: string | null;
  /** Absent for failures read from the session log or a typed stop reason. */
  evidence?: "message";
}
/** A harness notice that ended the turn, as the agent streamed it. */
export interface AntigravityTurnNotice {
  readonly text: string;
  readonly receivedAt: string;
}
const makeProviderFailure = (failure: AntigravityTurnFailure): AntigravityTurnFailure =>
  Object.fromEntries(
    Object.entries(failure).filter(([, value]) => value != null),
  ) as unknown as AntigravityTurnFailure;
import * as DateTime from "effect/DateTime";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/schema";

import { antigravityManagedPath, antigravityProfileRoot } from "./AntigravityProfilePaths.ts";

// CORTEX_STEP_TYPE_ERROR_MESSAGE in the native trajectory.
const ERROR_STEP_TYPE = 17;
// The harness error text leads the payload; a Go stack trace follows it.
const MAX_ERROR_PAYLOAD_BYTES = 16_384;
// The Go harness's rendering of a Google API error, as the agent's api_errors.py reads it.
const API_ERROR = /Error (\d{3}), Message: (.+?), Status: ([A-Z_]+)/s;
// Newer harnesses lead with `STATUS (code 429): message`, then the JSON error body. The message
// ends at the next protobuf field tag, a control byte.
const API_ERROR_STATUS_FIRST = /\b([A-Z][A-Z_]+) \(code (\d{3})\): (\P{Cc}+)/u;
// Both the Go map rendering (`reason:X`) and the JSON body (`"reason": "X"`).
const QUOTA_EXHAUSTED = /\breason"?\s*:\s*"?QUOTA_EXHAUSTED\b/;
const RESET_TIMESTAMP = /\bquotaResetTimeStamp"?\s*:\s*"?([^\s"\],}]+)/;
const RESET_DELAY =
  /\bquotaResetDelay"?\s*:\s*"?((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=["\s\],}])/;
/** A chat chunk the agent harness wrote itself (`⚠ …`), not the model. */
export const ANTIGRAVITY_HARNESS_NOTICE = /^\s*⚠/;
// The agent's own notice for a quota error, streamed as the turn's last message chunk.
const QUOTA_NOTICE =
  /^\s*⚠️?\s*([^\n]*\bquota\b[^\n]*?)\s*Resets in ((?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s)?)\.?\s*$/i;
const QUOTA_MESSAGE = "You have reached your Antigravity quota for this period.";
// The harness writes the error step around when it ends the turn; give the commit time to land.
const NOTICE_SETTLE_POLLS = 10;
const NOTICE_SETTLE_INTERVAL = Duration.millis(200);
const GO_DURATION_PART = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)/g;
const GO_DURATION_UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};
const NATIVE_SESSION_ID = /^[\w-]+$/;
class AntigravitySessionLogError extends Data.TaggedError("AntigravitySessionLogError")<{
  readonly cause: unknown;
}> {}
const sessionLogError = (cause: unknown) => new AntigravitySessionLogError({ cause });

interface LastStep {
  readonly type: number;
  readonly payload: Uint8Array | null;
}

const readSteps = <A>(file: string, read: (database: NodeSqlite.DatabaseSync) => A) =>
  Effect.tryPromise({
    try: async () => {
      const database = (await openRuntimeSqliteDatabase(file, {
        readOnly: true,
      })) as unknown as NodeSqlite.DatabaseSync;
      try {
        database.exec("PRAGMA busy_timeout = 100");
        const hasSteps =
          database
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steps'")
            .get() !== undefined;
        return hasSteps ? read(database) : undefined;
      } finally {
        database.close();
      }
    },
    catch: sessionLogError,
  });

const lastStepIndex = (database: NodeSqlite.DatabaseSync) => {
  const index = database.prepare("SELECT max(idx) AS idx FROM steps").get()?.idx;
  return typeof index === "number" ? index : -1;
};

const lastStepAfter =
  (index: number) =>
  (database: NodeSqlite.DatabaseSync): LastStep | undefined => {
    const row = database
      .prepare(
        `SELECT step_type AS type, substr(step_payload, 1, ?) AS payload
         FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1`,
      )
      .get(MAX_ERROR_PAYLOAD_BYTES, index);
    if (typeof row?.type !== "number") return undefined;
    return { type: row.type, payload: row.payload instanceof Uint8Array ? row.payload : null };
  };

function resetAtFrom(text: string, now: DateTime.Utc): string | undefined {
  // makeProviderFailure drops a timestamp that does not parse, so fall back to the delay.
  const timestamp = RESET_TIMESTAMP.exec(text)?.[1];
  if (timestamp !== undefined && Number.isFinite(Date.parse(timestamp))) return timestamp;
  const delay = RESET_DELAY.exec(text)?.[1];
  if (delay === undefined) return undefined;
  const delayMs = goDurationMs(delay);
  return delayMs > 0 ? new Date(DateTime.toEpochMillis(now) + delayMs).toISOString() : undefined;
}

function goDurationMs(duration: string): number {
  let ms = 0;
  for (const [, amount, unit] of duration.matchAll(GO_DURATION_PART)) {
    ms += Number(amount) * (GO_DURATION_UNIT_MS[unit!] ?? 0);
  }
  return ms;
}

/** `{ httpStatus, message, status }` from either rendering of a Google API error. */
function apiErrorFrom(
  text: string,
): { httpStatus: string; message: string; status: string } | undefined {
  const goError = API_ERROR.exec(text);
  if (goError) return { httpStatus: goError[1]!, message: goError[2]!, status: goError[3]! };
  const statusFirst = API_ERROR_STATUS_FIRST.exec(text);
  if (statusFirst)
    return { httpStatus: statusFirst[2]!, message: statusFirst[3]!, status: statusFirst[1]! };
  return undefined;
}

/**
 * The agent streams a quota error to the chat as `⚠ <message> Resets in 1h8m59s.` before it
 * ends the turn. Only that exact shape counts; a model reply quoting a quota notice does not.
 */
export function parseAntigravityQuotaNotice(
  text: string,
  receivedAt: string,
): AntigravityTurnFailure | undefined {
  const match = QUOTA_NOTICE.exec(text);
  const duration = match?.[2];
  if (!duration) return undefined;
  const receivedMs = Date.parse(receivedAt);
  const delayMs = goDurationMs(duration);
  if (!Number.isFinite(receivedMs) || !(delayMs > 0)) return undefined;
  const resetMs = receivedMs + delayMs;
  return makeProviderFailure({
    class: "usage_limit",
    message: QUOTA_MESSAGE,
    code: "QUOTA_EXHAUSTED",
    retryable: true,
    resetAt: resetMs < 8.64e15 ? new Date(resetMs).toISOString() : null,
    evidence: "message",
  });
}

function noticeFailure(
  result: EffectAcpSchema.PromptResponse,
  notice: AntigravityTurnNotice | undefined,
): AntigravityTurnFailure | undefined {
  return notice && result.stopReason === "end_turn"
    ? parseAntigravityQuotaNotice(notice.text, notice.receivedAt)
    : undefined;
}

/** An error step whose text named nothing; a quota notice explains the turn better. */
const isUnrecognizedFailure = (failure: AntigravityTurnFailure) =>
  failure.class === "provider_error" && failure.code === undefined;

function turnFailure(
  stopReason: EffectAcpSchema.StopReason,
  step: LastStep | undefined,
  now: DateTime.Utc,
  unrecognizedErrors = false,
): AntigravityTurnFailure | undefined {
  const errorText =
    step?.type === ERROR_STEP_TYPE
      ? new TextDecoder().decode(step.payload ?? new Uint8Array())
      : undefined;
  // The agent maps only the SDK's QUOTA_EXHAUSTED stop reason to `refusal`.
  if (errorText === undefined && stopReason !== "refusal") return undefined;
  const text = errorText ?? "";
  const apiError = apiErrorFrom(text);
  if (stopReason === "refusal" || QUOTA_EXHAUSTED.test(text)) {
    return makeProviderFailure({
      class: "usage_limit",
      message: QUOTA_MESSAGE,
      code: apiError?.status ?? "QUOTA_EXHAUSTED",
      retryable: true,
      resetAt: resetAtFrom(text, now) ?? null,
    });
  }
  if (apiError === undefined) {
    // Only the step type says this is an error. On a release whose step numbering hasn't been
    // checked, that type could mean something else, so the turn is not failed on it alone.
    if (!unrecognizedErrors) return undefined;
    return makeProviderFailure({
      class: "provider_error",
      message: "Antigravity stopped this turn because of an error.",
    });
  }
  const { httpStatus, message, status } = apiError;
  const rateLimited = httpStatus === "429" || status === "RESOURCE_EXHAUSTED";
  return makeProviderFailure({
    class: rateLimited ? "usage_limit" : "provider_error",
    message: message.trim(),
    code: status,
    retryable: rateLimited || Number(httpStatus) >= 500,
  });
}

const conversationSegments = ["antigravity-acp", "conversations"];

/**
 * Antigravity reports an upstream API failure as a chat message and `end_turn`. Its
 * session log ends that turn with an error step, so the check reads only steps the
 * current prompt added, read-only, from this session's own unlinked database. Without
 * that evidence a typed `refusal` still fails the turn.
 *
 * `unrecognizedErrors` also fails a turn on an error step whose text is not a recognised API or
 * quota error. Pass it only for runtimes whose step numbering has been checked.
 */
export const watchAntigravityPromptOutcome = Effect.fn("AntigravityTurnOutcome.watch")(function* (
  profileDirectory: string,
  sessionId: string,
  options: { readonly unrecognizedErrors?: boolean } = {},
) {
  const unrecognizedErrors = options.unrecognizedErrors === true;
  const typedOnly = (result: EffectAcpSchema.PromptResponse, notice?: AntigravityTurnNotice) =>
    DateTime.now.pipe(
      Effect.map(
        (now) => turnFailure(result.stopReason, undefined, now) ?? noticeFailure(result, notice),
      ),
    );
  if (!NATIVE_SESSION_ID.test(sessionId)) return typedOnly;
  const segments = [...conversationSegments, `${sessionId}.db`];
  const before = yield* Effect.tryPromise({
    try: async () => {
      const root = await antigravityProfileRoot(profileDirectory);
      if (root === undefined) return undefined;
      if ((await antigravityManagedPath(root, conversationSegments, "directory")) === undefined) {
        return undefined;
      }
      const database = await antigravityManagedPath(root, segments, "file");
      // A path that exists but fails the proof is a link or other foreign entry.
      if (database === undefined) {
        const present = await NodeFSP.lstat(NodePath.join(root, ...segments)).then(
          () => true,
          () => false,
        );
        return present ? undefined : { root, identity: undefined, startIndex: -1 };
      }
      return { root, identity: database.info, startIndex: undefined };
    },
    catch: sessionLogError,
  }).pipe(Effect.orElseSucceed(() => undefined));
  if (before === undefined) {
    yield* Effect.logWarning("The Antigravity session log is not this session's own file.");
    return typedOnly;
  }
  const startIndex =
    before.startIndex ??
    (yield* readSteps(NodePath.join(before.root, ...segments), lastStepIndex).pipe(
      Effect.map((index) => index ?? -1),
      Effect.orElseSucceed(() => undefined),
    ));
  if (startIndex === undefined) {
    yield* Effect.logWarning("Could not read the Antigravity session log before the prompt.");
    return typedOnly;
  }
  const readFailure = (result: EffectAcpSchema.PromptResponse, warn: boolean) =>
    Effect.gen(function* () {
      // The same file as before the prompt, or one this prompt created, still unlinked.
      const after = yield* Effect.tryPromise({
        try: () => antigravityManagedPath(before.root, segments, "file"),
        catch: sessionLogError,
      }).pipe(Effect.orElseSucceed(() => undefined));
      const sameFile =
        after !== undefined &&
        (before.identity === undefined ||
          (after.info.dev === before.identity.dev && after.info.ino === before.identity.ino));
      const step = sameFile
        ? yield* readSteps(after.path, lastStepAfter(startIndex)).pipe(
            Effect.tapError(() =>
              warn
                ? Effect.logWarning("Could not read the Antigravity session log after the prompt.")
                : Effect.void,
            ),
            Effect.orElseSucceed(() => undefined),
          )
        : undefined;
      return turnFailure(result.stopReason, step, yield* DateTime.now, unrecognizedErrors);
    });
  /**
   * `notice` is the agent's last chat chunk when it was a harness notice. A quota notice means
   * the harness is writing an error step that may not be committed yet, so the log is read again
   * for a short while; if it still has none, the notice itself explains the turn.
   */
  return Effect.fn("AntigravityTurnOutcome.check")(function* (
    result: EffectAcpSchema.PromptResponse,
    notice?: AntigravityTurnNotice,
  ) {
    const fallback = noticeFailure(result, notice);
    const failure = yield* readFailure(result, true);
    if (failure && !(fallback && isUnrecognizedFailure(failure))) return failure;
    if (!fallback) return failure;
    for (let poll = 0; poll < NOTICE_SETTLE_POLLS; poll++) {
      yield* Effect.sleep(NOTICE_SETTLE_INTERVAL);
      const settled = yield* readFailure(result, false);
      if (settled && !isUnrecognizedFailure(settled)) return settled;
    }
    return fallback;
  });
});
