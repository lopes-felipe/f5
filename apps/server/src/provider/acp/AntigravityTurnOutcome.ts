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
  /** `resetAt` came from the agent's notice; absent when the failure's own evidence gave it. */
  resetSource?: "message";
}
/**
 * The agent text that ended the turn: everything it streamed since its last other output, so a
 * notice split across chunks still reads whole.
 */
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
// Newer harnesses write `STATUS (code 429): message` as a length-delimited protobuf field, then
// the JSON error body. Only the canonical google.rpc codes count, so a length byte that happens
// to be a capital letter cannot join the status.
const RPC_STATUS =
  "CANCELLED|UNKNOWN|INVALID_ARGUMENT|DEADLINE_EXCEEDED|NOT_FOUND|ALREADY_EXISTS|" +
  "PERMISSION_DENIED|RESOURCE_EXHAUSTED|FAILED_PRECONDITION|ABORTED|OUT_OF_RANGE|" +
  "UNIMPLEMENTED|INTERNAL|UNAVAILABLE|DATA_LOSS|UNAUTHENTICATED";
const API_ERROR_STATUS_FIRST = new RegExp(`(${RPC_STATUS}) \\(code (\\d{3})\\): `, "g");
// Without a usable field length, the message ends at a control byte, a newline or the JSON body.
const STATUS_FIRST_MESSAGE = /^[^\p{Cc}{]{1,512}/u;
// Both the Go map rendering (`reason:X`) and the JSON body (`"reason": "X"`).
const QUOTA_EXHAUSTED = /\breason"?\s*:\s*"?QUOTA_EXHAUSTED\b/;
const RESET_TIMESTAMP = /\bquotaResetTimeStamp"?\s*:\s*"?([^\s"\],}]+)/;
const RESET_DELAY =
  /\bquotaResetDelay"?\s*:\s*"?((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=["\s\],}])/;
// The agent's own notice for a quota error, the last line of the turn's text. A real notice is
// well under this; the cap bounds the regex on arbitrary model output.
const MAX_NOTICE_CHARS = 512;
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

interface ApiError {
  readonly httpStatus: string;
  readonly message: string;
  readonly status: string;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The message of a status-first field, bounded by the field's own length prefix: a one- or
 * two-byte varint just before the status. Field tags past the message can be printable bytes,
 * so stopping at a control byte alone could take them in.
 */
function statusFirstMessage(
  payload: Uint8Array,
  start: number,
  headerLength: number,
): string | undefined {
  const lengths: number[] = [];
  const last = payload[start - 1];
  if (last !== undefined && last < 0x80) {
    const first = payload[start - 2];
    if (first !== undefined && first >= 0x80) lengths.push((first & 0x7f) | (last << 7));
    lengths.push(last);
  }
  for (const length of lengths) {
    const end = start + length;
    if (length <= headerLength || end > payload.length) continue;
    try {
      const message = utf8.decode(payload.subarray(start + headerLength, end));
      if (!/\p{Cc}/u.test(message)) return message;
    } catch {
      // Not valid UTF-8, so not this length.
    }
  }
  return undefined;
}

/** `{ httpStatus, message, status }` from either rendering of a Google API error. */
function apiErrorFrom(text: string, payload: Uint8Array): ApiError | undefined {
  const goError = API_ERROR.exec(text);
  if (goError) return { httpStatus: goError[1]!, message: goError[2]!, status: goError[3]! };
  // Latin-1 maps each byte to one character, so match offsets are byte offsets.
  const bytes = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString(
    "latin1",
  );
  for (const match of bytes.matchAll(API_ERROR_STATUS_FIRST)) {
    const start = match.index;
    const message =
      statusFirstMessage(payload, start, match[0].length) ??
      STATUS_FIRST_MESSAGE.exec(
        new TextDecoder().decode(payload.subarray(start + match[0].length)),
      )?.[0];
    if (message?.trim()) return { httpStatus: match[2]!, message, status: match[1]! };
  }
  return undefined;
}

/** The turn's last line when the agent harness wrote it (`⚠ …`), not the model. */
function trailingNoticeLine(text: string): string | undefined {
  const marker = text.lastIndexOf("⚠");
  if (marker < 0) return undefined;
  const lineStart = text.lastIndexOf("\n", marker) + 1;
  if (text.slice(lineStart, marker).trim() !== "") return undefined;
  const line = text.slice(lineStart);
  return line.length <= MAX_NOTICE_CHARS ? line : undefined;
}

/**
 * The agent streams a quota error to the chat as `⚠ <message> Resets in 1h8m59s.` before it
 * ends the turn. Only that exact shape, as the last line of the turn's text, counts; a model
 * reply quoting a quota notice does not.
 */
export function parseAntigravityQuotaNotice(
  text: string,
  receivedAt: string,
): AntigravityTurnFailure | undefined {
  const line = trailingNoticeLine(text);
  const match = line === undefined ? null : QUOTA_NOTICE.exec(line);
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
    resetSource: "message",
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

/**
 * A recognised failure from the log wins, but a usage limit the log gave no reset for takes the
 * notice's, so the countdown and scheduled continue still have one.
 */
function withNoticeReset(
  failure: AntigravityTurnFailure,
  notice: AntigravityTurnFailure | undefined,
): AntigravityTurnFailure {
  return failure.class === "usage_limit" && !failure.resetAt && notice?.resetAt
    ? { ...failure, resetAt: notice.resetAt, resetSource: "message" }
    : failure;
}

function turnFailure(
  stopReason: EffectAcpSchema.StopReason,
  step: LastStep | undefined,
  now: DateTime.Utc,
  unrecognizedErrors = false,
): AntigravityTurnFailure | undefined {
  const payload = step?.type === ERROR_STEP_TYPE ? (step.payload ?? new Uint8Array()) : undefined;
  // The agent maps only the SDK's QUOTA_EXHAUSTED stop reason to `refusal`.
  if (payload === undefined && stopReason !== "refusal") return undefined;
  const bytes = payload ?? new Uint8Array();
  const text = new TextDecoder().decode(bytes);
  const apiError = apiErrorFrom(text, bytes);
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
      Effect.map((now) => {
        const fallback = noticeFailure(result, notice);
        const failure = turnFailure(result.stopReason, undefined, now);
        return failure ? withNoticeReset(failure, fallback) : fallback;
      }),
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
      return {
        failure: turnFailure(result.stopReason, step, yield* DateTime.now, unrecognizedErrors),
        errorStep: step?.type === ERROR_STEP_TYPE,
      };
    });
  /**
   * `notice` is the agent text that ended the turn. A quota notice there means the harness is
   * writing an error step that may not be committed yet, so the log is read again for a short
   * while; if it still has none, or only one it cannot read, the notice explains the turn.
   */
  return Effect.fn("AntigravityTurnOutcome.check")(function* (
    result: EffectAcpSchema.PromptResponse,
    notice?: AntigravityTurnNotice,
  ) {
    const fallback = noticeFailure(result, notice);
    for (let poll = 0; ; poll++) {
      const read = yield* readFailure(result, poll === 0);
      if (read.failure && !(fallback && isUnrecognizedFailure(read.failure)))
        return withNoticeReset(read.failure, fallback);
      if (!fallback) return read.failure;
      // A committed error step will not change; only a missing one is worth waiting for.
      if (read.errorStep || poll >= NOTICE_SETTLE_POLLS) return fallback;
      yield* Effect.sleep(NOTICE_SETTLE_INTERVAL);
    }
  });
});
