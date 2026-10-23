import { Schema } from "effect";

/** A filesystem path is opaque: never trim whitespace or accept NUL. */
export const FilesystemPath = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isPattern(/^[^\0]+$/),
);
export type FilesystemPath = typeof FilesystemPath.Type;

export const TrimmedString = Schema.Trim;
export const TrimmedNonEmptyString = TrimmedString.check(Schema.isNonEmpty());

/** Shared slug constraints; callers choose their own alphabet and length. */
export const makeSlugSchema = ({ maxChars, pattern }: { maxChars: number; pattern: RegExp }) =>
  TrimmedNonEmptyString.check(Schema.isMaxLength(maxChars), Schema.isPattern(pattern));

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const IsoDateTime = Schema.String;
export type IsoDateTime = typeof IsoDateTime.Type;

/**
 * Construct a branded identifier. Enforces non-empty trimmed strings
 */
export const makeEntityId = <Brand extends string>(brand: Brand) => {
  const schema = TrimmedNonEmptyString.pipe(Schema.brand(brand));
  return Object.assign(schema, {
    make: Schema.decodeUnknownSync(schema),
    makeUnsafe: (value: string): typeof schema.Type => value as typeof schema.Type,
  });
};

export const ThreadId = makeEntityId("ThreadId");
export type ThreadId = typeof ThreadId.Type;
export const ProjectId = makeEntityId("ProjectId");
export type ProjectId = typeof ProjectId.Type;
export const EnvironmentId = makeEntityId("EnvironmentId");
export type EnvironmentId = typeof EnvironmentId.Type;
export const CommandId = makeEntityId("CommandId");
export type CommandId = typeof CommandId.Type;
export const EventId = makeEntityId("EventId");
export type EventId = typeof EventId.Type;
export const MessageId = makeEntityId("MessageId");
export type MessageId = typeof MessageId.Type;
export const TurnId = makeEntityId("TurnId");
export type TurnId = typeof TurnId.Type;

export const ProviderItemId = makeEntityId("ProviderItemId");
export type ProviderItemId = typeof ProviderItemId.Type;
export const RuntimeSessionId = makeEntityId("RuntimeSessionId");
export type RuntimeSessionId = typeof RuntimeSessionId.Type;
export const RuntimeItemId = makeEntityId("RuntimeItemId");
export type RuntimeItemId = typeof RuntimeItemId.Type;
export const RuntimeRequestId = makeEntityId("RuntimeRequestId");
export type RuntimeRequestId = typeof RuntimeRequestId.Type;
export const RuntimeTaskId = makeEntityId("RuntimeTaskId");
export type RuntimeTaskId = typeof RuntimeTaskId.Type;
export const ApprovalRequestId = makeEntityId("ApprovalRequestId");
export type ApprovalRequestId = typeof ApprovalRequestId.Type;
export const CheckpointRef = makeEntityId("CheckpointRef");
export type CheckpointRef = typeof CheckpointRef.Type;

export const ScheduledTaskId = Schema.String.pipe(Schema.brand("ScheduledTaskId"));
export type ScheduledTaskId = typeof ScheduledTaskId.Type;
export const ScheduledTaskRunId = Schema.String.pipe(Schema.brand("ScheduledTaskRunId"));
export type ScheduledTaskRunId = typeof ScheduledTaskRunId.Type;
export const ScheduledOrigin = Schema.Struct({
  taskId: ScheduledTaskId,
  runId: ScheduledTaskRunId,
});
export type ScheduledOrigin = typeof ScheduledOrigin.Type;
