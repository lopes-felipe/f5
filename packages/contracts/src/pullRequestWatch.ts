import { Schema } from "effect";
import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";
import { PullRequestKey } from "./prHub";

export const ThreadPullRequestWatch = Schema.Struct({
  startedAt: IsoDateTime,
  headSha: Schema.NullOr(TrimmedNonEmptyString),
  failedChecks: Schema.Array(TrimmedNonEmptyString),
  passed: Schema.Boolean,
  passedChecks: Schema.Array(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(() => [])),
  remarksThrough: IsoDateTime,
  remarkIds: Schema.Array(TrimmedNonEmptyString),
  conflicting: Schema.Boolean,
  wakes: NonNegativeInt,
});
export type ThreadPullRequestWatch = typeof ThreadPullRequestWatch.Type;

export const PullRequestWatchEntry = Schema.Struct({
  threadId: ThreadId,
  key: PullRequestKey,
  watch: ThreadPullRequestWatch,
});
export type PullRequestWatchEntry = typeof PullRequestWatchEntry.Type;
export const PullRequestWatchInput = Schema.Struct({
  threadId: ThreadId,
  pr: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))),
});
export type PullRequestWatchInput = typeof PullRequestWatchInput.Type;
export const PullRequestWatchListInput = Schema.Struct({ threadId: ThreadId });
export const PullRequestWatchChanged = Schema.Struct({ threadId: ThreadId });
export type PullRequestWatchChanged = typeof PullRequestWatchChanged.Type;
export const PR_WATCH_WS_METHODS = {
  list: "pullRequestWatches.list",
  start: "pullRequestWatches.start",
  stop: "pullRequestWatches.stop",
} as const;
export const PR_WATCH_CHANGED_CHANNEL = "pullRequestWatches.changed";
